import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { verifyTextSchema, verifyUrlSchema, verifyManualSchema } from '../validators/verification.validator';
import { parseRawText } from '../services/receiptParser.service';
import { processVerification } from '../services/verification.service';
import { dissectPayload } from '../services/linkDissector';
import { runImageVerification } from '../services/imageVerify.service';
import prisma from '../utils/prisma';

async function resolveBranchAndCashier(req: AuthenticatedRequest): Promise<{ cashierId: string; branchId: string } | null> {
  const cashierId = req.cashierId || req.user?.userId;
  if (!cashierId) return null;

  let branchId = req.user?.branchId;
  if (!branchId && req.user?.organizationId) {
    const branch = await prisma.branch.findFirst({
      where: { organizationId: req.user.organizationId },
      select: { id: true },
    });
    branchId = branch?.id;
  }

  if (!branchId) return null;
  return { cashierId, branchId };
}

export const verifyTextPayload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const context = await resolveBranchAndCashier(req);
    if (!context) {
      res.status(401).json({ error: 'Missing cashier or branch context.' });
      return;
    }

    const parsedParams = verifyTextSchema.parse(req.body);
    const { amount } = parseRawText(parsedParams.rawText); 
    const normalized = dissectPayload(parsedParams.rawText);

    const result = await processVerification({
      branchId: context.branchId,
      cashierId: context.cashierId,
      ...normalized,
      amount: amount || normalized.amount,
      expectedAmount: parsedParams.expectedAmount,
      rawText: parsedParams.rawText,
    });

    res.status(result.status).json(result.result);
  } catch (error: any) {
    res.status(400).json({ error: 'Validation or parsing failed', details: error.errors || error.message });
  }
};

export const verifyImagePayload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const context = await resolveBranchAndCashier(req);
    if (!context) {
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
    const provider = req.body.provider ? String(req.body.provider).trim().toUpperCase() : undefined;

    const outcome = await runImageVerification({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      branchId: context.branchId,
      cashierId: context.cashierId,
      expectedAmount,
      provider,
    });

    res.status(outcome.status).json(outcome.result);
  } catch (error: any) {
    res.status(500).json({ error: 'File processing or verification failed', details: error.message });
  }
};

export const verifyUrlPayload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const context = await resolveBranchAndCashier(req);
    if (!context) {
      res.status(401).json({ error: 'Missing context.' });
      return;
    }

    const parsedParams = verifyUrlSchema.parse(req.body);
    const payloadContext = dissectPayload(parsedParams.receiptUrl);

    if (payloadContext.provider === 'UNKNOWN' || !payloadContext.txnReference) {
      res.status(422).json({
        status: 'INVALID_RECEIPT',
        message: 'Could not extract a transaction reference from the provided URL.',
      });
      return;
    }

    const result = await processVerification({
      branchId: context.branchId,
      cashierId: context.cashierId,
      ...payloadContext,
      expectedAmount: parsedParams.expectedAmount,
      receiptUrl: parsedParams.receiptUrl,
      rawText: `URL entry: ${parsedParams.receiptUrl}`,
    });

    res.status(result.status).json(result.result);
  } catch (error: any) {
    res.status(400).json({ error: 'Validation or processing failed', details: error.errors || error.message });
  }
};

export const verifyManualPayload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const context = await resolveBranchAndCashier(req);
    if (!context) {
      res.status(401).json({ error: 'Missing context.' });
      return;
    }

    const parsedParams = verifyManualSchema.parse(req.body);

    const result = await processVerification({
      branchId: context.branchId,
      cashierId: context.cashierId,
      provider: parsedParams.provider,
      txnReference: parsedParams.txnReference,
      amount: parsedParams.amount,
      expectedAmount: parsedParams.expectedAmount,
      payerPhone: parsedParams.payerPhone,
      rawText: 'MANUAL_ENTRY',
    });

    res.status(result.status).json(result.result);
  } catch (error: any) {
    res.status(400).json({ error: 'Validation failed', details: error.errors || error.message });
  }
};
