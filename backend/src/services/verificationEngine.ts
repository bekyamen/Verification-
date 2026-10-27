import { Provider } from '@prisma/client';
import { NormalizedPayload } from './linkDissector';
import { verifyCBE } from './verifyCBE';
import { verifyDashen } from './verifyDashen';
import { verifyAbyssinia } from './verifyAbyssinia';
import { verifyCBEBirr } from './verifyCBEBirr';
import { verifyMpesa } from './verifyMpesa';
import logger from '../utils/logger';
import { TelebirrVerifier } from './telebirrVerifier';

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

  // Handle masked phones where middle digits are hidden, e.g. "2519****1087"
  // Strategy: split on the mask block, normalize prefix + suffix, then check
  // that the other number starts with the prefix and ends with the suffix.
  function maskedFits(masked: string, full: string): boolean {
    const starIdx = masked.indexOf('*');
    if (starIdx === -1) return false;
    // prefix digits before the first '*'
    const prefix = normalizePhone(masked.slice(0, starIdx));
    // suffix digits after the last '*'
    const lastStarIdx = masked.lastIndexOf('*');
    const suffix = masked.slice(lastStarIdx + 1).replace(/\D/g, '');
    // full must start-with (normalized) prefix digits and end-with suffix digits
    const fullNorm = full.replace(/\D/g, '');
    const prefixNorm = prefix.replace(/\D/g, '');
    const prefixOk = prefixNorm.length === 0 || fullNorm.startsWith(prefixNorm) || fullNorm.endsWith(prefixNorm);
    const suffixOk = suffix.length === 0 || fullNorm.endsWith(suffix);
    return prefixOk && suffixOk;
  }

  if (a.includes('*') && maskedFits(a, nb)) return true;
  if (b.includes('*') && maskedFits(b, na)) return true;

  // Legacy fallback: trailing-digit match (e.g. "*****6789")
  const visibleA = a.replace(/\*/g, '').replace(/\D/g, '');
  const visibleB = b.replace(/\*/g, '').replace(/\D/g, '');
  if (visibleA && nb.endsWith(visibleA)) return true;
  if (visibleB && na.endsWith(visibleB)) return true;
  return false;
}

export interface VerificationRequest extends NormalizedPayload {
  branchId: string;
  cashierId: string;
  expectedAmount?: number;
  rawText?: string;
  receiptUrl?: string;
  receiptImageUrl?: string;
  printedDate?: Date;
  expectedReceiverAccount?: string;
  registeredAccounts?: import('@prisma/client').BankSettlementAccount[];
}

export interface ProviderVerificationResult {
  status: 'VERIFIED' | 'FAILED_UPSTREAM' | 'INVALID_RECEIPT' | 'AMOUNT_MISMATCH' | 'NEEDS_SUFFIX' | 'NEEDS_INPUT';
  amountExtracted: number;
  payerName?: string;
  message?: string;
  code?: string;
  receiverAccount?: string;
  date?: Date;
  reference?: string;
}

export interface ProviderVerifier {
  verify(payload: VerificationRequest): Promise<ProviderVerificationResult>;
}

import { CbeVerifier } from './cbeVerifier';

// 3. Dashen
export class DashenVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference) {
       return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Missing Dashen reference' };
    }
    try {
      const res = await verifyDashen(payload.txnReference);
      if (res.success) {
         return { status: 'VERIFIED', amountExtracted: res.transactionAmount || payload.amount || 0, payerName: res.senderName };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: res.error };
    } catch (e: any) {
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: e.message };
    }
  }
}

// 4. Awash
export class AwashVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference || !/^AW[A-Z0-9]{8,14}$/i.test(payload.txnReference)) {
      return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Invalid Awash reference format' };
    }
    return { status: 'VERIFIED', amountExtracted: payload.amount || (payload.expectedAmount || 1) };
  }
}

// 5. BOA
export class BoaVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference) {
      return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Missing BOA reference' };
    }
    const suffix = payload.senderAccount ? payload.senderAccount.slice(-5) : undefined;
    try {
      const res = await verifyAbyssinia(payload.txnReference, suffix || '00000');
      if (res.success) {
         return { status: 'VERIFIED', amountExtracted: res.amount || payload.amount || 0, payerName: res.payer };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: res.error };
    } catch (e: any) {
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: e.message };
    }
  }
}

// 6. Zemen
export class ZemenVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference) {
       return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Missing Zemen reference' };
    }
    return { status: 'VERIFIED', amountExtracted: payload.amount || (payload.expectedAmount || 1) };
  }
}

// 7. CBE Birr
export class CbeBirrVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference) {
       return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Missing CBE Birr reference' };
    }
    try {
      const res = await verifyCBEBirr(payload.txnReference, payload.payerPhone || '');
      if (!('error' in res)) {
         return { status: 'VERIFIED', amountExtracted: payload.amount || 0 };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: res.error as string };
    } catch (e: any) {
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: e.message };
    }
  }
}

// 8. Mpesa
export class MpesaVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference) {
       return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Missing M-Pesa reference' };
    }
    try {
      const res = await verifyMpesa(payload.txnReference);
      if (res.success) {
         return { status: 'VERIFIED', amountExtracted: res.amount || payload.amount || 0, payerName: res.payerName };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: res.error };
    } catch (e: any) {
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: e.message };
    }
  }
}

// 9. Siinqee
export class SiinqeeVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference) {
       return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Siinqee reference code required for internal indexing' };
    }
    if (!payload.receiptImageUrl && !payload.receiptUrl) {
       return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Siinqee requires visual proof via URL or Image for manual logging' };
    }
    return { status: 'VERIFIED', amountExtracted: payload.amount || (payload.expectedAmount || 1) };
  }
}

// Universal Registry — only CBE and Telebirr have active verifiers.
// All other providers are set to null; the service will return INVALID_RECEIPT for them.
export const verifierRegistry: Record<Provider, ProviderVerifier | null> = {
  CBE: new CbeVerifier(),
  TELEBIRR: new TelebirrVerifier(),
  DASHEN: null,
  AWASH: null,
  BOA: null,
  ZEMEN: null,
  CBE_BIRR: null,
  MPESA: null,
  SIINQEE: null,
  OTHER: null,
  UNKNOWN: null
};
