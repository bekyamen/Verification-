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
    // 1. Fast-path check for duplicates to save time and prevent unnecessary scraping
    const preCheckRecord = await prisma.verificationRecord.findUnique({
      where: {
        branchId_provider_txnReference: { branchId, provider, txnReference }
      }
    });

    /* 
    if (preCheckRecord && preCheckRecord.status === 'VERIFIED') {
      const today = new Date(new Date().setHours(0,0,0,0));
      await prisma.dailyReport.upsert({
        where: { branchId_reportDate: { branchId, reportDate: today } },
        create: {
          branchId, reportDate: today, totalRevenue: 0, telebirrTotal: 0,
          cbeTotal: 0, cashTotal: 0, totalTransactions: 0, duplicatesBlocked: 1
        },
        update: { duplicatesBlocked: { increment: 1 } }
      });
      return { status: 409, result: { status: 'FLAGGED_DUPLICATE', message: 'Transaction was already verified.' } };
    }
    */

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
        if (provider === 'CBE') {
           if (finalStatus === 'VERIFIED') {
              const ftMatch = canonicalRef.match(/^FT(\d{2})(\d{3})/i);
              let refDate: Date | null = null;
              if (ftMatch) {
                 const year = 2000 + parseInt(ftMatch[1], 10);
                 const dayOfYear = parseInt(ftMatch[2], 10);
                 refDate = new Date(year, 0); // Jan 1st
                 refDate.setDate(dayOfYear);
              }
              const targetDate = refDate || providerResult.date;

              if (targetDate) {
                  const todayMidnight = new Date();
                  todayMidnight.setHours(0,0,0,0);
                  const targetMidnight = new Date(targetDate);
                  targetMidnight.setHours(0,0,0,0);
                  const daysDiff = Math.abs(todayMidnight.getTime() - targetMidnight.getTime()) / (1000 * 3600 * 24);
                  
                  const maxAge = Number(process.env.RECEIPT_MAX_AGE_DAYS ?? 2);
                  if (daysDiff > maxAge) {
                     finalStatus = 'INVALID_RECEIPT';
                     providerResult.message = `Receipt is older than ${maxAge} days.`;
                  }
   
                  if (options.printedDate) {
                     const printedMidnight = new Date(options.printedDate);
                     printedMidnight.setHours(0,0,0,0);
                     const printedDaysDiff = Math.abs(printedMidnight.getTime() - targetMidnight.getTime()) / (1000 * 3600 * 24);
                     if (printedDaysDiff > 1) {
                        finalStatus = 'INVALID_RECEIPT';
                        providerResult.message = 'The date printed on the receipt does not match the actual transaction date.';
                     }
                  }
              }
           }
        }
      } catch (e) {
         console.warn("Safety Check Error:", e);
      }
    }

    if (finalStatus === 'NEEDS_SUFFIX') {
       return { status: 400, result: { status: 'NEEDS_SUFFIX', message: providerResult.message || 'Legacy CBE FT reference requires the last 8 digits of the receiver account. Please enter manually.' } };
    }

    let dbStatus = finalStatus;

    // Utilize Prisma Interactive Transaction to guarantee database-level concurrency protection
    const result = await prisma.$transaction(async (tx) => {
      // 3. Double Check for duplicates safely locked inside transaction (handles race conditions)
      // NEW: @@unique([branchId, provider, txnReference])
      const existingRecord = await tx.verificationRecord.findUnique({
        where: {
          branchId_provider_txnReference: {
            branchId,
            provider,
            txnReference: canonicalRef
          }
        }
      });

      if (existingRecord) {
        /* 
        if (existingRecord.status === 'VERIFIED') {
          // It's a duplicate of a valid payment! Log the fraud attempt.
          const today = new Date(new Date().setHours(0,0,0,0));
          await tx.dailyReport.upsert({
            where: {
              branchId_reportDate: { branchId, reportDate: today }
            },
            create: {
              branchId,
              reportDate: today,
              totalRevenue: 0,
              telebirrTotal: 0,
              cbeTotal: 0,
              cashTotal: 0,
              totalTransactions: 0,
              duplicatesBlocked: 1
            },
            update: {
              duplicatesBlocked: { increment: 1 }
            }
          });

          throw new Error('FLAGGED_DUPLICATE');
        }
        */
      }

      // 4. Persist the verfication record with new schema fields
      const record = await tx.verificationRecord.upsert({
        where: { branchId_provider_txnReference: { branchId, provider, txnReference: canonicalRef } },
        update: {
          amount: new Prisma.Decimal(finalAmount),
          expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
          receivingAccount,
          senderAccount,
          payerPhone,
          payerName: providerResult.payerName || null,
          receiptUrl,
          receiptImageUrl,
          status: dbStatus as any,
          rawScannedText: rawText || null,
          ...(finalStatus === 'VERIFIED' ? { verifiedAt: new Date() } : {})
        },
        create: {
          branchId,
          cashierId,
          provider,
          txnReference: canonicalRef,
          amount: new Prisma.Decimal(finalAmount),
          expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
          receivingAccount,
          senderAccount,
          payerPhone,
          payerName: providerResult.payerName || null,
          receiptUrl,
          receiptImageUrl,
          status: dbStatus as any,
          rawScannedText: rawText || null,
        }
      });

      // 4. Update ledger if verified
      if (finalStatus === 'VERIFIED') {
        const today = new Date(new Date().setHours(0,0,0,0));
        await tx.dailyReport.upsert({
          where: { branchId_reportDate: { branchId, reportDate: today } },
          create: {
            branchId,
            reportDate: today,
            totalRevenue: finalAmount,
            telebirrTotal: provider === 'TELEBIRR' ? finalAmount : 0,
            cbeTotal: provider === 'CBE' || provider === 'CBE_BIRR' ? finalAmount : 0,
            cashTotal: provider === 'AWASH' ? finalAmount : 0,
            totalTransactions: 1,
            duplicatesBlocked: 0
          },
          update: {
            totalRevenue: { increment: finalAmount },
            totalTransactions: { increment: 1 },
            telebirrTotal: provider === 'TELEBIRR' ? { increment: finalAmount } : undefined,
            cbeTotal: provider === 'CBE' || provider === 'CBE_BIRR' ? { increment: finalAmount } : undefined,
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
      return { status: 409, result: { status: 'FLAGGED_DUPLICATE', message: 'Transaction was already verified (Caught by P2002 Race Condition)' } };
    }
    if (error instanceof Error && error.message === 'FLAGGED_DUPLICATE') {
      return { status: 409, result: { status: 'FLAGGED_DUPLICATE', message: 'Transaction was already verified.' } };
    }
    console.error("Verification Error:", error);
    return { status: 500, result: { status: 'INVALID_RECEIPT', message: 'Internal Server Error' } };
  }
};
