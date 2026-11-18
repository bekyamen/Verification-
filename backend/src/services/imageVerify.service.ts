/**
 * imageVerify.service.ts
 *
 * Shared image/PDF verification pipeline for both:
 *  - HTTP controller (verification.controller.ts → verifyImagePayload)
 *  - Telegram bot (telegram/bot.ts → photo / document handlers)
 *
 * Performance features:
 *  - Overlapped OCR and QR decode (OCR started immediately before QR)
 *  - Direct early return on usable QR references (skipping OCR wait)
 *  - Bypasses doomed CBE token endpoints when CBE_TOKEN_ROUTE !== 'on'
 *  - Single verification call on the OCR path
 *  - Exact 422 user-friendly error on unreadable receipts
 *  - Single [perf] timing log line
 */

import { parseFileBuffer } from './receiptParser.service';
import { decodeReceiptQr } from './qrDecoder';
import { dissectPayload } from './linkDissector';
import { parseReceiptLink } from './receiptLink';
import { processVerification } from './verification.service';
import { verifyTelebirrReceiptWithPayProof } from './payproof.service';
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
    let registeredAccounts: any[] = [];
    if (branchId) {
      try {
        const branch = await prisma.branch.findUnique({
          where: { id: branchId },
          include: {
            organization: {
              include: {
                bankSettlementAccounts: {
                  where: { isActive: true, bankName: 'TELEBIRR' },
                },
              },
            },
          },
        });
        registeredAccounts = branch?.organization?.bankSettlementAccounts ?? [];
      } catch (e) {
        // Continue if DB accounts query fails
      }
    }

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

  // ── Step 1: Start OCR immediately so it overlaps with QR decode ─────────────
  let ocrDoneMs = -1;
  const ocrPromise = parseFileBuffer(buffer, mimetype)
    .then((r) => {
      ocrDoneMs = Date.now() - t0;
      return r;
    })
    .catch(() => {
      ocrDoneMs = Date.now() - t0;
      return null;
    });

  // ── Step 2: Decode QR on the main thread ────────────────────────────────────
  const qrValue = await decodeReceiptQr(buffer, mimetype);
  const qrMs = Date.now() - t0;

  const qrIsReceiptUrl = !!qrValue && parseReceiptLink(qrValue) !== null;
  const qrIsCbeToken = qrIsReceiptUrl && !!(
    qrValue?.includes('mbreciept.cbe.com.et') || qrValue?.includes('mbreceipt.cbe.com.et')
  );

  const cbeTokenRouteDisabled = process.env.CBE_TOKEN_ROUTE === 'off';
  const isDoomedCbeToken = qrIsCbeToken && cbeTokenRouteDisabled;

  const qrNormalized = qrValue ? dissectPayload(qrValue) : null;
  const qrHasUsableRef = !!(qrNormalized && qrNormalized.txnReference && qrNormalized.provider !== 'UNKNOWN');
  const isTelebirrFromQr = !!(
    qrNormalized?.provider === 'TELEBIRR' ||
    (qrValue && /transactioninfo\.ethiotelecom\.et|telebirr/i.test(qrValue)) ||
    (qrValue && /DKC[A-Z0-9]{7}/i.test(qrValue))
  );

  // ── Step 3: Fast-path — Direct routing to PayProof for Telebirr ─────────────
  // If Telebirr is detected via QR or explicit provider, route directly to PayProof!
  // NEVER wait 15 seconds for direct Ethio Telecom scraping to time out.
  if ((isTelebirrFromQr || explicitProvider === 'TELEBIRR') && process.env.PAYPROOF_SECRET_KEY) {
    logger.info(`[image-verify] Fast-path Telebirr detected (qr=${isTelebirrFromQr}, explicit=${explicitProvider}) — routing directly to PayProof...`);
    const ppResult = await handlePayProofVerification(buffer, mimetype, branchId, cashierId, expectedAmount, onProgress);
    if (ppResult) {
      const totalMs = Date.now() - t0;
      logger.info(`[perf] Telebirr verified via PayProof fast-path in total=${totalMs}ms`);
      return ppResult;
    }
  }

  // ── Step 4: Fast-path for CBE QR receipts ──────────────────────────────────
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
  }

  // ── Step 5: Parallel PayProof background task if QR was not CBE ─────────────
  // While local Tesseract OCR runs, also run PayProof in background so whichever finishes first wins
  let payProofPromise: Promise<VerificationOutcome | null> | null = null;
  if (!qrIsCbeToken && !isDoomedCbeToken && process.env.PAYPROOF_SECRET_KEY) {
    payProofPromise = handlePayProofVerification(buffer, mimetype, branchId, cashierId, expectedAmount, onProgress).catch(() => null);
  }

  // ── Step 6: Wait for OCR ────────────────────────────────────────────────────
  const ocrResult = await ocrPromise;
  const ocrMs = ocrDoneMs > 0 ? ocrDoneMs : (Date.now() - t0);
  const ocrText = ocrResult?.rawText || '';

  // Determine provider
  let detectedProvider = explicitProvider || ocrResult?.provider || 'UNKNOWN';
  if (detectedProvider === 'UNKNOWN') {
    if (/CBE|COMMERCIAL BANK|FT[A-Z0-9]/i.test(ocrText)) {
      detectedProvider = 'CBE';
    } else if (/TELEBIRR|ETHIO TELECOM/i.test(ocrText)) {
      detectedProvider = 'TELEBIRR';
    }
  }

  // If OCR indicates Telebirr or text mentions Telebirr, await PayProof directly!
  if ((detectedProvider === 'TELEBIRR' || /TELEBIRR|ETHIO TELECOM/i.test(ocrText)) && payProofPromise) {
    logger.info('[image-verify] OCR detected Telebirr — awaiting PayProof directly (skipping slow direct scrape)...');
    const ppResult = await payProofPromise;
    if (ppResult) {
      const totalMs = Date.now() - t0;
      logger.info(`[perf] Telebirr verified via PayProof post-OCR in total=${totalMs}ms`);
      return ppResult;
    }
  }

  // Extract reference
  let txnReference: string | null = null;
  if (detectedProvider === 'CBE') {
    // For CBE, extract FT reference from OCR text
    const ftMatch = ocrText.match(/\b(FT[A-Z0-9]{8,14})\b/i) ?? ocrText.match(/(FT[A-Z0-9]{10})/i);
    if (ftMatch) {
      txnReference = ftMatch[1].toUpperCase();
    }
  } else {
    txnReference = ocrResult?.txnReference || null;
  }

  // Fallback: dissect combined text
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

  // Check if PayProof finished in the background while parsing text
  if (payProofPromise && (!detectedProvider || detectedProvider === 'TELEBIRR' || detectedProvider === 'UNKNOWN')) {
    const ppResult = await payProofPromise;
    if (ppResult && ppResult.status === 200 && ppResult.result?.status === 'VERIFIED') {
      const totalMs = Date.now() - t0;
      logger.info(`[perf] Telebirr verified via background PayProof in total=${totalMs}ms`);
      return ppResult;
    }
  }

  // ── Step 7: Unreadable receipt handling ──────────────────────────────────────
  if (!txnReference || detectedProvider === 'UNKNOWN') {
    const totalMs = Date.now() - t0;
    logger.warn(
      `[perf] qr=${qrMs}ms ocr=${ocrMs}ms db=0ms bank=0ms total=${totalMs}ms status=INVALID_RECEIPT ref=none`
    );
    return {
      status: 422,
      result: {
        status: 'INVALID_RECEIPT',
        message: 'Hold steady, use good light, and fill the frame.',
        provider: detectedProvider,
        txnReference: null,
      },
    };
  }

  // ── Step 8: Single verification call on OCR path (CBE and others) ────────────
  try { onProgress?.('checking_bank'); } catch {}
  const combinedRawText = [qrValue, ocrText].filter(Boolean).join('\n');
  const normalized = dissectPayload(combinedRawText);

  // If Telebirr reached here, use PayProof if configured
  if (detectedProvider === 'TELEBIRR' && process.env.PAYPROOF_SECRET_KEY) {
    const ppResult = await handlePayProofVerification(buffer, mimetype, branchId, cashierId, expectedAmount, onProgress);
    if (ppResult) return ppResult;
  }

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

  // If Telebirr failed due to upstream network block (e.g. Safaricom/Render IP block)
  // and PayProof is configured, failover to PayProof
  if (
    detectedProvider === 'TELEBIRR' &&
    (outcome.status === 502 || outcome.result?.status === 'FAILED_UPSTREAM') &&
    process.env.PAYPROOF_SECRET_KEY
  ) {
    logger.info('[image-verify] Telebirr direct verification unreachable — failing over to PayProof API...');
    const ppResult = await handlePayProofVerification(buffer, mimetype, branchId, cashierId, expectedAmount, onProgress);
    if (ppResult) return ppResult;
  }

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
}
