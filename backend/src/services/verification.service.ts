import prisma from '../utils/prisma';
import { Prisma } from '@prisma/client';
import { VerificationRequest, verifierRegistry } from './verificationEngine';
import { accountsCache } from '../utils/verifyCache';

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
        }
      };
    }

    // ── Registered accounts (cached 60 s per branch) ──────────────────────────
    const cacheKey = `branch:${branchId}`;
    let registeredAccounts: any[] = [];

    const cachedAccounts = accountsCache.get(cacheKey);
    if (cachedAccounts !== null) {
      // Filter to the relevant provider from the cached full list
      registeredAccounts = cachedAccounts.filter((a: any) => {
        if (provider === 'CBE'      && a.bankName === 'CBE')      return true;
        if (provider === 'TELEBIRR' && a.bankName === 'TELEBIRR') return true;
        if (provider === 'BOA'      && a.bankName === 'BOA')      return true;
        if (provider === 'AWASH'    && a.bankName === 'AWASH')    return true;
        return false;
      });
    } else {
      const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        include: { organization: { include: { bankSettlementAccounts: { where: { isActive: true } } } } }
      });

      const allAccounts = branch?.organization?.bankSettlementAccounts ?? [];
      // Store the full (un-filtered) list so any provider can use it within the TTL
      accountsCache.set(cacheKey, allAccounts);

      registeredAccounts = allAccounts.filter((a) => {
        if (provider === 'CBE'      && a.bankName === 'CBE')      return true;
        if (provider === 'TELEBIRR' && a.bankName === 'TELEBIRR') return true;
        if (provider === 'BOA'      && a.bankName === 'BOA')      return true;
        if (provider === 'AWASH'    && a.bankName === 'AWASH')    return true;
        return false;
      });
    }

    if (['CBE', 'TELEBIRR'].includes(provider) && registeredAccounts.length === 0) {
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


    const expectedReceiverAccount = registeredAccounts[0]?.accountNumber;

    const providerResult = await verifier.verify({
      ...options,
      // Always use the DB-registered account — never the client-supplied value
      receivingAccount: expectedReceiverAccount,
      senderAccount: undefined,
      expectedReceiverAccount,
      registeredAccounts,
    });
    
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

    // ── Receipt age check ──────────────────────────────────────────────────────
    if (finalStatus === 'VERIFIED' && providerResult.date) {
      const RECEIPT_MAX_AGE_DAYS = parseInt(process.env.RECEIPT_MAX_AGE_DAYS ?? '14', 10);
      const ageDays = (Date.now() - providerResult.date.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > RECEIPT_MAX_AGE_DAYS) {
        return {
          status: 422,
          result: {
            status: 'INVALID_RECEIPT',
            message: `Receipt is ${Math.floor(ageDays)} days old (maximum allowed: ${RECEIPT_MAX_AGE_DAYS} days).`,
            provider,
            txnReference: canonicalRef,
          }
        };
      }
    }

    if (finalStatus === 'NEEDS_SUFFIX') {
       return { status: 400, result: { status: 'NEEDS_SUFFIX', message: providerResult.message || 'Legacy CBE FT reference requires the last 8 digits of the receiver account. Please enter manually.' } };
    }

    // ── FAILED_UPSTREAM: never persist — return immediately ───────────────────
    // Saving a FAILED_UPSTREAM row (amount=0, status=FAILED_UPSTREAM) can silently
    // overwrite a previously VERIFIED record via upsert, making real payments invisible.
    // Transient upstream failures (network error, PDF parse failure, etc.) are not
    // meaningful database state — the cashier can simply retry.
    if (finalStatus === 'FAILED_UPSTREAM') {
      return {
        status: 502,
        result: {
          status: 'FAILED_UPSTREAM',
          message: providerResult.message || 'Upstream bank API error. Please retry.',
          provider,
          txnReference,
        },
      };
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

      const priorRecord = await tx.verificationRecord.findUnique({
        where: { branchId_provider_txnReference: { branchId, provider, txnReference: canonicalRef } },
        select: { status: true, id: true }
      });
      const wasAlreadyVerified = priorRecord?.status === 'VERIFIED';

      // Persist / update the verification record
      const record = await tx.verificationRecord.upsert({
        where: { branchId_provider_txnReference: { branchId, provider, txnReference: canonicalRef } },
        update: {
          amount: new Prisma.Decimal(storedAmount),
          expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
          receivingAccount: expectedReceiverAccount || null,
          payerPhone,
          payerName: providerResult.payerName || null,
          receiptUrl: storedReceiptUrl,
          receiptImageUrl: storedReceiptImageUrl,
          status: dbStatus as any,
          rawScannedText: rawText || null,
          // Only stamp verifiedAt when this update itself is a VERIFIED outcome
          ...(isSuccessful ? { verifiedAt: now } : {})
        },
        create: {
          branchId,
          cashierId,
          provider,
          txnReference: canonicalRef,
          amount: new Prisma.Decimal(storedAmount),
          expectedAmount: expectedAmount ? new Prisma.Decimal(expectedAmount) : null,
          receivingAccount: expectedReceiverAccount || null,
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
      // NOTE: use canonicalRef (the normalised value used in the upsert) if available,
      //       otherwise fall back to the raw txnReference.
      const lookupRef = (error as any)._canonicalRef ?? txnReference;
      try {
        const existing = await prisma.verificationRecord.findUnique({
          where: { branchId_provider_txnReference: { branchId, provider, txnReference: lookupRef } }
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
