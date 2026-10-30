import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { verifyTextSchema, verifyUrlSchema, verifyManualSchema } from '../validators/verification.validator';
import { parseRawText, parseFileBuffer } from '../services/receiptParser.service';
import { decodeReceiptQr } from '../services/qrDecoder';
import { processVerification } from '../services/verification.service';
import { dissectPayload } from '../services/linkDissector';
import { parseReceiptLink } from '../services/receiptLink';
import { verifyCBE } from '../services/verifyCBE';
import logger from '../utils/logger';






export const verifyTextPayload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsedParams = verifyTextSchema.parse(req.body);
    const cashierId = req.cashierId || req.user?.userId;
    const branchId = req.user?.branchId;

    if (!cashierId || !branchId) {
      res.status(401).json({ error: 'Missing cashier or branch context.' });
      return;
    }
   
    const { amount, ...rest } = parseRawText(parsedParams.rawText); 
    // Usually parseRawText gives very generic properties. Let's merge it heavily through dissectPayload instead for unified logic.
    // However parseRawText handles some older formats. We'll use dissectPayload as primary.
    const normalized = dissectPayload(parsedParams.rawText);

    const result = await processVerification({
      branchId,
      cashierId,
      ...normalized, // unified schema properties
      amount: amount || normalized.amount,
      expectedAmount: parsedParams.expectedAmount,
      rawText: parsedParams.rawText
    });

    res.status(result.status).json(result.result);
  } catch (error: any) {
    res.status(400).json({ error: 'Validation or parsing failed', details: error.errors || error.message });
  }
};

