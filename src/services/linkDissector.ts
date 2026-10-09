import { Provider } from '@prisma/client';

export interface NormalizedPayload {
  provider: Provider;
  txnReference: string;
  receivingAccount?: string;
  senderAccount?: string;
  payerPhone?: string;
  amount?: number;
  printedDate?: Date;
  payerName?: string;
}


export const dissectPayload = (input: string): NormalizedPayload => {
  const text = input.trim();
  let normalized: Partial<NormalizedPayload> = {
    provider: 'UNKNOWN'
  };

  // 1. Look for CBE Token URL directly in text (from QR code or raw input)
  const embeddedTokenMatch = text.match(/https?:\/\/(?:mbreciept|mbreceipt)\.cbe\.com\.et\/([A-Za-z0-9-]+)/i);
  if (embeddedTokenMatch) {
      normalized.provider = 'CBE';
      normalized.txnReference = embeddedTokenMatch[1];
  }

  try {
    if (text.startsWith('http://') || text.startsWith('https://')) {
      const parsedUrl = new URL(text);
      const urlText = parsedUrl.href.toLowerCase();
      
      if (!embeddedTokenMatch && (urlText.includes('apps.cbe.com.et') || urlText.includes('mbreceipt.cbe.com.et') || urlText.includes('mbreciept.cbe.com.et'))) {
        normalized.provider = 'CBE';
        normalized.txnReference = parsedUrl.searchParams.get('ref') || parsedUrl.searchParams.get('txnId') || '';
        normalized.receivingAccount = parsedUrl.searchParams.get('account') || parsedUrl.searchParams.get('to') || undefined;
      }
      else if (urlText.includes('telebirr') || urlText.includes('ethiotelecom.et')) {
        normalized.provider = 'TELEBIRR';
        normalized.txnReference = parsedUrl.searchParams.get('txId') || parsedUrl.searchParams.get('id') || text;
      }
      else if (urlText.includes('dashen')) {
        normalized.provider = 'DASHEN';
        normalized.txnReference = parsedUrl.searchParams.get('ref') || '';
      }
      else if (urlText.includes('awashpay.com')) {
        normalized.provider = 'AWASH';
        normalized.txnReference = parsedUrl.searchParams.get('ref') || '';
      }
      else if (urlText.includes('boa') || urlText.includes('abyssinia')) {
        normalized.provider = 'BOA';
        normalized.txnReference = parsedUrl.searchParams.get('ref') || parsedUrl.searchParams.get('txn') || '';
        normalized.senderAccount = parsedUrl.searchParams.get('sender') || undefined;
      }
      else if (urlText.includes('zemen')) {
        normalized.provider = 'ZEMEN';
        normalized.txnReference = parsedUrl.searchParams.get('ref') || '';
      }
      else if (urlText.includes('mpesa') || urlText.includes('safaricom')) {
        normalized.provider = 'MPESA';
        normalized.txnReference = parsedUrl.searchParams.get('ref') || '';
      }
      
      if (normalized.provider !== 'UNKNOWN' && normalized.txnReference) {
        if (!text.includes('\n')) {
            return normalized as NormalizedPayload;
        }
      }
    }
  } catch (e) {
    // Ignore URL parse errors
  }

  const upperText = text.toUpperCase();
  const rawCleanText = text.replace(/\s+/g, ' ');

  // Date parsing heuristic
  const dateMatch = rawCleanText.match(/(?:Date|Time|Date & Time)\s*:?\s*([\d\/-]+(?:\s+[\d:]+(?:\s*[APM]{2})?)?)/i) || 
                    rawCleanText.match(/([\d]{2}\/[\d]{2}\/[\d]{4}\s+[\d]{2}:[\d]{2}(?::[\d]{2})?)/);
  if (dateMatch && dateMatch[1]) {
     const pDate = new Date(dateMatch[1]);
     if (!isNaN(pDate.getTime())) {
         normalized.printedDate = pDate;
     }
  }

  // Amount parsing heuristic (Look for Transferred Amount first to avoid fee)
  const amountMatch = rawCleanText.match(/(?:Transferred\s*Amount|Amount\s*Transferred)\s*:?\s*ETB\s*([\d,]+(?:\.\d{1,2})?)/i) || 
                      rawCleanText.match(/(?:Transferred\s*Amount|Amount\s*Transferred)\s*:?\s*([\d,]+(?:\.\d{1,2})?)/i) ||
                      rawCleanText.match(/(?:ETB|BIRR|AMOUNT|PAID)[:\s]*([\d,]+(?:\.\d{1,2})?)/i) || 
                      rawCleanText.match(/([\d,]+(?:\.\d{1,2})?)[\s]*(?:ETB|BIRR)/i);
  if (amountMatch && amountMatch[1]) {
     const parsedAmount = parseFloat(amountMatch[1].replace(/,/g, ''));
     if (!isNaN(parsedAmount)) {
         normalized.amount = parsedAmount;
     }
  }

  const accountPattern = /(?:Payer|Sender)[^\n]*?(?:Account\s*:?\s*[A-Z0-9*]*(\d{4}))/i;
  let payerAccMatch = rawCleanText.match(accountPattern);
  if (!payerAccMatch) {
       payerAccMatch = rawCleanText.match(/(?:Payer|Sender)[^\n]*?(?:[A-Z0-9*]+(\d{4}))\b/i);
  }
  if (payerAccMatch) {
      normalized.senderAccount = payerAccMatch[1];
  }

  const recPattern = /(?:Receiver|Beneficiary)[^\n]*?(?:Account\s*:?\s*[A-Z0-9*]*(\d{4}))/i;
  let recAccMatch = rawCleanText.match(recPattern);
  if (!recAccMatch) {
       recAccMatch = rawCleanText.match(/(?:Receiver|Beneficiary)[^\n]*?(?:[A-Z0-9*]+(\d{4}))\b/i);
  }
  if (recAccMatch) {
      if (!normalized.receivingAccount) {
         normalized.receivingAccount = recAccMatch[1];
      }
  }

  // App/SMS Message fallback for missing fields
  // e.g. ETB 500.00 debited from AHIMED NUREDIN KELIFA for BEREKET TEREFE AYELE-ETB-9374 on 12-Jan-2025
  const smsMatch = rawCleanText.match(/debited from (.*?) for (.*?)[-\s]+(?:ETB|CBE)-*(\d{4})(?:\s+on\s+([\d-a-zA-Z\s:,]+?))?(?=\s+with\b|\s+ID\b|\.|$)/i);
  if (smsMatch) {
      if (!normalized.payerName) normalized.payerName = smsMatch[1].trim();
      if (!normalized.receivingAccount) normalized.receivingAccount = smsMatch[3];
      if (!normalized.printedDate && smsMatch[4]) {
         const pDate = new Date(smsMatch[4]);
         if (!isNaN(pDate.getTime())) normalized.printedDate = pDate;
      }
  }

  // Awash Specific
  const awashMatch = upperText.match(/\b(AW[A-Z0-9]{8,14})\b/);
  if (awashMatch || upperText.includes('AWASH')) {
    normalized.provider = 'AWASH';
    if (!normalized.txnReference) normalized.txnReference = awashMatch ? awashMatch[1] : extractGenericRef(upperText);
    return normalized as NormalizedPayload;
  }

  // CBE / CBE_BIRR
  if (upperText.includes('CBE BIRR') || upperText.includes('CBEBIRR')) {
    normalized.provider = 'CBE_BIRR';
    if (!normalized.txnReference) normalized.txnReference = extractGenericRef(upperText);
    normalized.payerPhone = (upperText.match(/251[79]\d{8}/))?.[0] || undefined;
    return normalized as NormalizedPayload;
  }
  
  if (normalized.provider === 'CBE' || upperText.includes('CBE') || upperText.includes('COMMERCIAL BANK')) {
    normalized.provider = 'CBE';
    const cbeRefMatch = upperText.match(/\b(FT[A-Z0-9]{8,14})\b/);
    if (!normalized.txnReference) {
      normalized.txnReference = cbeRefMatch ? cbeRefMatch[1] : extractGenericRef(upperText);
    }
    if (!normalized.receivingAccount) {
        normalized.receivingAccount = (upperText.match(/\b(1000\d{9}|100\d{8,11})\b/))?.[0] || undefined;
    }
    return normalized as NormalizedPayload;
  }

  if (upperText.includes('TELEBIRR') || upperText.includes('ETHIO TELECOM') || upperText.includes('TRANSACTION TO') || upperText.includes('TRANSFER MONEY') || upperText.includes('TRANSACTION NUMBER')) {
    normalized.provider = 'TELEBIRR';
    if (!normalized.txnReference) normalized.txnReference = extractGenericRef(upperText);
    return normalized as NormalizedPayload;
  }

  if (upperText.includes('BOA') || upperText.includes('ABYSSINIA')) {
    normalized.provider = 'BOA';
    if (!normalized.txnReference) normalized.txnReference = (upperText.match(/\b(FT[A-Z0-9]{8,14})\b/))?.[0] || extractGenericRef(upperText);
    return normalized as NormalizedPayload;
  }
  
  if (upperText.includes('DASHEN')) {
    normalized.provider = 'DASHEN';
    if (!normalized.txnReference) normalized.txnReference = extractGenericRef(upperText);
    return normalized as NormalizedPayload;
  }

  if (upperText.includes('ZEMEN')) {
    normalized.provider = 'ZEMEN';
    if (!normalized.txnReference) normalized.txnReference = extractGenericRef(upperText);
    return normalized as NormalizedPayload;
  }
  
  if (upperText.includes('M-PESA') || upperText.includes('MPESA') || upperText.includes('SAFARICOM')) {
    normalized.provider = 'MPESA';
    if (!normalized.txnReference) normalized.txnReference = extractGenericRef(upperText);
    return normalized as NormalizedPayload;
  }

  if (upperText.includes('SIINQEE')) {
    normalized.provider = 'SIINQEE';
    if (!normalized.txnReference) normalized.txnReference = extractGenericRef(upperText);
    return normalized as NormalizedPayload;
  }

  if (!normalized.txnReference) normalized.txnReference = extractGenericRef(upperText);
  return normalized as NormalizedPayload;
};

const STOP_WORDS = new Set([
  'RECEIPT', 'SUCCESS', 'TRANSACTION', 'AMOUNT', 'COMPLETED', 
  'SUMMARY', 'DEBITED', 'CREDITED', 'COMMERCIAL', 'ETHIOPIA', 
  'BRANCH', 'TRANSFER', 'REASON', 'SERVICE', 'CHARGE', 'DISASTER'
]);

function extractGenericRef(text: string): string {
    const rx = /\b([A-Z0-9]{6,16})\b/g;
    let match;
    const candidates = [];
    
    while ((match = rx.exec(text)) !== null) {
        const word = match[1];
        // Strict safety check: Transaction references in Ethiopia are virtually always Alphanumeric.
        // It MUST contain at least one digit AND at least one letter. 
        // This completely prevents it from accidentally picking up normal English words like "COMPANY".
        if (/[0-9]/.test(word) && /[A-Z]/.test(word)) {
           candidates.push(word);
        }
    }
    
    if (candidates.length > 0) return candidates[0];
    
    return '';
}
