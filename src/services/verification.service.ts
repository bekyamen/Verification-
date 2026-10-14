import prisma from '../utils/prisma';
import { Prisma } from '@prisma/client';
import { VerificationRequest, verifierRegistry } from './verificationEngine';

export const processVerification = async (options: VerificationRequest) => {
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
      }
    };
  }

  try {

    // 2. Delegate to Provider Strategy OUTSIDE the transaction to prevent database timeouts
    const verifier = verifierRegistry[provider];
    if (!verifier) {
        throw new Error('No verifier found for provider');
    }

    const branch = await prisma.branch.findUnique({
       where: { id: branchId },
       include: { organization: { include: { bankSettlementAccounts: { where: { isActive: true } } } } }
    });
    
    let registeredAccounts: any[] = [];
    if (branch && branch.organization) {
        registeredAccounts = branch.organization.bankSettlementAccounts.filter((a) => {
            if (provider === 'CBE' && a.bankName === 'CBE') return true;
            if (provider === 'TELEBIRR' && a.bankName === 'TELEBIRR') return true;
            if (provider === 'BOA' && a.bankName === 'BOA') return true;
            if (provider === 'AWASH' && a.bankName === 'AWASH') return true;
            return false;
        });
    }

    if (['CBE', 'TELEBIRR', 'BOA', 'AWASH'].includes(provider) && registeredAccounts.length === 0) {
        return {
            status: 422,
            result: {
                status: 'INVALID_RECEIPT',
                message: `No active registered receiving accounts found for provider ${provider}. Verification cannot proceed.`,
                provider,
                txnReference
            }
        };
    }

    const providerResult = await verifier.verify({ ...options, registeredAccounts });
    
    if (providerResult.status === 'NEEDS_INPUT') {
      return { 
        status: 422, 
        result: { 
          status: 'NEEDS_INPUT', 
          code: providerResult.code, 
          message: providerResult.message,
          provider, 
          txnReference: providerResult.reference ?? txnReference 
        } 
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
        // Check printed date mismatch for CBE (fraud guard: printed date must match actual transaction date)
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
       return { status: 400, result: { status: 'NEEDS_SUFFIX', message: providerResult.message || 'Legacy CBE FT reference requires the last 8 digits of the receiver account. Please enter manually.' } };
    }

    let dbStatus = finalStatus;
    const isSuccessful = finalStatus === 'VERIFIED';

    // For failed/upstream-error records, do NOT store the uploaded image URL or
    // input amount as valid data — they're meaningless for a failed attempt.
    const storedReceiptImageUrl = isSuccessful ? receiptImageUrl : null;
    const storedReceiptUrl = isSuccessful ? receiptUrl : null;
    const storedAmount = isSuccessful ? finalAmount : 0;
    const now = new Date();

    // Utilize Prisma Interactive Transaction to guarantee database-level concurrency protection
    const result = await prisma.$transaction(async (tx) => {

      // Check whether this transaction was already successfully VERIFIED before the upsert.
      // This lets us skip double-counting it in the daily revenue ledger on re-verifications.
      const priorRecord = await tx.verificationRecord.findUnique({
        where: { branchId_provider_txnReference: { branchId, provider, txnReference: canonicalRef } },
        select: { status: true }
      });
      const wasAlreadyVerified = priorRecord?.status === 'VERIFIED';

      // Persist / update the verification record
      const record = await tx.verificationRecord.upsert({
        where: { branchId_provider_txnReference: { branchId, provider, txnReference: canonicalRef } },
        update: {
          amount: new Prisma.Decimal(storedAmount),
          expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
          receivingAccount,
          senderAccount,
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
          receivingAccount,
          senderAccount,
          payerPhone,
          payerName: providerResult.payerName || null,
          receiptUrl: storedReceiptUrl,
          receiptImageUrl: storedReceiptImageUrl,
          status: dbStatus as any,
          rawScannedText: rawText || null,
          ...(isSuccessful ? { verifiedAt: now } : {})
        }
      });

      // Update daily ledger only for genuinely new VERIFIED transactions.
      // Skip on re-verifications to prevent double-counting revenue.
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

      // Pass message outwardly if flagged
      if (finalStatus !== 'VERIFIED' && providerResult.message) {
         (record as any).message = providerResult.message;
      }

      return record;
    });

    if (result.status === 'AMOUNT_MISMATCH') {
      return { status: 400, result };
    }
    if (result.status === 'INVALID_RECEIPT' || result.status === 'FAILED_UPSTREAM') {
       return { status: 422, result };
    }

    return { status: 200, result };

  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Race condition: another concurrent request created the record first.
      // Re-query and return the persisted record so the client still gets a valid result.
      try {
        const existing = await prisma.verificationRecord.findUnique({
          where: { branchId_provider_txnReference: { branchId, provider, txnReference } }
        });
        if (existing) {
          return { status: 200, result: existing };
        }
      } catch (_) { /* fall through to 500 */ }
    }
    console.error("Verification Error:", error);
    return { status: 500, result: { status: 'INVALID_RECEIPT', message: 'Internal Server Error' } };
  }
};
