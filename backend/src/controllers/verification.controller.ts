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

    // ── Phase 1: Try QR decode first — it's fast (~50 ms) ─────────────────────
    // If QR returns a recognised CBE or Telebirr receipt URL we skip OCR entirely,
    // saving 2-4 seconds of Tesseract processing time.
    const qrValue = await decodeReceiptQr(req.file.buffer, req.file.mimetype);
    const qrMs = Date.now() - t0;

    // A QR hit is a URL that parseReceiptLink accepts (CBE / Telebirr only)
    const qrIsReceiptUrl = !!qrValue && parseReceiptLink(qrValue) !== null;

    let extractedOcr: { provider: any; txnReference: string | null; amount?: number | null; rawText?: string } = {
      provider: 'UNKNOWN', txnReference: '', amount: undefined, rawText: ''
    };
    let ocrMs = 0;

    if (!qrIsReceiptUrl) {
      // ── Phase 2: OCR — only when QR didn't give us a known receipt URL ───────
      const ocrStart = Date.now();
      try {
        extractedOcr = await parseFileBuffer(req.file.buffer, req.file.mimetype);
      } catch {
        // OCR failure is non-fatal — carry on with whatever QR found
      }
      ocrMs = Date.now() - ocrStart;
    }

    let normalized: any = qrValue ? dissectPayload(qrValue) : null;
    const qrHit = !!(normalized && normalized.provider !== 'UNKNOWN' && normalized.txnReference);

    console.info(
      `[timing] image-verify qrMs=${qrMs} ocrMs=${ocrMs} qrHit=${qrHit} qrIsReceiptUrl=${qrIsReceiptUrl} totalMs=${Date.now() - t0}`
    );

    // Build combined raw text (QR URL + OCR text, if any)
    const combinedRawText = [qrValue, extractedOcr.rawText].filter(Boolean).join('\n');

    // Use QR-based normalized payload if it succeeded; otherwise fall back to OCR
    if (!normalized || normalized.provider === 'UNKNOWN' || !normalized.txnReference) {
      normalized = combinedRawText ? dissectPayload(combinedRawText) : { provider: 'UNKNOWN', txnReference: '' };
    }

    // Keep a reference to the image buffer — we may need it for a late OCR retry
    const imageBuffer = req.file.buffer;
    const imageMime   = req.file.mimetype;

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

    // ── Late OCR fallback for QR-only CBE failures ─────────────────────────────
    // If: (a) the QR gave us a v2 token URL, (b) OCR was skipped (ocrMs=0),
    // and (c) the result is FAILED_UPSTREAM — run OCR now to look for an FT
    // reference printed on the receipt and retry via the legacy HTML route.
    // This recovers receipts where CBE's v2 endpoint returns an SPA shell
    // but the cashier's image has "FT26286ZF0XC" legibly printed on it.
    if (
      result.status === 502 &&
      qrIsReceiptUrl &&
      normalized.provider === 'CBE' &&
      ocrMs === 0 // OCR was skipped
    ) {
      logger.info('[image-verify] QR-only CBE FAILED_UPSTREAM — running late OCR to find FT reference');
      try {
        const lateOcr = await parseFileBuffer(imageBuffer, imageMime);
        const ocrText = lateOcr.rawText ?? '';
        logger.info(`[image-verify] Late OCR complete. Text length: ${ocrText.length}`);

        // Extract FT reference from OCR text
        const ftMatch =
          ocrText.match(/\b(FT[A-Z0-9]{8,14})\b/i) ??
          ocrText.match(/(FT[A-Z0-9]{10})/i);

        if (ftMatch) {
          const ftRef = ftMatch[1].toUpperCase();
          logger.info(`[image-verify] Late OCR found FT reference: ${ftRef} — retrying via legacy route`);

          const ftResult = await processVerification({
            branchId,
            cashierId,
            provider: 'CBE',
            txnReference: ftRef,
            amount: lateOcr.amount || undefined,
            expectedAmount,
            rawText: ocrText,
            receiptImageUrl: 'UPLOADED_FILE_PROOF',
          });

          res.status(ftResult.status).json(ftResult.result);
          return;
        }

        logger.warn('[image-verify] Late OCR ran but found no FT reference. Returning original FAILED_UPSTREAM.');
      } catch (ocrErr: any) {
        logger.warn(`[image-verify] Late OCR failed: ${ocrErr.message}`);
      }
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
