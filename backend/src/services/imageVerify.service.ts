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
import { buildDuplicateMessage } from '../utils/duplicateFormatter';

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

          const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            select: { organizationId: true },
          });
          const organizationId = branch?.organizationId;

          // Check if already verified across the organization
          const dup = await prisma.verificationRecord.findFirst({
            where: {
              provider: 'TELEBIRR',
              txnReference: ppOutcome.reference,
              status: 'VERIFIED',
              ...(organizationId ? { branch: { organizationId } } : {}),
            },
            include: {
              branch: {
                include: {
                  organization: {
                    include: {
                      bankSettlementAccounts: true,
                    },
                  },
                },
              },
            },
          });

          if (dup) {
            logger.warn(`[image-verify] Duplicate receipt detected for ${ppOutcome.reference} in organization ${organizationId}`);
            try {
              const today = new Date(new Date().setHours(0, 0, 0, 0));
              await prisma.dailyReport.upsert({
                where: { branchId_reportDate: { branchId, reportDate: today } },
                create: {
                  branchId,
                  reportDate: today,
                  totalRevenue: 0,
                  telebirrTotal: 0,
                  cbeTotal: 0,
                  cashTotal: 0,
                  totalTransactions: 0,
                  duplicatesBlocked: 1,
                },
                update: {
                  duplicatesBlocked: { increment: 1 },
                },
              });
            } catch (_) {}

            const matchedAccount = dup.branch?.organization?.bankSettlementAccounts?.find(
              (a: any) => a.accountNumber === dup.receivingAccount || a.bankName === 'TELEBIRR'
            );
            const ownerName = dup.branch?.organization?.name || matchedAccount?.accountHolderName || 'Beki Plc';
            const receiverParty =
              ppOutcome.receiverName ||
              (ppOutcome.raw as any)?.to_name ||
              (ppOutcome.raw as any)?.pdf_link_data?.to_name ||
              matchedAccount?.accountHolderName ||
              'SADA';

            const dupMessage = buildDuplicateMessage({
              ownerName,
              isoDate: dup.verifiedAt || dup.createdAt,
              amount: Number(dup.amount),
              receiverParty,
              transactionDate: ppOutcome.transactionDate || dup.verifiedAt || dup.createdAt,
              verifiedAt: dup.verifiedAt || dup.createdAt,
            });

            return {
              status: 409,
              result: {
                status: 'FLAGGED_DUPLICATE',
                provider: 'TELEBIRR',
                txnReference: ppOutcome.reference,
                amount: Number(dup.amount),
                settledAmount: Number(dup.amount),
                verifiedAt: dup.verifiedAt?.toISOString(),
                recordId: dup.id,
                ownerName,
                receiverParty,
                message: dupMessage,
              },
            };
          }

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
    } else if (ppOutcome.code === 'SUBSCRIPTION_EXPIRED') {
      return {
        status: 402,
        result: {
          status: 'FAILED_UPSTREAM',
          code: 'SUBSCRIPTION_EXPIRED',
          provider: 'TELEBIRR',
          txnReference: ppOutcome.reference || null,
          message: ppOutcome.message,
        },
      };
    } else if (ppOutcome.status === 'INVALID_RECEIPT') {
      return {
        status: 422,
        result: {
          status: 'INVALID_RECEIPT',
          code: ppOutcome.code,
          provider: 'TELEBIRR',
          txnReference: ppOutcome.reference || null,
          message: ppOutcome.message,
        },
      };
    } else if (ppOutcome.status === 'FAILED_UPSTREAM') {
      return {
        status: 502,
        result: {
          status: 'FAILED_UPSTREAM',
          code: ppOutcome.code,
          provider: 'TELEBIRR',
          txnReference: ppOutcome.reference || null,
          message: ppOutcome.message,
        },
      };
    }
  } catch (err: any) {
    logger.warn(`[image-verify] PayProof execution error: ${err.message}`);
  }
  return null;
}

// ── Helper: First promise that fulfills with an acceptable value ──────────────
function firstUsable<T>(ps: Promise<T | null>[], ok: (v: T) => boolean): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = ps.length;
    if (pending === 0) return resolve(null);
    const fail = () => {
      if (--pending === 0) resolve(null);
    };
    ps.forEach((p) =>
      p
        .then((v) => (v && ok(v) ? resolve(v) : fail()))
        .catch(fail)
    );
  });
}

// ── Circuit Breaker for direct Ethio Telecom portal fetching ──────────────────
let telebirrDirectNetFailures = 0;
let telebirrDirectPausedUntil = 0;

