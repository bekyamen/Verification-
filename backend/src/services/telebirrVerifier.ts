/**
 * telebirrVerifier.ts
 *
 * Standalone Telebirr provider verifier, extracted from verificationEngine.ts
 * for clarity. Implements the ProviderVerifier interface.
 */

import { ProviderVerifier, VerificationRequest, ProviderVerificationResult } from './verificationEngine';
import { verifyTelebirr } from './verifyTelebirr';
import logger from '../utils/logger';

/** Normalize an Ethiopian phone number to its 9-digit core (no prefix). */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('2519') || digits.startsWith('2517')) return digits.slice(3);
  if (digits.startsWith('09') || digits.startsWith('07')) return digits.slice(1);
  return digits;
}

/** Check if two phone strings refer to the same subscriber. */
function phonesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (na === nb) return true;

  function maskedFits(masked: string, full: string): boolean {
    const starIdx = masked.indexOf('*');
    if (starIdx === -1) return false;
    const prefix = normalizePhone(masked.slice(0, starIdx));
    const lastStarIdx = masked.lastIndexOf('*');
    const suffix = masked.slice(lastStarIdx + 1).replace(/\D/g, '');
    const fullNorm = full.replace(/\D/g, '');
    const prefixNorm = prefix.replace(/\D/g, '');
    const prefixOk = prefixNorm.length === 0 || fullNorm.startsWith(prefixNorm) || fullNorm.endsWith(prefixNorm);
    const suffixOk = suffix.length === 0 || fullNorm.endsWith(suffix);
    return prefixOk && suffixOk;
  }

  if (a.includes('*') && maskedFits(a, nb)) return true;
  if (b.includes('*') && maskedFits(b, na)) return true;

  const visibleA = a.replace(/\*/g, '').replace(/\D/g, '');
  const visibleB = b.replace(/\*/g, '').replace(/\D/g, '');
  if (visibleA && nb.endsWith(visibleA)) return true;
  if (visibleB && na.endsWith(visibleB)) return true;
  return false;
}

