import { Provider } from '@prisma/client';
import { NormalizedPayload } from './linkDissector';
import { verifyCBE } from './verifyCBE';
import { verifyTelebirr } from './verifyTelebirr';
import { verifyDashen } from './verifyDashen';
import { verifyAbyssinia } from './verifyAbyssinia';
import { verifyCBEBirr } from './verifyCBEBirr';
import { verifyMpesa } from './verifyMpesa';

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

export class TelebirrVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    const registeredAccounts = payload.registeredAccounts || [];
    if (registeredAccounts.length === 0) {
        return {
            status: 'INVALID_RECEIPT',
            amountExtracted: 0,
            message: 'No registered Telebirr accounts found for this organization. Cannot verify.'
        };
    }

    const isUrl = payload.txnReference && (payload.txnReference.startsWith('http://') || payload.txnReference.startsWith('https://'));
    if (!payload.txnReference || (!isUrl && !/^[A-Z0-9]{8,25}$/i.test(payload.txnReference))) {
       return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Invalid Telebirr reference format' };
    }
    
    try {
      const res = await verifyTelebirr(payload.txnReference);
      if (res) {
         const parsedAmount = res.settledAmount ? parseFloat(res.settledAmount.replace(/,/g, '')) : 0;
         const receiverPhone = res.creditedPartyAccountNo;
         
         // Try to find a matching registered account
         let matchedAccount: typeof registeredAccounts[0] | undefined;
         const escapedReceiver = receiverPhone.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
         // We do not anchor with ^ and $ for phones because of +251, 251, 0 prefixes
         const maskRegex = new RegExp(escapedReceiver.replace(/\*/g, '.*'), 'i');

         for (const acc of registeredAccounts) {
             const accountDigits = acc.accountNumber;
             const expectedPhoneSafe = accountDigits.slice(-9); // standard format without prefix
             const receivedPhoneSafe = receiverPhone.slice(-9);

             if (
                 receivedPhoneSafe.includes(expectedPhoneSafe) || 
                 expectedPhoneSafe.includes(receivedPhoneSafe) || 
                 maskRegex.test(accountDigits) ||
                 maskRegex.test(expectedPhoneSafe)
             ) {
                 matchedAccount = acc;
                 break;
             }
         }

         if (!matchedAccount) {
             return {
                 status: 'INVALID_RECEIPT',
                 amountExtracted: 0,
                 message: `Receiver account mismatch. Received phone ${receiverPhone} did not match any registered Telebirr accounts.`
             };
         }

         let warningMessage: string | undefined;
         const rName = (res.creditedPartyName || '').toUpperCase();
         const aName = matchedAccount.accountHolderName.toUpperCase();
         const rWords = rName.split(/\s+/).filter((w: string) => w.length > 2);
         const aWords = aName.split(/\s+/).filter((w: string) => w.length > 2);
         const sharesName = rWords.some((w: string) => aWords.includes(w)) || aWords.some((w: string) => rWords.includes(w));
         
         if (!sharesName && rName && aName) {
             warningMessage = `Warning: Receiver name on receipt (${res.creditedPartyName}) does not closely match registered account holder (${matchedAccount.accountHolderName}).`;
         }

         return {
            status: 'VERIFIED',
            amountExtracted: parsedAmount > 0 ? parsedAmount : (payload.amount || 0),
            payerName: res.payerName,
            receiverAccount: res.creditedPartyAccountNo,
            message: warningMessage
         };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: 'Telebirr scraping failed' };
    } catch (e: any) {
      const isNotFound = e.statusCode === 404 || e.statusCode === 400 || (e.message && e.message.toLowerCase().includes('not found'));
      if (isNotFound) {
          return { status: 'INVALID_RECEIPT', amountExtracted: 0, message: e.message || 'Telebirr scraping failed' };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: e.message || 'Telebirr scraping failed' };
    }
  }
}

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

// Universal Registry
export const verifierRegistry: Record<Provider, ProviderVerifier | null> = {
  CBE: new CbeVerifier(),
  TELEBIRR: new TelebirrVerifier(),
  DASHEN: new DashenVerifier(),
  AWASH: new AwashVerifier(),
  BOA: new BoaVerifier(),
  ZEMEN: new ZemenVerifier(),
  CBE_BIRR: new CbeBirrVerifier(),
  MPESA: new MpesaVerifier(),
  SIINQEE: new SiinqeeVerifier(),
  OTHER: null,
  UNKNOWN: null
};
