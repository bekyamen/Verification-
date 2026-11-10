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
  const wantsStream =
    req.query.stream === '1' ||
    String(req.headers.accept || '').includes('application/x-ndjson');

  const sendStreamEvent = (payload: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(JSON.stringify(payload) + '\n');
    }
  };

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

    if (wantsStream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(200);
      if (typeof (res as any).flushHeaders === 'function') {
        (res as any).flushHeaders();
      }
    }

    const outcome = await runImageVerification({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      branchId: context.branchId,
      cashierId: context.cashierId,
      expectedAmount,
      provider,
      onProgress: wantsStream ? (stage) => sendStreamEvent({ stage }) : undefined,
    });

    if (wantsStream) {
      sendStreamEvent({ done: true, httpStatus: outcome.status, result: outcome.result });
      res.end();
    } else {
      res.status(outcome.status).json(outcome.result);
    }
  } catch (error: any) {
    if (wantsStream && res.headersSent) {
      sendStreamEvent({
        done: true,
        httpStatus: 500,
        result: { status: 'FAILED', message: 'Verification failed. Please try again.' },
      });
      res.end();
    } else {
      res.status(500).json({ error: 'File processing or verification failed', details: error.message });
    }
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

function getRangeStartEat(range: string): Date | null {
  if (range === 'all') return null;

  // Ethiopia (Africa/Addis_Ababa) uses UTC+3 year-round
  const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowEat = new Date(Date.now() + EAT_OFFSET_MS);
  const midnightEatUtcMs =
    Date.UTC(nowEat.getUTCFullYear(), nowEat.getUTCMonth(), nowEat.getUTCDate()) - EAT_OFFSET_MS;

  if (range === 'week') return new Date(midnightEatUtcMs - 6 * 24 * 60 * 60 * 1000);
  if (range === 'month') return new Date(midnightEatUtcMs - 29 * 24 * 60 * 60 * 1000);
  return new Date(midnightEatUtcMs); // 'today'
}

export const getVerificationHistory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const context = await resolveBranchAndCashier(req);
    if (!context) {
      res.status(401).json({ error: 'Missing cashier or branch context.' });
      return;
    }

    const rawRange = String(req.query.range || 'today').trim().toLowerCase();
    const range = rawRange === 'week' || rawRange === 'month' || rawRange === 'all' ? rawRange : 'today';
    const rawLimit = Number(req.query.limit || 15);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 15;
    const rangeStart = getRangeStartEat(range);

    const summaryWhere: any = {
      branchId: context.branchId,
      status: 'VERIFIED',
      ...(rangeStart ? { verifiedAt: { gte: rangeStart } } : {}),
    };

    const [grouped, recentRows] = await Promise.all([
      prisma.verificationRecord.groupBy({
        by: ['provider'],
        where: summaryWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.verificationRecord.findMany({
        where: { branchId: context.branchId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          provider: true,
          txnReference: true,
          amount: true,
          expectedAmount: true,
          payerName: true,
          payerPhone: true,
          receivingAccount: true,
          status: true,
          verifiedAt: true,
          createdAt: true,
        },
      }),
    ]);

    let totalAmount = 0;
    let totalCount = 0;
    const byProvider: Record<string, { amount: number; count: number }> = {};

    for (const row of grouped) {
      const amt = Number(row._sum.amount ?? 0);
      const cnt = row._count._all ?? 0;
      totalAmount += amt;
      totalCount += cnt;
      byProvider[row.provider] = { amount: amt, count: cnt };
    }

    const recent = recentRows.map((r) => ({
      id: r.id,
      provider: r.provider,
      txnReference: r.txnReference,
      amount: Number(r.amount),
      expectedAmount: r.expectedAmount !== null ? Number(r.expectedAmount) : null,
      payerName: r.payerName,
      payerPhone: r.payerPhone,
      receivingAccount: r.receivingAccount,
      status: r.status,
      verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));

    res.json({
      range,
      summary: {
        totalAmount,
        totalCount,
        byProvider,
      },
      recent,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load verification history', details: error.message });
  }
};
