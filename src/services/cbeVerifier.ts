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

  const rNorm = normalizeCbeAccount(receiptAccount);
  const aNorm = normalizeCbeAccount(registeredAccount);

  // Exact match after normalization
  if (rNorm === aNorm) return true;

  // One contains the other (covers partial 13-digit vs. 9-digit etc.)
  if (rNorm.includes(aNorm) || aNorm.includes(rNorm)) return true;

  // Masked receipt account: "***6789" — check trailing digits
  const visibleDigits = receiptAccount.replace(/\*/g, '').replace(/\D/g, '');
  if (visibleDigits && (aNorm.endsWith(visibleDigits) || rNorm.endsWith(visibleDigits))) return true;

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
    let fallbackRef: string | null = null;
    if (routeResult.route === 'RECEIPT_TOKEN') {
      const searchText = (payload.rawText ?? '') + ' ' + (payload.txnReference ?? '');
      const ftMatch = searchText.match(/\b(FT[A-Z0-9]{8,14})\b/i);
      if (ftMatch) {
        fallbackRef = ftMatch[1].toUpperCase();
        logger.debug(`[CbeVerifier] FT fallback reference found: ${fallbackRef}`);
      }
    }

    let lastError = 'Failed to verify CBE receipt against registered accounts.';
    let lastStatusCode = 400;

    for (const account of registeredAccounts) {
      const accountDigits = account.accountNumber.replace(/[^0-9]/g, '');

      try {
        let res = await verifyCBE(payload.txnReference, accountDigits);

        // If the v2 token path failed for any reason other than "not found" or "auth",
        // and we have a raw FT reference from the OCR text, retry via the legacy FT path.
        const tokenFailed = !res.success && routeResult.route === 'RECEIPT_TOKEN' && fallbackRef;
        const shouldFallback = tokenFailed && res.statusCode !== 404 && res.statusCode !== 503;
        if (shouldFallback) {
          logger.info(`[CbeVerifier] v2 token path failed (${res.statusCode}: ${res.error}); retrying with FT ref: ${fallbackRef}`);
          res = await verifyCBE(fallbackRef!, accountDigits);
        }

        if (res.success) {
          const receiverAccount = res.receiverAccount ?? '';

          if (
            receiverAccount &&
            !receiptAccountMatchesRegistered(receiverAccount, accountDigits)
          ) {
            logger.warn(
              `[CbeVerifier] Receiver account mismatch: got "${receiverAccount}", expected "${account.accountNumber}"`
            );
            return {
              status: 'INVALID_RECEIPT',
              amountExtracted: 0,
              message: `Receiver account mismatch. Expected ${account.accountNumber} but receipt shows ${receiverAccount}.`,
            };
          }

          let warningMessage: string | undefined;
          if (
            res.receiver &&
            account.accountHolderName &&
            !namesShareWord(res.receiver, account.accountHolderName)
          ) {
            warningMessage = `Warning: Receiver name on receipt ("${res.receiver}") does not closely match registered account holder ("${account.accountHolderName}").`;
            logger.warn(`[CbeVerifier] ${warningMessage}`);
          }

          const resolvedRef =
            res.reference ||
            fallbackRef ||
            payload.txnReference;

          return {
            status: 'VERIFIED',
            amountExtracted: res.amount || payload.amount || 0,
            payerName: res.payer || undefined,
            receiverAccount: receiverAccount || undefined,
            date: res.date || undefined,
            reference: resolvedRef,
            message: warningMessage,
          };
        }

        lastError = res.error || lastError;
        lastStatusCode = res.statusCode ?? 503;

        // 404 = reference doesn't exist — no point trying other accounts
        if (res.statusCode === 404) {
          return { status: 'INVALID_RECEIPT', amountExtracted: 0, message: res.error };
        }

        // 503 = upstream unreachable — stop immediately
        if (res.statusCode === 503) {
          return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: res.error };
        }
      } catch (e: any) {
        logger.error(`[CbeVerifier] Unexpected error: ${e.message}`);
        lastError = e.message;
      }
    }

    if (lastStatusCode === 400 || lastStatusCode === 404) {
      return { status: 'INVALID_RECEIPT', amountExtracted: 0, message: lastError };
    }
    return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: lastError };
  }
}
