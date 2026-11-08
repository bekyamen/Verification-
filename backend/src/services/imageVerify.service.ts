/**
 * imageVerify.service.ts
 *
 * Shared image/PDF verification logic, reused by both:
 *  - HTTP controller (verification.controller.ts → verifyImagePayload)
 *  - Telegram bot (telegram/bot.ts → photo / document handlers)
 *
 * Runs OCR and QR decode in parallel, handles the CBE FAILED_UPSTREAM
 * legacy-fallback path, and delegates final verification to processVerification().
 */

import { parseFileBuffer } from './receiptParser.service';
import { decodeReceiptQr } from './qrDecoder';
import { dissectPayload } from './linkDissector';
import { parseReceiptLink } from './receiptLink';
import { processVerification } from './verification.service';
import logger from '../utils/logger';

export interface ImageVerificationOptions {
  buffer: Buffer;
  mimetype: string;
  branchId: string;
  cashierId: string;
  expectedAmount?: number;
  provider?: string;
}

export interface VerificationOutcome {
  status: number;
  result: any;
}

export async function runImageVerification(
  opts: ImageVerificationOptions
): Promise<VerificationOutcome> {
  const { buffer, mimetype, branchId, cashierId, expectedAmount, provider: explicitProvider } = opts;
  const t0 = Date.now();

  // ── Phase 1+2: Start OCR immediately — it runs in a Tesseract worker while
  // QR decode runs here on the main thread. Total wait = max(QR, OCR), not sum.
  let ocrDoneMs = -1;
  const ocrPromise = parseFileBuffer(buffer, mimetype)
    .then((r) => { ocrDoneMs = Date.now() - t0; return r; })
    .catch(() => { ocrDoneMs = Date.now() - t0; return null; });

  const qrValue = await decodeReceiptQr(buffer, mimetype);
  const qrMs = Date.now() - t0;

  // A QR hit is a URL that parseReceiptLink accepts (CBE / Telebirr only)
  const qrIsReceiptUrl = !!qrValue && parseReceiptLink(qrValue) !== null;
  const qrIsCbeToken = qrIsReceiptUrl && !!(
    qrValue?.includes('mbreciept.cbe.com.et') || qrValue?.includes('mbreceipt.cbe.com.et')
  );

  let extractedOcr: { provider: any; txnReference: string | null; amount?: number | null; rawText?: string } = {
    provider: 'UNKNOWN', txnReference: '', amount: undefined, rawText: ''
  };
  let ocrMs = 0;

  // Use ocrPromise as the parallel OCR for the CBE token fallback path
  const parallelOcrPromise = qrIsCbeToken ? ocrPromise : null;

  if (!qrIsReceiptUrl) {
    // ── Race OCR against a short deadline so CBE lookup can start ASAP ──────
    const OCR_RACE_DEADLINE_MS = 1_800;
    const ocrDeadline = new Promise<null>((r) => setTimeout(() => r(null), OCR_RACE_DEADLINE_MS));
    const ocrStart = Date.now();
    const raceResult = await Promise.race([ocrPromise, ocrDeadline]);
    ocrMs = Date.now() - ocrStart;

    if (raceResult !== null) {
      extractedOcr = raceResult ?? extractedOcr;
    } else {
      logger.info(`[timing] OCR still running after ${Date.now() - t0}ms deadline — proceeding with empty text`);
    }
  }

  let normalized: any = qrValue ? dissectPayload(qrValue) : null;
  const qrHit = !!(normalized && normalized.provider !== 'UNKNOWN' && normalized.txnReference);

  // If the OCR race deadline fired (OCR was still running), it may be done now
  if (!extractedOcr.rawText) {
    try {
      const lateOcr = await Promise.race([ocrPromise, Promise.resolve(null)]);
      if (lateOcr) {
        extractedOcr = lateOcr;
        logger.info(`[timing] Late OCR resolved before CBE finished (+${ocrDoneMs}ms): ${lateOcr.rawText?.length ?? 0} chars`);
      }
    } catch { /* non-fatal */ }
  }

  const combinedRawText = [qrValue, extractedOcr.rawText].filter(Boolean).join('\n');

  // Use QR-based normalized payload if it succeeded; otherwise fall back to OCR
  if (!normalized || normalized.provider === 'UNKNOWN' || !normalized.txnReference) {
    normalized = combinedRawText ? dissectPayload(combinedRawText) : { provider: 'UNKNOWN', txnReference: '' };
  }

  logger.info(
    `[timing] image-verify qrMs=${qrMs} ocrMs=${ocrMs} qrHit=${qrHit} qrIsReceiptUrl=${qrIsReceiptUrl} preLookupMs=${Date.now() - t0}`
  );

  const tVerify = Date.now();
  const autoProvider = normalized.provider === 'UNKNOWN' ? (extractedOcr.provider || 'UNKNOWN') : normalized.provider;
  const finalProvider = (autoProvider === 'UNKNOWN' && explicitProvider) ? explicitProvider : autoProvider;

  const result = await processVerification({
    branchId,
    cashierId,
    provider: finalProvider as any,
    txnReference: normalized.txnReference || extractedOcr.txnReference || '',
    amount: extractedOcr.amount || undefined,
    expectedAmount,
    receivingAccount: normalized.receivingAccount,
    senderAccount: normalized.senderAccount,
    payerPhone: normalized.payerPhone,
    payerName: normalized.payerName,
    printedDate: normalized.printedDate,
    rawText: combinedRawText,
    receiptImageUrl: 'UPLOADED_FILE_PROOF',
  });

  // Pick up any completed OCR result now (zero-wait)
  if (!extractedOcr.rawText) {
    try {
      const finalOcr = await Promise.race([ocrPromise, Promise.resolve(null)]);
      if (finalOcr) extractedOcr = finalOcr;
    } catch { /* non-fatal */ }
  }

  logger.info(`[timing] verifyMs=${Date.now() - tVerify} totalMs=${Date.now() - t0} status=${result.status}`);

  // ── FT legacy fallback for ISP-blocked CBE token endpoint ──────────────────
  if (
    result.status === 502 &&
    qrIsReceiptUrl &&
    normalized.provider === 'CBE'
  ) {
    let ocrText = '';

    if (parallelOcrPromise) {
      try {
        const ocrResult = await parallelOcrPromise;
        ocrText = ocrResult?.rawText ?? '';
        if (ocrText) {
          logger.info(`[image-verify] Background OCR ready (${ocrText.length} chars), finished at +${ocrDoneMs}ms`);
        }
      } catch { /* non-fatal */ }
    }

    if (!ocrText) {
      logger.info('[image-verify] CBE FAILED_UPSTREAM — awaiting background OCR or running last-resort');
      try {
        const lateOcr = (await ocrPromise) ?? (await parseFileBuffer(buffer, mimetype));
        ocrText = lateOcr?.rawText ?? '';
        logger.info(`[image-verify] OCR complete. Text length: ${ocrText.length}`);
      } catch (ocrErr: any) {
        logger.warn(`[image-verify] OCR failed: ${ocrErr.message}`);
      }
    }

    // Extract FT reference from OCR text
    const ftMatch =
      ocrText.match(/\b(FT[A-Z0-9]{8,14})\b/i) ??
      ocrText.match(/(FT[A-Z0-9]{10})/i);

    if (ftMatch) {
      const ftRef = ftMatch[1].toUpperCase();
      logger.info(`[image-verify] FT reference: ${ftRef} — retrying via legacy route`);

      const tRetry = Date.now();
      const ftResult = await processVerification({
        branchId,
        cashierId,
        provider: 'CBE',
        txnReference: ftRef,
        amount: extractedOcr.amount || undefined,
        expectedAmount,
        rawText: ocrText,
        receiptImageUrl: 'UPLOADED_FILE_PROOF',
      });
      logger.info(`[timing] retryMs=${Date.now() - tRetry} totalMs=${Date.now() - t0}`);

      return ftResult;
    }

    logger.warn('[image-verify] No FT reference found — returning original FAILED_UPSTREAM.');
  }

  return result;
}