export class TelebirrVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    const registeredAccounts = payload.registeredAccounts || [];
    if (registeredAccounts.length === 0) {
      return {
        status: 'INVALID_RECEIPT',
        amountExtracted: 0,
        message: 'No registered Telebirr accounts found for this organization. Cannot verify.',
      };
    }

    if (!payload.txnReference) {
      return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Missing Telebirr transaction reference.' };
    }

    try {
      const res = await verifyTelebirr(payload.txnReference);
      if (!res) {
        return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: 'Telebirr verification returned no data.' };
      }

      // Try settledAmount first, then totalPaidAmount (some Telebirr page variants)
      const scrapedSettled = res.settledAmount ? parseFloat(res.settledAmount.replace(/,/g, '')) : 0;
      const scrapedTotal = res.totalPaidAmount ? parseFloat(res.totalPaidAmount.replace(/,/g, '')) : 0;
      const parsedAmount = scrapedSettled > 0 ? scrapedSettled : scrapedTotal;
      const receiverPhone = res.creditedPartyAccountNo;
      const receiverName = res.creditedPartyName;

      logger.info(
        `[TelebirrVerifier] scraped settledAmount="${res.settledAmount}" → parsedAmount=${parsedAmount}, ` +
        `totalPaidAmount="${res.totalPaidAmount}", payload.amount=${payload.amount}`
      );

      // ── Match receiver: phone → name → OCR phone → OCR name ──────────────
      let matchedAccount = registeredAccounts.find((acc) =>
        phonesMatch(receiverPhone, acc.accountNumber)
      );

      let matchedByName = false;
      if (!matchedAccount && receiverName) {
        const rWords = receiverName.toUpperCase().split(/\s+/).filter((w) => w.length > 1);
        matchedAccount = registeredAccounts.find((acc) => {
          if (!acc.accountHolderName) return false;
          const aWords = acc.accountHolderName.toUpperCase().split(/\s+/).filter((w) => w.length > 1);
          return rWords.some((w) => aWords.includes(w)) || aWords.some((w) => rWords.includes(w));
        });
        if (matchedAccount) matchedByName = true;
      }

      let matchedByOcr = false;
      if (!matchedAccount && payload.rawText) {
        const ocrDigits = payload.rawText.replace(/\D/g, '');
        matchedAccount = registeredAccounts.find((acc) => {
          const normalized = normalizePhone(acc.accountNumber);
          if (normalized.length >= 7 && ocrDigits.includes(normalized)) return true;
          const full = acc.accountNumber.replace(/\D/g, '');
          if (full.length >= 9 && ocrDigits.includes(full)) return true;
          return false;
        });
        if (matchedAccount) {
          matchedByOcr = true;
          logger.info(`[TelebirrVerifier] Matched account by phone in OCR text → ${matchedAccount.accountNumber}`);
        }
      }

      let matchedByOcrName = false;
      if (!matchedAccount && payload.rawText) {
        const ocrUpper = payload.rawText.toUpperCase();
        matchedAccount = registeredAccounts.find((acc) => {
          if (!acc.accountHolderName) return false;
          const aWords = acc.accountHolderName.toUpperCase().split(/\s+/).filter((w) => w.length > 2);
          return aWords.some((w) => ocrUpper.includes(w));
        });
        if (matchedAccount) {
          matchedByOcrName = true;
          logger.info(
            `[TelebirrVerifier] Matched account by holder name in OCR text → ${matchedAccount.accountNumber} (${matchedAccount.accountHolderName})`
          );
        }
      }

      if (!matchedAccount) {
        logger.warn(
          `[TelebirrVerifier] Receiver phone "${receiverPhone}" / name "${receiverName}" did not match any registered accounts: ` +
            registeredAccounts.map((a) => `${a.accountNumber} (${a.accountHolderName})`).join(', ')
        );
        return {
          status: 'INVALID_RECEIPT',
          amountExtracted: 0,
          message: receiverPhone
            ? `Receiver account mismatch. Receipt shows phone ${receiverPhone} which did not match any registered Telebirr account.`
            : receiverName
            ? `Receiver account mismatch. Receipt shows receiver name "${receiverName}" which did not match any registered account holder.`
            : 'Receiver account mismatch. Receipt did not contain a recognisable receiver phone or name.',
        };
      }

      if (matchedByName) {
        logger.info(`[TelebirrVerifier] Matched account by receiver name "${receiverName}" → ${matchedAccount.accountNumber}`);
      }
      if (matchedByOcr) {
        logger.info(`[TelebirrVerifier] Matched account via OCR text phone scan → ${matchedAccount.accountNumber}`);
      }
      if (matchedByOcrName) {
        logger.info(`[TelebirrVerifier] Matched account via OCR text name scan → ${matchedAccount.accountNumber} (${matchedAccount.accountHolderName})`);
      }

      let warningMessage: string | undefined;
      if (res.creditedPartyName && matchedAccount.accountHolderName) {
        const rName = res.creditedPartyName.toUpperCase();
        const aName = matchedAccount.accountHolderName.toUpperCase();
        const rWords = rName.split(/\s+/).filter((w) => w.length > 2);
        const aWords = aName.split(/\s+/).filter((w) => w.length > 2);
        const sharesName = rWords.some((w) => aWords.includes(w)) || aWords.some((w) => rWords.includes(w));
        if (!sharesName) {
          warningMessage = `Warning: Receiver name on receipt ("${res.creditedPartyName}") does not closely match registered account holder ("${matchedAccount.accountHolderName}").`;
          logger.warn(`[TelebirrVerifier] ${warningMessage}`);
        }
      }

      return {
        status: 'VERIFIED',
        amountExtracted: parsedAmount > 0 ? parsedAmount : (payload.amount || 0),
        payerName: res.payerName || undefined,
        receiverAccount: receiverPhone || undefined,
        date: res.paymentDate ? new Date(res.paymentDate) : undefined,
        reference: res.receiptNo || payload.txnReference,
        message: warningMessage,
      };
    } catch (e: any) {
      // ── api.check.et confirmed previously verified ─────────────────────────
      if (e.isAlreadyVerified) {
        const finalAmount = (e.alreadyVerifiedAmount as number | undefined) || payload.amount || 0;
        logger.info(
          `[TelebirrVerifier] ✅ Ref '${payload.txnReference}' accepted: api.check.et previously verified. Amount = ${finalAmount}`
        );
        return {
          status: 'VERIFIED',
          amountExtracted: finalAmount,
          payerName: payload.payerName,
          reference: payload.txnReference,
          message:
            'Payment confirmed by api.check.et (previously verified). ' +
            (e.alreadyVerifiedAmount
              ? 'Amount sourced from verification service.'
              : 'Amount sourced from receipt/OCR.'),
        };
      }

      // ── Auth / rate-limit ──────────────────────────────────────────────────
      if (e.isAuthError || e.isRateLimited) {
        return {
          status: 'FAILED_UPSTREAM',
          amountExtracted: 0,
          message: e.isRateLimited
            ? 'Verification service rate limit reached. Please retry shortly.'
            : 'Verification service credentials rejected.',
        };
      }

      // ── Transaction not found ──────────────────────────────────────────────
      const isNotFound =
        e.statusCode === 404 ||
        e.statusCode === 400 ||
        (e.message && e.message.toLowerCase().includes('not found'));

      if (isNotFound) {
        const hasImageProof = !!payload.receiptImageUrl;
        const ocrAmount = payload.amount || 0;

        if (hasImageProof && ocrAmount > 0) {
          return {
            status: 'VERIFIED',
            amountExtracted: ocrAmount,
            payerName: payload.payerName,
            reference: payload.txnReference,
            message:
              `Verified via uploaded receipt image (OCR). External API could not find ref '${payload.txnReference}' ` +
              `— may be a merchant or B2B transfer. Image stored as audit proof.`,
          };
        }

        if (hasImageProof) {
          return {
            status: 'INVALID_RECEIPT',
            amountExtracted: 0,
            message:
              `Could not auto-verify transaction '${payload.txnReference}' from image. ` +
              `The receipt was scanned but the amount could not be read clearly. ` +
              `Try entering the amount manually or ask the payer to share the Telebirr app receipt link.`,
          };
        }

        return {
          status: 'INVALID_RECEIPT',
          amountExtracted: 0,
          message: e.message || 'Transaction not found or invalid Telebirr reference.',
        };
      }

      // ── Network blocked (firewall / ISP / TCP timeout) ────────────────────
      if (e.isNetworkBlocked) {
        return {
          status: 'FAILED_UPSTREAM',
          amountExtracted: 0,
          message:
            `Cannot reach Telebirr servers from this network (${e.message.split('(')[1]?.split(')')[0] ?? 'ETIMEDOUT'}). ` +
            `Make sure the server has outbound access to transactioninfo.ethiotelecom.et:443. ` +
            `If you are testing locally, use the deployed server instead.`,
        };
      }

      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: e.message || 'Telebirr verification failed.' };
    }
  }
}
