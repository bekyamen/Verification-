/**
 * imageVerify.service.ts
 *
 * Shared image/PDF verification pipeline for both:
 *  - HTTP controller (verification.controller.ts → verifyImagePayload)
 *  - Telegram bot (telegram/bot.ts → photo / document handlers)
 *
 * Performance features:
 *  - Fast QR decode runs FIRST with zero Tesseract CPU starvation (~30-100ms)
 *  - Direct fast-path to PayProof for Telebirr (explicit or QR-detected) — zero OCR, zero direct scrape timeout
 *  - Direct fast-path to CBE API for CBE QR receipts — zero OCR
 *  - True first-non-null race between PayProof and local OCR when no QR is found (never blocks PayProof behind OCR)
 *  - Uses accountsCache (0ms) for registered account lookup
 *  - Single [perf] timing log line
 */

import { parseFileBuffer } from './receiptParser.service';
import { decodeReceiptQr } from './qrDecoder';
import { dissectPayload } from './linkDissector';
import { parseReceiptLink } from './receiptLink';
import { processVerification } from './verification.service';
import { verifyTelebirrReceiptWithPayProof } from './payproof.service';
import { isCbeTokenCircuitOpen } from './verifyCBE';
import { accountsCache } from '../utils/verifyCache';
import prisma from '../utils/prisma';
import { Prisma } from '@prisma/client';
import logger from '../utils/logger';

export interface ImageVerificationOptions {
  buffer: Buffer;
  mimetype: string;
  branchId: string;
  cashierId: string;
  expectedAmount?: number;
  provider?: string;
  onProgress?: (stage: 'reading' | 'checking_bank') => void;
}

export interface VerificationOutcome {
  status: number;
  result: any;
}

/**
 * Resolve active Telebirr settlement accounts using the shared accountsCache (0ms on hit).
 */
async function getCachedTelebirrAccounts(branchId: string): Promise<Array<{ accountNumber: string; accountHolderName: string }>> {
  if (!branchId) return [];
  const cacheKey = `branch:${branchId}`;
  let allAccounts = accountsCache.get(cacheKey);
  if (allAccounts === null) {
    try {
      const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        include: {
          organization: {
            include: {
              bankSettlementAccounts: { where: { isActive: true } },
            },
          },
        },
      });
      allAccounts = branch?.organization?.bankSettlementAccounts ?? [];
      accountsCache.set(cacheKey, allAccounts);
    } catch {
      return [];
    }
  }
  return (allAccounts || []).filter((a: any) => a.bankName === 'TELEBIRR');
}

/**
 * Handle verification of Telebirr receipt via PayProof with full DB persistence.
 */
