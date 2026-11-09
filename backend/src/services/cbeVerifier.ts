import { ProviderVerifier, VerificationRequest, ProviderVerificationResult } from './verificationEngine';
import { verifyCBE } from './verifyCBE';
import { routeCbe } from './cbeRoute';
import logger from '../utils/logger';

/** Normalize an Ethiopian bank account / phone for fuzzy comparison. */
function normalizeCbeAccount(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('2519') || digits.startsWith('2517')) return digits.slice(3);
  if (digits.startsWith('09') || digits.startsWith('07')) return digits.slice(1);
  return digits;
}

/**
 * Returns true if the receiver account from the receipt matches one of our registered accounts.
 * Handles masked strings (***1234), partial trailing matches, and prefix normalization.
 */
function receiptAccountMatchesRegistered(receiptAccount: string, registeredAccount: string): boolean {
  if (!receiptAccount || !registeredAccount) return false;

  const aNorm = normalizeCbeAccount(registeredAccount);

  // Masked receipt account with asterisks (e.g. "1********0763" or "***0763")
  if (receiptAccount.includes('*')) {
    const rawParts = receiptAccount.split('*').filter((p) => p.length > 0);
    if (rawParts.length > 0) {
      const suffix = rawParts[rawParts.length - 1].replace(/\D/g, '');
      const prefix = rawParts.length > 1 ? rawParts[0].replace(/\D/g, '') : '';
      return Boolean(suffix && aNorm.endsWith(suffix) && (!prefix || aNorm.startsWith(prefix)));
    }
    return false;
  }

  const rNorm = normalizeCbeAccount(receiptAccount);
  // Exact match after normalization
  if (rNorm === aNorm) return true;

  // One contains the other (covers partial 13-digit vs. 9-digit etc.)
  if (rNorm.includes(aNorm) || aNorm.includes(rNorm)) return true;

  return false;
}

/** Fuzzy name match: share at least one "significant" word (>2 chars). */
function namesShareWord(a: string, b: string): boolean {
  if (!a || !b) return false;
  const wordsA = a.toUpperCase().split(/\s+/).filter((w) => w.length > 2);
  const wordsB = b.toUpperCase().split(/\s+/).filter((w) => w.length > 2);
  return wordsA.some((w) => wordsB.includes(w)) || wordsB.some((w) => wordsA.includes(w));
}