export function recordDirectTelebirrFailure(): void {
  if (++telebirrDirectNetFailures >= 3) {
    telebirrDirectPausedUntil = Date.now() + 5 * 60_000;
    telebirrDirectNetFailures = 0;
    logger.warn('[Telebirr] Direct portal unreachable 3x in a row — pausing direct fetch for 5 minutes');
  }
}

export function recordDirectTelebirrSuccess(): void {
  telebirrDirectNetFailures = 0;
}

export function directTelebirrAvailable(): boolean {
  if (process.env.TELEBIRR_DIRECT_ENABLED === 'false') return false;
  // If running on Render/cloud without an HTTP proxy, direct Ethio Telecom portal is firewalled (ECONNABORTED)
  const isCloudWithoutProxy =
    !process.env.TELEBIRR_PROXY_URL &&
    (Boolean(process.env.RENDER) || Boolean(process.env.RENDER_EXTERNAL_URL)) &&
    process.env.TELEBIRR_DIRECT_ENABLED !== 'true';
  if (isCloudWithoutProxy) return false;
  return Date.now() >= telebirrDirectPausedUntil;
}

export async function runImageVerification(
  opts: ImageVerificationOptions
): Promise<VerificationOutcome> {
  const { buffer, mimetype, branchId, cashierId, expectedAmount, provider: explicitProvider, onProgress } = opts;
  const t0 = Date.now();
  try { onProgress?.('reading'); } catch {}

  // Fast Path: When Telebirr is explicitly selected, route straight to PayProof!
  // No local QR decode, no Tesseract OCR, no CPU competition — matches Postman speed (~5-6s).
  if (explicitProvider === 'TELEBIRR' && process.env.PAYPROOF_SECRET_KEY) {
    const pp = await handlePayProofVerification(
      buffer, mimetype, branchId, cashierId, expectedAmount, onProgress
    );
    if (pp) {
      logger.info(`[perf] path=telebirr-direct-pp status=${pp.result?.status} total=${Date.now() - t0}ms`);
      return pp;
    }
    // PayProof gave no usable answer: fall through to existing flow
  }

  const hasPP = !!process.env.PAYPROOF_SECRET_KEY;

  // 1. PayProof fallback, memoized (one upload max), started immediately
  let ppPromise: Promise<VerificationOutcome | null> | null = null;
  const runPayProof = () =>
    (ppPromise ??= handlePayProofVerification(buffer, mimetype, branchId, cashierId, expectedAmount, onProgress)
      .catch(() => null));
  if (hasPP && (!explicitProvider || explicitProvider === 'TELEBIRR')) {
    runPayProof();
  }

  // 2. QR and OCR run in parallel, QR time-boxed to 1200ms
  const ocrPromise = parseFileBuffer(buffer, mimetype).catch(() => null);
  const fullQrPromise = decodeReceiptQr(buffer, mimetype).catch(() => null);
  const qrPromise = Promise.race([
    fullQrPromise,
    new Promise<null>((r) => setTimeout(() => r(null), 1200)),
  ]);

  // 3. First Telebirr reference wins
  const refFromQr = qrPromise.then((q) => {
    if (!q) return null;
    const n = dissectPayload(q);
    if (n.provider === 'TELEBIRR' && n.txnReference) return n.txnReference;
    const m = q.match(/receipt\/([A-Z0-9]{8,12})/i) || q.match(/\b(?=[A-Z0-9]*\d)([A-Z]{2,3}[A-Z0-9]{6,8})\b/i);
    return m ? m[1].toUpperCase() : null;
  });

  const refFromOcr = ocrPromise.then((o) => {
    if (!o) return null;
    if (o.provider === 'TELEBIRR' || /TELEBIRR|ETHIO TELECOM/i.test(o.rawText || '')) {
      if (o.txnReference) return o.txnReference;
      const m = (o.rawText || '').match(/\b(?=[A-Z0-9]*\d)([A-Z]{2,3}[A-Z0-9]{6,8})\b/i);
      return m ? m[1].toUpperCase() : null;
    }
    return null;
  });

  const ref = await firstUsable<string>([refFromQr, refFromOcr], (v) => !!v);

  // 4. Direct portal lookup raced against PayProof
  if (ref && directTelebirrAvailable()) {
    try { onProgress?.('checking_bank'); } catch {}
    const direct: Promise<VerificationOutcome | null> = Promise.race([
      processVerification({
        branchId,
        cashierId,
        provider: 'TELEBIRR',
        txnReference: ref,
        expectedAmount,
        rawText: 'DIRECT_LOOKUP', // no receiptImageUrl on purpose
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 3500)),
    ])
      .then((o: any) => {
        if (o && o.status !== 502 && o.result?.status !== 'FAILED_UPSTREAM') {
          recordDirectTelebirrSuccess();
          return { status: o.status, result: o.result };
        }
        recordDirectTelebirrFailure();
        return null;
      })
      .catch(() => {
        recordDirectTelebirrFailure();
        return null;
      });

    const winner = await firstUsable<VerificationOutcome>(
      [direct, ...(hasPP ? [runPayProof()] : [])],
      (v) => !!v
    );
    if (winner) {
      logger.info(`[perf] path=direct-or-pp ref=${ref} status=${winner.result?.status} total=${Date.now() - t0}ms`);
      return winner;
    }
  }

  // 5. No Telebirr ref found or direct+PayProof didn't resolve: CBE / OCR logic
  const qrValue = await fullQrPromise;
  const qrMs = Date.now() - t0;

  const qrIsReceiptUrl = !!qrValue && parseReceiptLink(qrValue) !== null;
  const qrIsCbeToken = qrIsReceiptUrl && !!(
    qrValue?.includes('mbreciept.cbe.com.et') || qrValue?.includes('mbreceipt.cbe.com.et')
  );

  const cbeTokenRouteDisabled = process.env.CBE_TOKEN_ROUTE === 'off';
  const isDoomedCbeToken = qrIsCbeToken && cbeTokenRouteDisabled;

  const qrNormalized = qrValue ? dissectPayload(qrValue) : null;
  const qrHasUsableRef = !!(qrNormalized && qrNormalized.txnReference && qrNormalized.provider !== 'UNKNOWN');

  // Step 5a: Fast-path for CBE QR receipts
  if (qrHasUsableRef && !isDoomedCbeToken && qrNormalized?.provider !== 'TELEBIRR') {
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

  // Step 5b: Wait for OCR
  const ocrResult = await ocrPromise;
  const ocrMs = Date.now() - t0;
  const ocrText = ocrResult?.rawText || '';

  // Determine provider
  let detectedProvider = explicitProvider || ocrResult?.provider || 'UNKNOWN';
  if (detectedProvider === 'UNKNOWN') {
    if (/CBE|COMMERCIAL BANK|\bFT[A-Z0-9]{8,14}\b/i.test(ocrText)) {
      detectedProvider = 'CBE';
    } else if (/TELEBIRR|ETHIO TELECOM/i.test(ocrText)) {
      detectedProvider = 'TELEBIRR';
    }
  }

  // If OCR indicates Telebirr, await PayProof fallback
  if (detectedProvider === 'TELEBIRR' && hasPP) {
    logger.info('[image-verify] OCR detected Telebirr — awaiting PayProof fallback...');
    const ppResult = await runPayProof();
    if (ppResult) {
      logger.info(`[perf] Telebirr verified via PayProof post-OCR in total=${Date.now() - t0}ms`);
      return ppResult;
    }
  }

  // Extract reference
  let txnReference: string | null = null;
  if (detectedProvider === 'CBE') {
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

  // Unreadable receipt handling
  if (!txnReference || detectedProvider === 'UNKNOWN') {
    // If PayProof was running in background, check its result
    if (hasPP && (!explicitProvider || explicitProvider === 'TELEBIRR')) {
      const ppResult = await runPayProof();
      if (ppResult) {
        return ppResult;
      }
    }

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

  // Final verification call (CBE, or Telebirr fallback)
  try { onProgress?.('checking_bank'); } catch {}

  // If Telebirr, prioritize PayProof and avoid direct scraping when unreachable from this network
  if (detectedProvider === 'TELEBIRR') {
    if (hasPP) {
      const ppResult = await runPayProof();
      if (ppResult) return ppResult;
    }
    if (!directTelebirrAvailable()) {
      return {
        status: 502,
        result: {
          status: 'FAILED_UPSTREAM',
          message: 'Telebirr verification service is currently unreachable. Please retry shortly.',
          provider: 'TELEBIRR',
          txnReference,
        },
      };
    }
  }

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

  // If Telebirr direct verification was unreachable and PayProof is available, failover to PayProof
  if (
    detectedProvider === 'TELEBIRR' &&
    (outcome.status === 502 || outcome.result?.status === 'FAILED_UPSTREAM') &&
    hasPP
  ) {
    logger.info('[image-verify] Telebirr direct verification unreachable — failing over to PayProof API...');
    const ppResult = await runPayProof();
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