async function handlePayProofVerification(
  buffer: Buffer,
  mimetype: string,
  branchId: string,
  cashierId: string,
  expectedAmount?: number,
  onProgress?: (stage: 'reading' | 'checking_bank') => void
): Promise<VerificationOutcome | null> {
  if (!process.env.PAYPROOF_SECRET_KEY) return null;
  try {
    const registeredAccounts = await getCachedTelebirrAccounts(branchId);

    const ppOutcome = await verifyTelebirrReceiptWithPayProof(buffer, 'receipt.jpg', mimetype, {
      expectedAmount,
      registeredAccounts,
      onProgress: onProgress ? (stage: string) => onProgress(stage as any) : undefined,
    });

    if (ppOutcome.status === 'VERIFIED') {
      let savedRecord: any = null;
      if (branchId && ppOutcome.reference) {
        try {
          const now = new Date();
          const verifiedTime = ppOutcome.transactionDate && !isNaN(ppOutcome.transactionDate.getTime())
            ? ppOutcome.transactionDate
            : now;

          savedRecord = await prisma.$transaction(async (tx) => {
            const prior = await tx.verificationRecord.findUnique({
              where: {
                branchId_provider_txnReference: {
                  branchId,
                  provider: 'TELEBIRR',
                  txnReference: ppOutcome.reference,
                },
              },
            });

            const isAlreadyVerified = prior?.status === 'VERIFIED';

            const record = await tx.verificationRecord.upsert({
              where: {
                branchId_provider_txnReference: {
                  branchId,
                  provider: 'TELEBIRR',
                  txnReference: ppOutcome.reference,
                },
              },
              update: {
                amount: new Prisma.Decimal(ppOutcome.settledAmount),
                expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
                receivingAccount: ppOutcome.receiverAccount || null,
                payerPhone: ppOutcome.senderPhone || null,
                payerName: ppOutcome.senderName || null,
                receiptImageUrl: 'PAYPROOF_VERIFIED_RECEIPT',
                status: 'VERIFIED',
                verifiedAt: verifiedTime,
              },
              create: {
                branchId,
                cashierId,
                provider: 'TELEBIRR',
                txnReference: ppOutcome.reference,
                amount: new Prisma.Decimal(ppOutcome.settledAmount),
                expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
                receivingAccount: ppOutcome.receiverAccount || null,
                payerPhone: ppOutcome.senderPhone || null,
                payerName: ppOutcome.senderName || null,
                receiptImageUrl: 'PAYPROOF_VERIFIED_RECEIPT',
                status: 'VERIFIED',
                verifiedAt: verifiedTime,
              },
            });

            if (!isAlreadyVerified) {
              const today = new Date(new Date().setHours(0, 0, 0, 0));
              await tx.dailyReport.upsert({
                where: { branchId_reportDate: { branchId, reportDate: today } },
                create: {
                  branchId,
                  reportDate: today,
                  totalRevenue: ppOutcome.settledAmount,
                  telebirrTotal: ppOutcome.settledAmount,
                  cbeTotal: 0,
                  cashTotal: 0,
                  totalTransactions: 1,
                  duplicatesBlocked: 0,
                },
                update: {
                  totalRevenue: { increment: ppOutcome.settledAmount },
                  telebirrTotal: { increment: ppOutcome.settledAmount },
                  totalTransactions: { increment: 1 },
                },
              });
            }

            return record;
          });
        } catch (dbErr: any) {
          logger.warn(`[image-verify] Could not persist PayProof verification to DB: ${dbErr.message}`);
        }
      }

      return {
        status: 200,
        result: {
          status: 'VERIFIED',
          provider: 'TELEBIRR',
          txnReference: ppOutcome.reference,
          amount: ppOutcome.settledAmount,
          settledAmount: ppOutcome.settledAmount,
          totalDebitedAmount: ppOutcome.totalDebitedAmount,
          serviceFee: ppOutcome.serviceFee,
          payerName: ppOutcome.senderName,
          payerPhone: ppOutcome.senderPhone,
          receivingAccount: ppOutcome.receiverAccount,
          receiverName: ppOutcome.receiverName || (ppOutcome.raw as any)?.to_name || (ppOutcome.raw as any)?.pdf_link_data?.to_name,
          transactionDate: ppOutcome.transactionDate ? ppOutcome.transactionDate.toISOString() : undefined,
          message: ppOutcome.message,
          verifiedAt: ppOutcome.transactionDate ? ppOutcome.transactionDate.toISOString() : new Date().toISOString(),
          recordId: savedRecord?.id,
          raw: ppOutcome.raw,
        },
      };
    } else if (ppOutcome.status === 'AMOUNT_MISMATCH') {
      return {
        status: 400,
        result: {
          status: 'AMOUNT_MISMATCH',
          provider: 'TELEBIRR',
          txnReference: ppOutcome.reference,
          amount: ppOutcome.settledAmount,
          expectedAmount,
          message: ppOutcome.message,
        },
      };
    } else if (ppOutcome.status === 'WRONG_RECEIVER') {
      return {
        status: 422,
        result: {
          status: 'INVALID_RECEIPT',
          provider: 'TELEBIRR',
          txnReference: ppOutcome.reference,
          message: ppOutcome.message,
        },
      };
    } else if (ppOutcome.status === 'INVALID_RECEIPT' && ppOutcome.code !== 'UNSUPPORTED_BANK') {
      // Only return decisive failure if PayProof explicitly identified it as a Telebirr receipt
      const rawBank = String(
        (ppOutcome.raw as any)?.bank_name ||
        (ppOutcome.raw as any)?.ai_extracted_data?.bank_name ||
        ''
      ).toUpperCase();
      if (rawBank.includes('TELEBIRR') || rawBank.includes('ETHIO')) {
        return {
          status: 422,
          result: {
            status: 'INVALID_RECEIPT',
            provider: 'TELEBIRR',
            txnReference: ppOutcome.reference || null,
            message: ppOutcome.message,
          },
        };
      }
    }
  } catch (err: any) {
    logger.warn(`[image-verify] PayProof execution error: ${err.message}`);
  }
  return null;
}

