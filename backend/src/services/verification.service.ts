import prisma from '../utils/prisma';
import { Prisma } from '@prisma/client';
import { VerificationRequest, verifierRegistry } from './verificationEngine';
import { accountsCache } from '../utils/verifyCache';

export const processVerification = async (options: VerificationRequest): Promise<{
  status: number;
  result: any;
  timings?: { dbMs: number; bankMs: number };
}> => {
  const { 
    branchId, cashierId, provider, txnReference, amount, 
    expectedAmount, rawText, receivingAccount, senderAccount, 
    payerPhone, receiptUrl, receiptImageUrl 
  } = options;

  if (!txnReference || provider === 'UNKNOWN' || provider === 'OTHER') {
    return {
      status: 422,
      result: {
        status: 'INVALID_RECEIPT',
        message: 'Could not confidently extract provider or transaction reference.',
        provider,
        txnReference,
      },
      timings: { dbMs: 0, bankMs: 0 }
    };
  }

  try {
    // Unsupported provider — return a clean 422 instead of throwing
    const verifier = verifierRegistry[provider];
    if (!verifier) {
      return {
        status: 422,
        result: {
          status: 'INVALID_RECEIPT',
          message: `Provider ${provider} is not supported for verification.`,
          provider,
          txnReference,
        },
        timings: { dbMs: 0, bankMs: 0 }
      };
    }

    const tDb0 = Date.now();
    const cacheKey = `branch:${branchId}`;
    const cachedAccounts = accountsCache.get(cacheKey);

    // ── Parallel lookup of priorRecord and registeredAccounts ────────────────
    const priorRecordPromise = prisma.verificationRecord.findUnique({
      where: {
        branchId_provider_txnReference: {
          branchId,
          provider,
          txnReference,
        },
      },
    });

    const accountsPromise = cachedAccounts !== null
      ? Promise.resolve(cachedAccounts)
      : prisma.branch.findUnique({
          where: { id: branchId },
          include: { organization: { include: { bankSettlementAccounts: { where: { isActive: true } } } } }
        }).then((branch) => {
          const all = branch?.organization?.bankSettlementAccounts ?? [];
          accountsCache.set(cacheKey, all);
          return all;
        });

    const [priorRecord, allAccounts] = await Promise.all([
      priorRecordPromise,
      accountsPromise,
    ]);
    const dbLookupMs = Date.now() - tDb0;

    // Filter to the relevant provider
    const registeredAccounts = (allAccounts || []).filter((a: any) => {
      if (provider === 'CBE'      && (a.bankName === 'CBE' || a.bankName === 'CBE_BIRR')) return true;
      if (provider === 'TELEBIRR' && a.bankName === 'TELEBIRR') return true;
      if (provider === 'BOA'      && a.bankName === 'BOA')      return true;
      if (provider === 'AWASH'    && a.bankName === 'AWASH')    return true;
      return false;
    });

    // ── Early Return for Repeat Scans (Bank Bypass) ───────────────────────────
    // If this transaction was already successfully verified, skip the upstream bank call!
    if (priorRecord && priorRecord.status === 'VERIFIED') {
      const recordedAmount = Number(priorRecord.amount);
      if (expectedAmount && Math.abs(recordedAmount - expectedAmount) > 0.01) {
        return {
          status: 400,
          result: {
            ...priorRecord,
            status: 'AMOUNT_MISMATCH',
            message: `Amount mismatch: expected ${expectedAmount} ETB but receipt is for ${recordedAmount} ETB.`,
          },
          timings: { dbMs: dbLookupMs, bankMs: 0 }
        };
      }
      return {
        status: 200,
        result: priorRecord,
        timings: { dbMs: dbLookupMs, bankMs: 0 }
      };
    }

    if (['CBE', 'TELEBIRR'].includes(provider) && registeredAccounts.length === 0) {
      return {
        status: 422,
        result: {
          status: 'INVALID_RECEIPT',
          message: `No active registered receiving accounts found for provider ${provider}. Verification cannot proceed.`,
          provider,
          txnReference
        },
        timings: { dbMs: dbLookupMs, bankMs: 0 }
      };
    }

    const expectedReceiverAccount = registeredAccounts[0]?.accountNumber;

    const tBank0 = Date.now();
    const providerResult = await verifier.verify({
      ...options,
      receivingAccount: expectedReceiverAccount,
      senderAccount: undefined,
      expectedReceiverAccount,
      registeredAccounts,
    });
    const bankMs = Date.now() - tBank0;
    
    if (providerResult.status === 'NEEDS_INPUT') {
      return { 
        status: 422, 
        result: { 
          status: 'NEEDS_INPUT', 
          code: providerResult.code, 
          message: providerResult.message,
          provider, 
          txnReference: providerResult.reference ?? txnReference 
        },
        timings: { dbMs: dbLookupMs, bankMs }
      };
    }

    const canonicalRef = providerResult.reference ?? txnReference;
    let finalStatus = providerResult.status;
    const finalAmount = providerResult.amountExtracted;
    
    if (finalStatus === 'VERIFIED' && expectedAmount) {
      if (Math.abs(finalAmount - expectedAmount) > 0.01) {
        finalStatus = 'AMOUNT_MISMATCH';
      }
    }

    // Validate strict safety checks BEFORE creating the record
    if (finalStatus === 'VERIFIED') {
      try {
        if (provider === 'CBE' && options.printedDate) {
          const ftMatch = canonicalRef.match(/^FT(\d{2})(\d{3})/i);
          let refDate: Date | null = null;
          if (ftMatch) {
            const year = 2000 + parseInt(ftMatch[1], 10);
            const dayOfYear = parseInt(ftMatch[2], 10);
            refDate = new Date(year, 0);
            refDate.setDate(dayOfYear);
          }
          const targetDate = refDate || providerResult.date;

          if (targetDate) {
            const targetMidnight = new Date(targetDate);
            targetMidnight.setHours(0, 0, 0, 0);
            const printedMidnight = new Date(options.printedDate);
            printedMidnight.setHours(0, 0, 0, 0);
            const printedDaysDiff =
              Math.abs(printedMidnight.getTime() - targetMidnight.getTime()) / (1000 * 3600 * 24);
            if (printedDaysDiff > 1) {
              finalStatus = 'INVALID_RECEIPT';
              providerResult.message = 'The date printed on the receipt does not match the actual transaction date.';
            }
          }
        }
      } catch (e) {
        console.warn('Safety Check Error:', e);
      }
    }

    if (finalStatus === 'NEEDS_SUFFIX') {
      return {
        status: 400,
        result: {
          status: 'NEEDS_SUFFIX',
          message: providerResult.message || 'Legacy CBE FT reference requires the last 8 digits of the receiver account. Please enter manually.'
        },
        timings: { dbMs: dbLookupMs, bankMs }
      };
    }

    // FAILED_UPSTREAM: never persist — return immediately
    if (finalStatus === 'FAILED_UPSTREAM') {
      return {
        status: 502,
        result: {
          status: 'FAILED_UPSTREAM',
          message: providerResult.message || 'Upstream bank API error. Please retry.',
          provider,
          txnReference,
        },
        timings: { dbMs: dbLookupMs, bankMs }
      };
    }

    let dbStatus = finalStatus;
    const isSuccessful = finalStatus === 'VERIFIED';

    const storedReceiptImageUrl = isSuccessful ? receiptImageUrl : null;
    const storedReceiptUrl = isSuccessful ? receiptUrl : null;
    const storedAmount = isSuccessful ? finalAmount : 0;
    const now = new Date();
    const matchedReceiver = providerResult.receiverAccount || expectedReceiverAccount || null;

    const tTx0 = Date.now();
    // Re-use priorRecord fetched above: skip redundant findUnique inside transaction
    const wasAlreadyVerified = priorRecord?.status === 'VERIFIED';

    const result = await prisma.$transaction(async (tx) => {
      // Persist / update the verification record
      const record = await tx.verificationRecord.upsert({
        where: { branchId_provider_txnReference: { branchId, provider, txnReference: canonicalRef } },
        update: {
          amount: new Prisma.Decimal(storedAmount),
          expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
          receivingAccount: matchedReceiver,
          payerPhone,
          payerName: providerResult.payerName || null,
          receiptUrl: storedReceiptUrl,
          receiptImageUrl: storedReceiptImageUrl,
          status: dbStatus as any,
          rawScannedText: rawText || null,
          ...(isSuccessful ? { verifiedAt: now } : {})
        },
        create: {
          branchId,
          cashierId,
          provider,
          txnReference: canonicalRef,
          amount: new Prisma.Decimal(storedAmount),
          expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
          receivingAccount: matchedReceiver,
          payerPhone,
          payerName: providerResult.payerName || null,
          receiptUrl: storedReceiptUrl,
          receiptImageUrl: storedReceiptImageUrl,
          status: dbStatus as any,
          rawScannedText: rawText || null,
          ...(isSuccessful ? { verifiedAt: now } : {})
        }
      });

      // Update daily ledger only for genuinely new VERIFIED transactions
      if (finalStatus === 'VERIFIED' && !wasAlreadyVerified) {
        const today = new Date(new Date().setHours(0,0,0,0));
        await tx.dailyReport.upsert({
          where: { branchId_reportDate: { branchId, reportDate: today } },
          create: {
            branchId,
            reportDate: today,
            totalRevenue: finalAmount,
            telebirrTotal: provider === 'TELEBIRR' ? finalAmount : 0,
            cbeTotal: provider === 'CBE' || provider === 'CBE_BIRR' ? finalAmount : 0,
            cashTotal: (provider === 'AWASH' || provider === 'DASHEN' || provider === 'BOA') ? finalAmount : 0,
            totalTransactions: 1,
            duplicatesBlocked: 0
          },
          update: {
            totalRevenue: { increment: finalAmount },
            totalTransactions: { increment: 1 },
            telebirrTotal: provider === 'TELEBIRR' ? { increment: finalAmount } : undefined,
            cbeTotal: provider === 'CBE' || provider === 'CBE_BIRR' ? { increment: finalAmount } : undefined,
            cashTotal: (provider === 'AWASH' || provider === 'DASHEN' || provider === 'BOA') ? { increment: finalAmount } : undefined,
          }
        });
      }

      if (finalStatus !== 'VERIFIED') {
        if (providerResult.message) (record as any).message = providerResult.message;
        if (providerResult.amountExtracted) (record as any).amount = new Prisma.Decimal(providerResult.amountExtracted);
        if (providerResult.receiverAccount) (record as any).receivingAccount = providerResult.receiverAccount;
        if (providerResult.payerName) (record as any).payerName = providerResult.payerName;
        if (providerResult.reference) (record as any).txnReference = providerResult.reference;
      }

      return record;
    });

    const totalDbMs = dbLookupMs + (Date.now() - tTx0);

    if (result.status === 'AMOUNT_MISMATCH') {
      return { status: 400, result, timings: { dbMs: totalDbMs, bankMs } };
    }
    if (result.status === 'INVALID_RECEIPT' || result.status === 'FAILED_UPSTREAM') {
      return { status: 422, result, timings: { dbMs: totalDbMs, bankMs } };
    }

    return { status: 200, result, timings: { dbMs: totalDbMs, bankMs } };

  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const lookupRef = (error as any)._canonicalRef ?? txnReference;
      try {
        const existing = await prisma.verificationRecord.findUnique({
          where: { branchId_provider_txnReference: { branchId, provider, txnReference: lookupRef } }
        });
        if (existing) {
          return { status: 200, result: existing, timings: { dbMs: 0, bankMs: 0 } };
        }
      } catch (_) { /* fall through to 500 */ }
    }
    console.error("Verification Error:", error);
    return {
      status: 500,
      result: { status: 'INVALID_RECEIPT', message: 'Internal Server Error' },
      timings: { dbMs: 0, bankMs: 0 }
    };
  }
};