export class CbeVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    const routeResult = routeCbe(payload);

    if (routeResult.route === 'NEEDS_INPUT' || routeResult.route === 'NEEDS_ACCOUNT') {
      return {
        status: 'INVALID_RECEIPT',
        amountExtracted: payload.amount || 0,
        message: routeResult.message || 'Invalid CBE reference format.',
      };
    }

    const registeredAccounts = payload.registeredAccounts || [];
    if (registeredAccounts.length === 0) {
      return {
        status: 'INVALID_RECEIPT',
        amountExtracted: 0,
        message: 'No registered CBE accounts found for this organization. Cannot verify.',
      };
    }

    // For RECEIPT_TOKEN routes, scan rawText for an FT reference to use as a fallback
    // when the v2 JSON API is unreachable or returns a non-JSON response (e.g. PDF, 502).
    // Primary pattern: FT + 8–14 alphanumeric chars (standard CBE FT references).
    // Secondary (looser) pattern: FT + exactly 10 chars — catches partial OCR reads.
    let fallbackRef: string | null = null;
    if (routeResult.route === 'RECEIPT_TOKEN') {
      const searchText = (payload.rawText ?? '') + ' ' + (payload.txnReference ?? '');
      const ftMatch =
        searchText.match(/\b(FT[A-Z0-9]{8,14})\b/i) ??
        searchText.match(/(FT[A-Z0-9]{10})/i);
      if (ftMatch) {
        fallbackRef = ftMatch[1].toUpperCase();
        logger.info(`[CbeVerifier] FT fallback reference found in OCR/token: ${fallbackRef}`);
      } else {
        logger.debug('[CbeVerifier] No FT fallback reference found in OCR text.');
      }
    }

    let lastError = 'Failed to verify CBE receipt against registered accounts.';
    let lastStatusCode = 400;

    // ── Parallel account lookup ───────────────────────────────────────────────
    // For the token path the reference is global (account-independent), so the
    // cbeCache de-duplicates parallel callers automatically.  For the FT/legacy
    // path each account number produces a distinct URL, so firing them all at
    // once with Promise.any saves one full upstream round-trip per extra account.
    const accountAttempts = registeredAccounts.map(async (account) => {
      const accountDigits = account.accountNumber.replace(/[^0-9]/g, '');

      let res = await verifyCBE(payload.txnReference, accountDigits);

      // If the v2 token path failed (not 404/503) and we have an FT fallback, retry legacy
      const tokenFailed = !res.success && routeResult.route === 'RECEIPT_TOKEN' && fallbackRef;
      const shouldFallback = tokenFailed && res.statusCode !== 404 && res.statusCode !== 503;
      if (shouldFallback) {
        logger.info(`[CbeVerifier] v2 token path failed (${res.statusCode}: ${res.error}); retrying with FT ref: ${fallbackRef}`);
        res = await verifyCBE(fallbackRef!, accountDigits);
      }

      if (!res.success) {
        const err = Object.assign(new Error(res.error || 'CBE lookup failed'), {
          statusCode: res.statusCode ?? 503,
          cbeResult: res,
        });
        throw err;
      }

      // Check account match so Promise.any selects the registered account that actually matches
      if (res.receiverAccount && !receiptAccountMatchesRegistered(res.receiverAccount, accountDigits)) {
        const err = Object.assign(
          new Error(`Payment was sent to ${res.receiverAccount}${res.receiver ? ` (${res.receiver})` : ''}, which does not match your registered business account.`),
          {
            statusCode: 400,
            isAccountMismatch: true,
            cbeResult: res,
          }
        );
        throw err;
      }

      return { res, account, accountDigits };
    });

    type AccountSuccess = {
      res: Awaited<ReturnType<typeof verifyCBE>>;
      account: typeof registeredAccounts[number];
      accountDigits: string;
    };

    let winner: AccountSuccess;
    try {
      winner = await (Promise as any).any(accountAttempts) as AccountSuccess;
    } catch (aggErr: any) {
      // All accounts failed — pick status from the errors list
      const errors: Array<{
        message?: string;
        statusCode?: number;
        isAccountMismatch?: boolean;
        cbeResult?: Awaited<ReturnType<typeof verifyCBE>>;
      }> = aggErr?.errors ?? [];

      // Check if this receipt was a verified bank transaction, but paid to someone else's account
      const mismatchErr = errors.find((e) => e.isAccountMismatch && e.cbeResult);
      if (mismatchErr && mismatchErr.cbeResult) {
        const cbeRes = mismatchErr.cbeResult;
        const receiverInfo = cbeRes.receiverAccount
          ? `${cbeRes.receiverAccount}${cbeRes.receiver ? ` (${cbeRes.receiver})` : ''}`
          : (cbeRes.receiver || 'another account');
        const regAcctsStr = registeredAccounts.map((a) => a.accountNumber).join(', ');

        return {
          status: 'INVALID_RECEIPT',
          amountExtracted: cbeRes.amount || 0,
          reference: cbeRes.reference || payload.txnReference,
          receiverAccount: receiverInfo,
          payerName: cbeRes.payer,
          date: cbeRes.date,
          message: `Wrong Receiver: Payment was sent to ${receiverInfo}, not to your registered account (${regAcctsStr}).`,
        };
      }

      for (const e of errors) {
        if (e.statusCode) {
          lastStatusCode = e.statusCode;
          lastError = e.message || e.cbeResult?.error || lastError;
        }
        if (e.statusCode === 404) {
          return { status: 'INVALID_RECEIPT', amountExtracted: 0, message: lastError };
        }
        if (e.statusCode === 503) {
          return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: lastError };
        }
      }
      if (lastStatusCode === 400 || lastStatusCode === 404) {
        return { status: 'INVALID_RECEIPT', amountExtracted: 0, message: lastError };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: lastError };
    }

    const { res, account, accountDigits } = winner;
    const receiverAccount = res.receiverAccount ?? '';

    if (receiverAccount && !receiptAccountMatchesRegistered(receiverAccount, accountDigits)) {
      const receiverInfo = res.receiverAccount
        ? `${res.receiverAccount}${res.receiver ? ` (${res.receiver})` : ''}`
        : 'another account';
      logger.warn(
        `[CbeVerifier] Receiver account mismatch: got "${receiverAccount}", expected "${account.accountNumber}"`
      );
      return {
        status: 'INVALID_RECEIPT',
        amountExtracted: res.amount || 0,
        reference: res.reference || payload.txnReference,
        receiverAccount: receiverInfo,
        payerName: res.payer,
        date: res.date,
        message: `Wrong Receiver: Payment was sent to ${receiverInfo}, not to your registered account (${account.accountNumber}).`,
      };
    }

    let warningMessage: string | undefined;
    if (res.receiver && account.accountHolderName && !namesShareWord(res.receiver, account.accountHolderName)) {
      warningMessage = `Warning: Receiver name on receipt ("${res.receiver}") does not closely match registered account holder ("${account.accountHolderName}").`;
      logger.warn(`[CbeVerifier] ${warningMessage}`);
    }

    return {
      status: 'VERIFIED',
      amountExtracted: res.amount || payload.amount || 0,
      payerName: res.payer || undefined,
      receiverAccount: receiverAccount || undefined,
      date: res.date || undefined,
      reference: res.reference || fallbackRef || payload.txnReference,
      message: warningMessage,
    };
  }
}
