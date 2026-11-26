import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { verifyTextSchema, verifyUrlSchema, verifyManualSchema } from '../validators/verification.validator';
import { parseRawText } from '../services/receiptParser.service';
import { processVerification } from '../services/verification.service';
import { dissectPayload } from '../services/linkDissector';
import { runImageVerification } from '../services/imageVerify.service';
import { verifyTelebirrReceiptWithPayProof } from '../services/payproof.service';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { buildDuplicateMessage } from '../utils/duplicateFormatter';
import { notifyAdminsOnCashierVerification } from '../services/notification.service';

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

    if (outcome.result && outcome.result.provider === 'TELEBIRR') {
      const ref = outcome.result.txnReference || outcome.result.reference;
      if (ref) {
        outcome.result.txnReference = ref;
        outcome.result.reference = ref;
      }
    }

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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');

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

    const [grouped, recentByCreated, recentByVerified] = await Promise.all([
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
      prisma.verificationRecord.findMany({
        where: { branchId: context.branchId, verifiedAt: { not: null } },
        orderBy: { verifiedAt: 'desc' },
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

    // Merge & sort by most recent activity timestamp (verifiedAt if present, else createdAt)
    const seenIds = new Set<string>();
    const mergedRows = [...recentByVerified, ...recentByCreated].filter((r) => {
      if (seenIds.has(r.id)) return false;
      seenIds.add(r.id);
      return true;
    });
    mergedRows.sort((a, b) => {
      const ta = Math.max(a.verifiedAt ? a.verifiedAt.getTime() : 0, a.createdAt.getTime());
      const tb = Math.max(b.verifiedAt ? b.verifiedAt.getTime() : 0, b.createdAt.getTime());
      return tb - ta;
    });

    const recent = mergedRows.slice(0, limit).map((r) => ({
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

/**
 * Direct PayProof Receipt Verification Endpoint (TELEBIRR ONLY).
 *
 * Sequence:
 * 1. Accepts receipt image (fields: "images[]", "receipt", "file", or "image").
 * 2. Uploads securely to PayProof (POST /api/v1/verifications/).
 * 3. Polls status every ~2s until terminal state.
 * 4. Extracts settled_amount from link_receipt_data / pdf_link_data, compares in integer cents.
 * 5. Strictly rejects any non-Telebirr bank receipt.
 * 6. Returns clean standardized JSON response.
 */
export const verifyReceiptPayProof = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const wantsStream =
    req.query.stream === '1' ||
    String(req.headers.accept || '').includes('application/x-ndjson');

  const sendStreamEvent = (payload: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(JSON.stringify(payload) + '\n');
    }
  };

  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        verified: false,
        error: 'No receipt image file uploaded. Please upload a receipt image using field "images[]", "receipt", or "file".',
      });
      return;
    }

    let expectedAmount: number | undefined = undefined;
    if (req.body.expectedAmount) {
      expectedAmount = parseFloat(req.body.expectedAmount);
    } else if (req.query.expectedAmount) {
      expectedAmount = parseFloat(String(req.query.expectedAmount));
    }

    // Explicit provider check if provided: TELEBIRR ONLY
    const requestedProvider = req.body.provider || req.query.provider;
    if (requestedProvider && !String(requestedProvider).toUpperCase().includes('TELEBIRR')) {
      res.status(422).json({
        success: false,
        verified: false,
        status: 'INVALID_RECEIPT',
        code: 'UNSUPPORTED_BANK',
        provider: 'TELEBIRR',
        message: `Only Telebirr receipt verification is supported by this endpoint. Bank/provider "${requestedProvider}" is not supported here.`,
      });
      return;
    }

    if (wantsStream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(200);
      if (typeof (res as any).flushHeaders === 'function') {
        (res as any).flushHeaders();
      }
    }

    // Optional context resolution
    let context = await resolveBranchAndCashier(req).catch(() => null);
    let registeredAccounts: Array<{ accountNumber: string; accountHolderName: string }> = [];

    if (context?.branchId) {
      try {
        const branch = await prisma.branch.findUnique({
          where: { id: context.branchId },
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
        // Continue even if DB account fetch has transient error
      }
    } else {
      // Unauthenticated request (curl test or public verify endpoint):
      // Look up default branch & registered Telebirr accounts from DB
      try {
        const defaultBranch = await prisma.branch.findFirst({
          include: {
            organization: {
              include: {
                bankSettlementAccounts: {
                  where: { isActive: true, bankName: 'TELEBIRR' },
                },
              },
            },
            users: {
              take: 1,
            },
          },
        });
        if (defaultBranch) {
          context = {
            branchId: defaultBranch.id,
            cashierId: defaultBranch.users[0]?.id || 'SYSTEM_API',
          };
          registeredAccounts = defaultBranch.organization?.bankSettlementAccounts ?? [];
        } else {
          registeredAccounts = await prisma.bankSettlementAccount.findMany({
            where: { isActive: true, bankName: 'TELEBIRR' },
            select: { accountNumber: true, accountHolderName: true },
          });
        }
      } catch (e) {
        // Continue if DB unavailable
      }
    }

    const outcome = await verifyTelebirrReceiptWithPayProof(
      req.file.buffer,
      req.file.originalname || 'receipt.jpg',
      req.file.mimetype || 'image/jpeg',
      {
        expectedAmount,
        registeredAccounts,
        onProgress: wantsStream ? (stage) => sendStreamEvent({ stage }) : undefined,
      }
    );

    // Check for existing verified record across organization before accepting
    let organizationId: string | undefined = undefined;
    if (context?.branchId) {
      try {
        const b = await prisma.branch.findUnique({
          where: { id: context.branchId },
          select: { organizationId: true },
        });
        organizationId = b?.organizationId;
      } catch (_) {}
    }

    if (outcome.status === 'VERIFIED' && outcome.reference) {
      try {
        const dup = await prisma.verificationRecord.findFirst({
          where: {
            provider: 'TELEBIRR',
            txnReference: outcome.reference,
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
          logger.warn(`[PayProof] Duplicate receipt detected: ${outcome.reference}`);
          if (context?.branchId) {
            try {
              const today = new Date(new Date().setHours(0, 0, 0, 0));
              await prisma.dailyReport.upsert({
                where: { branchId_reportDate: { branchId: context.branchId, reportDate: today } },
                create: {
                  branchId: context.branchId,
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
          }

          const matchedAccount = dup.branch?.organization?.bankSettlementAccounts?.find(
            (a: any) => a.accountNumber === dup.receivingAccount || a.bankName === 'TELEBIRR'
          );
          const ownerName = dup.branch?.organization?.name || matchedAccount?.accountHolderName || 'Beki Plc';
          const receiverParty =
            outcome.receiverName ||
            (outcome.raw as any)?.to_name ||
            (outcome.raw as any)?.pdf_link_data?.to_name ||
            matchedAccount?.accountHolderName ||
            'SADA';

          const dupMessage = buildDuplicateMessage({
            ownerName,
            isoDate: dup.verifiedAt || dup.createdAt,
            amount: Number(dup.amount),
            receiverParty,
            transactionDate: outcome.transactionDate || dup.verifiedAt || dup.createdAt,
            verifiedAt: dup.verifiedAt || dup.createdAt,
          });

          const dupPayload = {
            success: false,
            verified: false,
            status: 'FLAGGED_DUPLICATE',
            provider: 'TELEBIRR',
            reference: outcome.reference,
            txnReference: outcome.reference,
            amount: Number(dup.amount),
            settledAmount: Number(dup.amount),
            verifiedAt: dup.verifiedAt?.toISOString(),
            recordId: dup.id,
            ownerName,
            receiverParty,
            message: dupMessage,
          };

          if (wantsStream) {
            sendStreamEvent({ done: true, httpStatus: 409, result: dupPayload });
            res.end();
          } else {
            res.status(409).json(dupPayload);
          }
          return;
        }
      } catch (err: any) {
        logger.warn(`[PayProof] Duplicate check error: ${err.message}`);
      }
    }

    // If verified and branch context exists, persist to database
    let savedRecord: any = null;
    if (context && outcome.status === 'VERIFIED' && outcome.reference) {
      try {
        const now = new Date();
        const verifiedTime = outcome.transactionDate && !isNaN(outcome.transactionDate.getTime())
          ? outcome.transactionDate
          : now;

        savedRecord = await prisma.$transaction(async (tx) => {
          const prior = await tx.verificationRecord.findUnique({
            where: {
              branchId_provider_txnReference: {
                branchId: context.branchId,
                provider: 'TELEBIRR',
                txnReference: outcome.reference,
              },
            },
          });

          const isAlreadyVerified = prior?.status === 'VERIFIED';

          const record = await tx.verificationRecord.upsert({
            where: {
              branchId_provider_txnReference: {
                branchId: context.branchId,
                provider: 'TELEBIRR',
                txnReference: outcome.reference,
              },
            },
            update: {
              amount: new Prisma.Decimal(outcome.settledAmount),
              expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
              receivingAccount: outcome.receiverAccount || null,
              payerPhone: outcome.senderPhone || null,
              payerName: outcome.senderName || null,
              receiptImageUrl: 'PAYPROOF_VERIFIED_RECEIPT',
              status: 'VERIFIED',
              verifiedAt: verifiedTime,
            },
            create: {
              branchId: context.branchId,
              cashierId: context.cashierId,
              provider: 'TELEBIRR',
              txnReference: outcome.reference,
              amount: new Prisma.Decimal(outcome.settledAmount),
              expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
              receivingAccount: outcome.receiverAccount || null,
              payerPhone: outcome.senderPhone || null,
              payerName: outcome.senderName || null,
              receiptImageUrl: 'PAYPROOF_VERIFIED_RECEIPT',
              status: 'VERIFIED',
              verifiedAt: verifiedTime,
            },
          });

          if (!isAlreadyVerified) {
            const today = new Date(new Date().setHours(0, 0, 0, 0));
            await tx.dailyReport.upsert({
              where: { branchId_reportDate: { branchId: context.branchId, reportDate: today } },
              create: {
                branchId: context.branchId,
                reportDate: today,
                totalRevenue: outcome.settledAmount,
                telebirrTotal: outcome.settledAmount,
                cbeTotal: 0,
                cashTotal: 0,
                totalTransactions: 1,
                duplicatesBlocked: 0,
              },
              update: {
                totalRevenue: { increment: outcome.settledAmount },
                telebirrTotal: { increment: outcome.settledAmount },
                totalTransactions: { increment: 1 },
              },
            });
          }

          return record;
        });
      } catch (dbErr: any) {
        console.warn('[PayProof] Warning: Could not persist verification record to DB:', dbErr.message);
      }
    }

    if (outcome.status === 'VERIFIED' && context?.branchId && context?.cashierId) {
      const notifyResult = savedRecord ? { ...savedRecord } : {
        status: 'VERIFIED',
        provider: 'TELEBIRR',
        txnReference: outcome.reference || (outcome as any).txnReference,
        amount: outcome.settledAmount || outcome.amount,
        settledAmount: outcome.settledAmount || outcome.amount,
        payerName: outcome.senderName,
        payerPhone: outcome.senderPhone,
        receivingAccount: outcome.receiverAccount,
        transactionDate: outcome.transactionDate,
        verifiedAt: new Date(),
      };
      const finalParty =
        outcome.receiverName ||
        (outcome as any).to_name ||
        (outcome.raw as any)?.to_name ||
        (outcome.raw as any)?.pdf_link_data?.to_name ||
        'SADA';
      (notifyResult as any).receiverName = finalParty;
      (notifyResult as any).receiverParty = finalParty;
      (notifyResult as any).to_name = finalParty;
      if (outcome.transactionDate) {
        (notifyResult as any).transactionDate = outcome.transactionDate;
      }

      void notifyAdminsOnCashierVerification({
        branchId: context.branchId,
        cashierId: context.cashierId,
        result: notifyResult,
      }).catch((err) => {
        logger.warn(`[admin-notify] Failed to notify admin: ${err.message}`);
      });
    }

    let httpStatus = 200;
    if (outcome.status === 'VERIFIED') {
      httpStatus = 200;
    } else if (outcome.status === 'AMOUNT_MISMATCH') {
      httpStatus = 400;
    } else if (outcome.status === 'INVALID_RECEIPT' || outcome.status === 'WRONG_RECEIVER') {
      httpStatus = 422;
    } else if (outcome.status === 'FAILED_UPSTREAM') {
      httpStatus = 502;
    } else {
      httpStatus = 400;
    }

    const finalRef = outcome.reference || (outcome as any).txnReference || '';
    const finalToName = (outcome as any).to_name || (outcome.raw as any)?.to_name || outcome.receiverName || 'SADA';
    const finalReceiver = outcome.receiverName || finalToName;

    const responsePayload = {
      ...outcome,
      reference: finalRef,
      txnReference: finalRef,
      receiverName: finalReceiver,
      to_name: finalToName,
      ...(savedRecord ? { recordId: savedRecord.id } : {}),
    };
    delete (responsePayload as any).raw;

    if (wantsStream) {
      sendStreamEvent({ done: true, httpStatus, result: responsePayload });
      res.end();
    } else {
      res.status(httpStatus).json(responsePayload);
    }
  } catch (error: any) {
    if (wantsStream && res.headersSent) {
      sendStreamEvent({
        done: true,
        httpStatus: 500,
        result: {
          success: false,
          verified: false,
          status: 'INVALID_RECEIPT',
          message: error.message || 'PayProof Telebirr verification failed.',
        },
      });
      res.end();
    } else {
      res.status(500).json({
        success: false,
        verified: false,
        error: 'Verification processing failed',
        details: error.message,
      });
    }
  }
};
