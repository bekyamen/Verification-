import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { verifyTextSchema, verifyUrlSchema, verifyManualSchema } from '../validators/verification.validator';
import { parseRawText, parseFileBuffer, scrapeURLSession } from '../services/receiptParser.service';
import { processVerification } from '../services/verification.service';
import { dissectPayload } from '../services/linkDissector';



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

    const extractedOld = await parseFileBuffer(req.file.buffer, req.file.mimetype);
    
    // Pass the underlying OCR string through the dissector for robust extraction
    const normalized = extractedOld.rawText 
      ? dissectPayload(extractedOld.rawText) 
      : { 
          provider: extractedOld.provider, 
          txnReference: extractedOld.txnReference || '',
          receivingAccount: undefined,
          senderAccount: undefined,
          payerPhone: undefined
        } as any;

    const result = await processVerification({
      branchId,
      cashierId,
      provider: normalized.provider === 'UNKNOWN' ? extractedOld.provider : normalized.provider,
      txnReference: normalized.txnReference || extractedOld.txnReference || '',
      amount: extractedOld.amount || undefined,
      expectedAmount,
      receivingAccount: normalized.receivingAccount,
      senderAccount: normalized.senderAccount,
      payerPhone: normalized.payerPhone,
      payerName: normalized.payerName,
      printedDate: normalized.printedDate,
      rawText: extractedOld.rawText,
      // Siinqee fallback proof if it's an image
      receiptImageUrl: 'UPLOADED_FILE_PROOF'
    });

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

    // Try purely dissecting the URL first
    let payloadContext = dissectPayload(parsedParams.receiptUrl);

    // If it's unknown, maybe it's a shortlink we need to fetch
    if (payloadContext.provider === 'UNKNOWN') {
      const extractedOld = await scrapeURLSession(parsedParams.receiptUrl);
      payloadContext.provider = extractedOld.provider;
      payloadContext.txnReference = extractedOld.txnReference || '';
      payloadContext.amount = extractedOld.amount || undefined;
    }

    const result = await processVerification({
      branchId,
      cashierId,
      ...payloadContext,
      expectedAmount: parsedParams.expectedAmount,
      receiptUrl: parsedParams.receiptUrl,
      rawText: `Scraped from ${parsedParams.receiptUrl}`
    });

    res.status(result.status).json(result.result);
  } catch (error: any) {
    res.status(400).json({ error: 'Validation or scraping failed', details: error.errors || error.message });
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

    const result = await processVerification({
      branchId,
      cashierId,
      provider: parsedParams.provider,
      txnReference: parsedParams.txnReference,
      amount: parsedParams.amount,
      expectedAmount: parsedParams.expectedAmount,
      receivingAccount: parsedParams.receivingAccount || parsedParams.receivingPhoneNumber,
      senderAccount: parsedParams.senderAccount,
      payerPhone: parsedParams.payerPhone,
      rawText: 'MANUAL_ENTRY'
    });

    res.status(result.status).json(result.result);
  } catch (error: any) {
    res.status(400).json({ error: 'Validation failed', details: error.errors || error.message });
  }
};