export const verifyImagePayload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const cashierId = req.cashierId || req.user?.userId;
    const branchId = req.user?.branchId;

    if (!cashierId || !branchId) {
      res.status(401).json({ error: 'Missing cashier or branch context.' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No image or PDF file uploaded.' });
      return;
    }

    let expectedAmount: number | undefined = undefined;
    if (req.body.expectedAmount) {
      expectedAmount = parseFloat(req.body.expectedAmount);
    }

    const t0 = Date.now();

    // ── Phase 1+2: Start OCR immediately — it runs in a Tesseract worker while ──
    // QR decode runs here on the main thread. Total wait = max(QR, OCR), not sum.
    let ocrDoneMs = -1;
    const ocrPromise = parseFileBuffer(req.file.buffer, req.file.mimetype)
      .then((r) => { ocrDoneMs = Date.now() - t0; return r; })
      .catch(() => { ocrDoneMs = Date.now() - t0; return null; });

    const qrValue = await decodeReceiptQr(req.file.buffer, req.file.mimetype);
    const qrMs = Date.now() - t0;

    // A QR hit is a URL that parseReceiptLink accepts (CBE / Telebirr only)
    const qrIsReceiptUrl = !!qrValue && parseReceiptLink(qrValue) !== null;
    const qrIsCbeToken   = qrIsReceiptUrl && !!(qrValue?.includes('mbreciept.cbe.com.et') || qrValue?.includes('mbreceipt.cbe.com.et'));

    let extractedOcr: { provider: any; txnReference: string | null; amount?: number | null; rawText?: string } = {
      provider: 'UNKNOWN', txnReference: '', amount: undefined, rawText: ''
    };
    let ocrMs = 0;

    // Use ocrPromise as the parallel OCR for the CBE token fallback path
    const parallelOcrPromise = qrIsCbeToken ? ocrPromise : null;

    if (!qrIsReceiptUrl) {
      // ── Await OCR — usually already finished or close to finishing ────────────
      const ocrStart = Date.now();
      try {
        extractedOcr = (await ocrPromise) ?? extractedOcr;   // time spent WAITING after QR
      } catch {
        // OCR failure is non-fatal — carry on with whatever QR found
      }
      ocrMs = Date.now() - ocrStart; // near-zero when OCR finished before QR
    }

    let normalized: any = qrValue ? dissectPayload(qrValue) : null;
    const qrHit = !!(normalized && normalized.provider !== 'UNKNOWN' && normalized.txnReference);

    // NOTE: parallelOcrPromise is intentionally NOT awaited here.
    // processVerification starts immediately; OCR runs in the background.
    // For the CBE token path the circuit fast-fails in ~0 ms, so OCR will
    // typically be ready (or close to ready) by the time the fallback block runs.
    const combinedRawText = [qrValue, extractedOcr.rawText].filter(Boolean).join('\n');

    // Use QR-based normalized payload if it succeeded; otherwise fall back to OCR
    if (!normalized || normalized.provider === 'UNKNOWN' || !normalized.txnReference) {
      normalized = combinedRawText ? dissectPayload(combinedRawText) : { provider: 'UNKNOWN', txnReference: '' };
    }
    logger.info(
      `[timing] image-verify qrMs=${qrMs} ocrMs=${ocrMs} qrHit=${qrHit} qrIsReceiptUrl=${qrIsReceiptUrl} preLookupMs=${Date.now() - t0}`
    );

    // Keep a reference to the image buffer — we may need it for a late OCR retry
    const imageBuffer = req.file.buffer;
    const imageMime   = req.file.mimetype;

    const tVerify = Date.now();
    const result = await processVerification({
      branchId,
      cashierId,
      provider: (normalized.provider === 'UNKNOWN' ? (extractedOcr.provider || 'UNKNOWN') : normalized.provider) as any,
      txnReference: normalized.txnReference || extractedOcr.txnReference || '',
      amount: extractedOcr.amount || undefined,
      expectedAmount,
      receivingAccount: normalized.receivingAccount,
      senderAccount: normalized.senderAccount,
      payerPhone: normalized.payerPhone,
      payerName: normalized.payerName,
      printedDate: normalized.printedDate,
      rawText: combinedRawText,
      receiptImageUrl: 'UPLOADED_FILE_PROOF'
    });
    logger.info(`[timing] verifyMs=${Date.now() - tVerify} totalMs=${Date.now() - t0} status=${result.status}`);

    // ── FT legacy fallback for ISP-blocked CBE token endpoint ──────────────────
    // If processVerification returned 502 AND the QR was a CBE v2 URL:
    //   1. Await the parallel OCR (it has been running since right after QR finished)
    //   2. Extract the FT reference printed on the receipt
    //   3. Retry via the legacy apps.cbe.com.et route which is not ISP-blocked
    if (
      result.status === 502 &&
      qrIsReceiptUrl &&   // OCR was not the primary path (we ran it in parallel instead)
      normalized.provider === 'CBE'
    ) {
      let ocrText = '';

      if (parallelOcrPromise) {
        // parallelOcrPromise has been running in background since QR completed.
        // With circuit threshold=1, processVerification fails in <100 ms on ISP blocks,
        // so we wait here for the remaining OCR duration.
        try {
          const ocrResult = await parallelOcrPromise;
          ocrText = ocrResult?.rawText ?? '';
          if (ocrText) {
          logger.info(`[image-verify] Background OCR ready (${ocrText.length} chars), finished at +${ocrDoneMs}ms`);
          }
        } catch { /* non-fatal */ }
      }

      if (!ocrText) {
        // ocrPromise was running since before QR decode — grab it first, then fallback
        logger.info('[image-verify] CBE FAILED_UPSTREAM — awaiting background OCR or running last-resort');
        try {
          const lateOcr = (await ocrPromise) ?? (await parseFileBuffer(imageBuffer, imageMime));
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

        res.status(ftResult.status).json(ftResult.result);
        return;
      }

      logger.warn('[image-verify] No FT reference found — returning original FAILED_UPSTREAM.');
    }

    res.status(result.status).json(result.result);

  } catch (error: any) {
    res.status(500).json({ error: 'File processing or verification failed', details: error.message });
  }
};



export const verifyUrlPayload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsedParams = verifyUrlSchema.parse(req.body);
    const cashierId = req.cashierId || req.user?.userId;
    const branchId = req.user?.branchId;

    if (!cashierId || !branchId) {
      res.status(401).json({ error: 'Missing context.' });
      return;
    }

    const payloadContext = dissectPayload(parsedParams.receiptUrl);

    // verifyUrlSchema already guarantees the URL is CBE or Telebirr recognised;
    // if dissect still returns UNKNOWN (shouldn't happen), reject cleanly.
    if (payloadContext.provider === 'UNKNOWN' || !payloadContext.txnReference) {
      res.status(422).json({
        status: 'INVALID_RECEIPT',
        message: 'Could not extract a transaction reference from the provided URL.',
      });
      return;
    }

    const result = await processVerification({
      branchId,
      cashierId,
      ...payloadContext,
      expectedAmount: parsedParams.expectedAmount,
      receiptUrl: parsedParams.receiptUrl,
      rawText: `URL entry: ${parsedParams.receiptUrl}`
    });

    res.status(result.status).json(result.result);
  } catch (error: any) {
    res.status(400).json({ error: 'Validation or processing failed', details: error.errors || error.message });
  }
};

export const verifyManualPayload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsedParams = verifyManualSchema.parse(req.body);
    const cashierId = req.cashierId || req.user?.userId;
    const branchId = req.user?.branchId;

    if (!cashierId || !branchId) {
      res.status(401).json({ error: 'Missing context.' });
      return;
    }

    // Do NOT forward receivingAccount/senderAccount from the client body.
    // The verified receiver account is always sourced from the branch's registered
    // BankSettlementAccount in the database (processVerification sets expectedReceiverAccount).
    const result = await processVerification({
      branchId,
      cashierId,
      provider: parsedParams.provider,
      txnReference: parsedParams.txnReference,
      amount: parsedParams.amount,
      expectedAmount: parsedParams.expectedAmount,
      payerPhone: parsedParams.payerPhone,
      rawText: 'MANUAL_ENTRY'
    });

    res.status(result.status).json(result.result);
  } catch (error: any) {
    res.status(400).json({ error: 'Validation failed', details: error.errors || error.message });
  }
};
