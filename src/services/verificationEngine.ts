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
}

export interface ProviderVerificationResult {
  status: 'VERIFIED' | 'FAILED_UPSTREAM' | 'INVALID_RECEIPT' | 'AMOUNT_MISMATCH' | 'NEEDS_SUFFIX';
  amountExtracted: number;
  payerName?: string;
  message?: string;
  receiverAccount?: string;
  date?: Date;
}

export interface ProviderVerifier {
  verify(payload: VerificationRequest): Promise<ProviderVerificationResult>;
}

// 1. CBE
export class CbeVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference) {
      return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Invalid CBE FT Reference format' };
    }
    
    let suffix = payload.receivingAccount && payload.receivingAccount.length >= 8 
                 ? payload.receivingAccount.slice(-8) 
                 : undefined;
                 
    // Look for embedded CBE receipt URL token in either rawText or receiptUrl
    const embeddedTokenMatch = (payload.rawText || '').match(/https?:\/\/(?:mbreciept|mbreceipt)\.cbe\.com\.et\/([A-Za-z0-9-]+)/i) 
                            || (payload.receiptUrl || '').match(/https?:\/\/(?:mbreciept|mbreceipt)\.cbe\.com\.et\/([A-Za-z0-9-]+)/i);
    const referenceToVerify = embeddedTokenMatch ? embeddedTokenMatch[1] : payload.txnReference;

    const isToken = !!embeddedTokenMatch || referenceToVerify.length > 20;

    if (!isToken && !suffix) {
        return { 
           status: 'NEEDS_SUFFIX', 
           amountExtracted: payload.amount || 0, 
           message: 'Legacy CBE FT reference requires the last 8 digits of the receiver account. Please enter manually.' 
        };
    }

    try {
      const res = await verifyCBE(referenceToVerify, suffix);
      if (res.success) {
         return {
            status: 'VERIFIED',
            amountExtracted: res.amount || payload.amount || 0,
            payerName: res.payer || undefined,
            receiverAccount: res.receiverAccount || undefined,
            date: res.date || undefined
         };
      }
      if (res.statusCode === 400 && res.error?.includes('8-digit')) {
         return { status: 'NEEDS_SUFFIX', amountExtracted: 0, message: res.error };
      }
      if (res.statusCode === 400 || res.statusCode === 404) {
         return { status: 'INVALID_RECEIPT', amountExtracted: 0, message: res.error };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: res.error };
    } catch (e: any) {
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: e.message };
    }
  }
}

// 2. Telebirr
export class TelebirrVerifier implements ProviderVerifier {
  async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
    if (!payload.txnReference || !/^[A-Z0-9]{8,14}$/i.test(payload.txnReference)) {
       return { status: 'INVALID_RECEIPT', amountExtracted: payload.amount || 0, message: 'Invalid Telebirr reference format' };
    }
    try {
      const res = await verifyTelebirr(payload.txnReference);
      if (res) {
         return {
            status: 'VERIFIED',
            amountExtracted: res.settledAmount ? parseFloat(res.settledAmount.replace(/,/g, '')) : (payload.amount || 0),
            payerName: res.payerName,
            receiverAccount: res.creditedPartyAccountNo
         };
      }
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: 'Telebirr scraping failed' };
    } catch (e: any) {
      return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: e.message };
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
