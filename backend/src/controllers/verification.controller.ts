import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { verifyTextSchema, verifyUrlSchema, verifyManualSchema } from '../validators/verification.validator';
import { parseRawText } from '../services/receiptParser.service';
import { processVerification } from '../services/verification.service';
import { dissectPayload } from '../services/linkDissector';
import { runImageVerification } from '../services/imageVerify.service';
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

    const outcome = await runImageVerification({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      branchId,
      cashierId,
      expectedAmount,
    });

    res.status(outcome.status).json(outcome.result);

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
