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

  // ── Step 3: Fast-path — If QR gives a usable reference (and not disabled), verify directly ──
  if (qrHasUsableRef && !isDoomedCbeToken) {
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

    // If QR verification completed (successful, amount mismatch, or invalid receipt), return early
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

    logger.warn(`[image-verify] Fast-path QR lookup returned status ${outcome.status} — awaiting background OCR as fallback`);
  }

  // ── Step 4: OCR path (no artificial deadline — wait for OCR) ─────────────────
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

  // ── Step 5: Unreadable receipt handling ──────────────────────────────────────
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

  // ── Step 6: Single verification call on OCR path ─────────────────────────────
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
}