export async function runImageVerification(
  opts: ImageVerificationOptions
): Promise<VerificationOutcome> {
  const { buffer, mimetype, branchId, cashierId, expectedAmount, provider: explicitProvider, onProgress } = opts;
  const t0 = Date.now();
  try { onProgress?.('reading'); } catch {}

  const hasPayProof = Boolean(process.env.PAYPROOF_SECRET_KEY);

  // ── Fast-path 0: Explicit TELEBIRR skips QR and OCR completely (exact Mini App path!) ──
  if (explicitProvider === 'TELEBIRR' && hasPayProof) {
    logger.info('[image-verify] Explicit TELEBIRR — routing directly to PayProof (0ms overhead)...');
    const ppResult = await handlePayProofVerification(buffer, mimetype, branchId, cashierId, expectedAmount, onProgress);
    if (ppResult) {
      logger.info(`[perf] explicit=TELEBIRR qr=0ms ocr=0ms total=${Date.now() - t0}ms status=${ppResult.result?.status}`);
      return ppResult;
    }
  }

  // ── Step 1: Fast QR decode FIRST (no background Tesseract starving the CPU!) ──
  const qrValue = await decodeReceiptQr(buffer, mimetype);
  const qrMs = Date.now() - t0;

  const qrIsReceiptUrl = !!qrValue && parseReceiptLink(qrValue) !== null;
  const qrIsCbeToken = qrIsReceiptUrl && !!(
    qrValue?.includes('mbreciept.cbe.com.et') || qrValue?.includes('mbreceipt.cbe.com.et')
  );

  const cbeTokenRouteDisabled = process.env.CBE_TOKEN_ROUTE === 'off';
  const isDoomedCbeToken = qrIsCbeToken && (cbeTokenRouteDisabled || isCbeTokenCircuitOpen());

  const qrNormalized = qrValue ? dissectPayload(qrValue) : null;
  const qrHasUsableRef = !!(qrNormalized && qrNormalized.txnReference && qrNormalized.provider !== 'UNKNOWN');
  const isTelebirrFromQr = !!(
    qrNormalized?.provider === 'TELEBIRR' ||
    (qrValue && /transactioninfo\.ethiotelecom\.et|telebirr/i.test(qrValue)) ||
    (qrValue && /DKC[A-Z0-9]{7}/i.test(qrValue))
  );

  // ── Step 2: Fast-path — Telebirr QR → PayProof directly (zero OCR, zero direct scrape) ──
  if (isTelebirrFromQr && hasPayProof) {
    logger.info(`[image-verify] Fast-path QR Telebirr (${qrMs}ms) — routing directly to PayProof...`);
    const ppResult = await handlePayProofVerification(buffer, mimetype, branchId, cashierId, expectedAmount, onProgress);
    if (ppResult) {
      logger.info(`[perf] qr=${qrMs}ms ocr=0ms payproof total=${Date.now() - t0}ms status=${ppResult.result?.status}`);
      return ppResult;
    }
  }

  // ── Step 3: Fast-path — CBE QR → CBE API directly (zero OCR!) ────────────────
  if (qrHasUsableRef && !isDoomedCbeToken && !isTelebirrFromQr) {
    try { onProgress?.('checking_bank'); } catch {}
    const qrProvider = (qrNormalized!.provider === 'UNKNOWN' ? explicitProvider : qrNormalized!.provider) || 'UNKNOWN';
    const outcome = await processVerification({
      branchId,
      cashierId,
      provider: qrProvider as any,
      txnReference: qrNormalized!.txnReference,
      amount: expectedAmount || qrNormalized!.amount || undefined,
      expectedAmount,
      receivingAccount: qrNormalized!.receivingAccount,
      senderAccount: qrNormalized!.senderAccount,
      payerPhone: qrNormalized!.payerPhone,
      payerName: qrNormalized!.payerName,
      printedDate: qrNormalized!.printedDate,
      rawText: qrValue || '',
      receiptImageUrl: 'UPLOADED_FILE_PROOF',
    });

    if (outcome.status === 200 || outcome.status === 400 || (outcome.status === 422 && outcome.result?.status !== 'FAILED_UPSTREAM')) {
      const totalMs = Date.now() - t0;
      const dbMs = outcome.timings?.dbMs ?? 0;
      const bankMs = outcome.timings?.bankMs ?? 0;
      const statusStr = outcome.result?.status || outcome.status;

      logger.info(
        `[perf] qr=${qrMs}ms ocr=0ms db=${dbMs}ms bank=${bankMs}ms total=${totalMs}ms status=${statusStr} ref=${qrNormalized!.txnReference}`
      );

      return {
        status: outcome.status,
        result: outcome.result,
      };
    }

    logger.warn(`[image-verify] Fast-path QR lookup returned status ${outcome.status} — falling back to OCR`);
  }

  // ── Step 4: No usable QR (e.g. Telebirr screenshot or CBE fallback) ──────────
  // TRUE FIRST-NON-NULL RACE between PayProof (Telebirr cloud AI) and local OCR (CBE)!
  // Whichever returns a decisive result FIRST wins immediately without waiting for the other!
  const shouldLaunchPayProof = hasPayProof && !qrIsCbeToken && !isDoomedCbeToken && explicitProvider !== 'CBE';

  const payProofPromise: Promise<VerificationOutcome | null> = shouldLaunchPayProof
    ? handlePayProofVerification(buffer, mimetype, branchId, cashierId, expectedAmount, onProgress).catch(() => null)
    : Promise.resolve(null);

  // Give PayProof a tiny head-start (120ms) so its JPEG compression & HTTP upload packet
  // hits the wire before CPU-heavy Tesseract WASM runs!
  let ocrDoneMs = -1;
  const ocrVerifyPipeline = (async (): Promise<VerificationOutcome | null> => {
    if (shouldLaunchPayProof) {
      await new Promise((r) => setTimeout(r, 120));
    }

    const ocrResult = await parseFileBuffer(buffer, mimetype)
      .then((r) => { ocrDoneMs = Date.now() - t0; return r; })
      .catch(() => { ocrDoneMs = Date.now() - t0; return null; });

    const ocrMs = ocrDoneMs > 0 ? ocrDoneMs : (Date.now() - t0);
    const ocrText = ocrResult?.rawText || '';

    let detectedProvider = explicitProvider || ocrResult?.provider || 'UNKNOWN';
    if (detectedProvider === 'UNKNOWN') {
      if (/CBE|COMMERCIAL BANK|FT[A-Z0-9]/i.test(ocrText)) {
        detectedProvider = 'CBE';
      } else if (/TELEBIRR|ETHIO TELECOM/i.test(ocrText)) {
        detectedProvider = 'TELEBIRR';
      }
    }

    // If OCR indicates Telebirr and PayProof is already running, let PayProof win the race!
    if ((detectedProvider === 'TELEBIRR' || /TELEBIRR|ETHIO TELECOM/i.test(ocrText)) && shouldLaunchPayProof) {
      return null;
    }

    let txnReference: string | null = null;
    if (detectedProvider === 'CBE') {
      const ftMatch = ocrText.match(/\b(FT[A-Z0-9]{8,14})\b/i) ?? ocrText.match(/(FT[A-Z0-9]{10})/i);
      if (ftMatch) {
        txnReference = ftMatch[1].toUpperCase();
      }
    } else {
      txnReference = ocrResult?.txnReference || null;
    }

    if (!txnReference) {
      const combined = [qrValue, ocrText].filter(Boolean).join('\n');
      const norm = dissectPayload(combined);
      if (norm.txnReference) {
        txnReference = norm.txnReference;
        if (detectedProvider === 'UNKNOWN' && norm.provider && norm.provider !== 'UNKNOWN') {
          detectedProvider = norm.provider;
        }
      }
    }

    if (!txnReference || detectedProvider === 'UNKNOWN') {
      return null;
    }

    // Never run slow direct Telebirr scrape when PayProof is already handling it
    if (detectedProvider === 'TELEBIRR' && shouldLaunchPayProof) {
      return null;
    }

    try { onProgress?.('checking_bank'); } catch {}
    const combinedRawText = [qrValue, ocrText].filter(Boolean).join('\n');
    const normalized = dissectPayload(combinedRawText);

    const outcome = await processVerification({
      branchId,
      cashierId,
      provider: detectedProvider as any,
      txnReference,
      amount: ocrResult?.amount || normalized.amount || undefined,
      expectedAmount,
      receivingAccount: normalized.receivingAccount,
      senderAccount: normalized.senderAccount,
      payerPhone: normalized.payerPhone,
      payerName: normalized.payerName,
      printedDate: normalized.printedDate,
      rawText: combinedRawText,
      receiptImageUrl: 'UPLOADED_FILE_PROOF',
    });

    const totalMs = Date.now() - t0;
    const dbMs = outcome.timings?.dbMs ?? 0;
    const bankMs = outcome.timings?.bankMs ?? 0;
    const statusStr = outcome.result?.status || outcome.status;
    logger.info(
      `[perf] qr=${qrMs}ms ocr=${ocrMs}ms db=${dbMs}ms bank=${bankMs}ms total=${totalMs}ms status=${statusStr} ref=${txnReference}`
    );

    return {
      status: outcome.status,
      result: outcome.result,
    };
  })();

  // True first-non-null race: returns the instant EITHER PayProof OR OCR+CBE succeeds!
  const winner = await new Promise<VerificationOutcome | null>((resolve) => {
    let settled = false;
    let remaining = 2;

    const onResult = (label: string, val: VerificationOutcome | null) => {
      if (settled) return;
      if (val !== null) {
        settled = true;
        logger.info(`[image-verify] Race winner=${label} in total=${Date.now() - t0}ms status=${val.result?.status}`);
        resolve(val);
        return;
      }
      remaining -= 1;
      if (remaining === 0) {
        settled = true;
        resolve(null);
      }
    };

    payProofPromise.then((v) => onResult('payproof', v), () => onResult('payproof', null));
    ocrVerifyPipeline.then((v) => onResult('ocr', v), () => onResult('ocr', null));
  });

  if (winner) {
    return winner;
  }

  const totalMs = Date.now() - t0;
  logger.warn(
    `[perf] qr=${qrMs}ms ocr=${ocrDoneMs}ms db=0ms bank=0ms total=${totalMs}ms status=INVALID_RECEIPT ref=none`
  );
  return {
    status: 422,
    result: {
      status: 'INVALID_RECEIPT',
      message: 'Hold steady, use good light, and fill the frame.',
      provider: explicitProvider || 'UNKNOWN',
      txnReference: null,
    },
  };
}
