import axios from 'axios';
import logger from '../utils/logger';

export interface VerifyResult {
  success: boolean;
  payer?: string;
  payerAccount?: string;
  receiver?: string;
  receiverAccount?: string;
  amount?: number;
  date?: Date;
  reference?: string;
  reason?: string | null;
  error?: string;
  statusCode?: number;
}

const CHECK_URL = 'https://api.check.et/api/v1/verify';
const RECEIPT_TOKEN = /^v2-[A-Za-z0-9]+$/i;      // token from the QR: https://mbreciept.cbe.com.et/<token>
const FT_REF = /^FT\d{5}[A-Z0-9]{5}$/i;
const ACCOUNT_LENGTH = 13;

const pick = (o: any, keys: string[]) => {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};
const toNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};
const toDate = (v: unknown): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? undefined : d;          // NEVER default to "now"
};


/**
 * reference: a receipt URL, a QR token (v2-...), or an FT reference.
 * accountNumber: the FULL 13-digit receiving account (required for FT references only).
 */

export async function verifyCBE(reference: string, accountNumber?: string): Promise<VerifyResult> {
  const apiKey = process.env.CHECK_API_KEY;
  if (!apiKey) {
    logger.error('CHECK_API_KEY is not set');
    return { success: false, error: 'Verification service is not configured.', statusCode: 503 };
  }

  const ref = reference.trim();
  const body: Record<string, string> = { bank: 'cbe' };


  if (/^https?:\/\//i.test(ref)) {
    body.receipt_url = ref;
  } else if (RECEIPT_TOKEN.test(ref)) {
    body.receipt_url = `https://mbreciept.cbe.com.et/${ref}`;
  } else if (FT_REF.test(ref)) {
    const acct = (accountNumber ?? '').replace(/\D/g, '');
    if (acct.length !== ACCOUNT_LENGTH) {
      return { success: false, error: `A full ${ACCOUNT_LENGTH}-digit receiver account is required.`, statusCode: 400 };
    }
    body.transaction_number = ref.toUpperCase();
    body.account_number = acct;
  } else {
    return { success: false, error: 'Unrecognised CBE reference.', statusCode: 400 };
  }

  try {
    logger.info(`Forwarding CBE verification to api.check.et (${body.receipt_url ? 'receipt_url' : 'reference+account'})`);
    const { data } = await axios.post(CHECK_URL, body, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      timeout: 30000
    });

    // TEMPORARY: log one real response per receipt type, then pin the exact field names below.
    if (process.env.LOG_CHECK_RAW === '1') logger.info(`[check.et raw] ${JSON.stringify(data)}`);

    const root = data?.data ?? data;
    const d = { ...(root?.raw || {}), ...(root?.receipt || {}), ...(root || {}) };

    // A 2xx is not proof of a valid payment: honour the API's own verdict.
    if (data?.success === false || data?.verified === false || d?.verified === false) {
      return { success: false, error: pick(data, ['error', 'message']) ?? 'Receipt could not be verified.', statusCode: 404 };
    }

    const amount = toNumber(pick(d, ['amount', 'settledAmount', 'transferredAmount', 'transferred_amount']));
    if (amount === undefined) {
      logger.warn('check.et response had no usable amount');
      return { success: false, error: 'Unexpected response from verification service.', statusCode: 502 };
    }

    return {
      success: true,
      payer: pick(d, ['payerName', 'payer_name', 'payer']),
      payerAccount: pick(d, ['payerAccount', 'payer_account', 'sender_account']),
      receiver: pick(d, ['receiverName', 'receiver_name', 'receiver']),
      // do NOT fall back to `account_number`: it may just echo the value we sent
      receiverAccount: pick(d, ['receiverAccount', 'receiver_account']),
      amount,
      date: toDate(pick(d, ['date', 'paymentDate', 'dateTime', 'transaction_date'])),
      reference: pick(d, ['transaction_number', 'reference', 'receiptNo']),
      reason: pick(d, ['reason', 'customerNote', 'description']) ?? null
    };
  } catch (error: any) {
    const status: number | undefined = error.response?.status;
    const msg = error.response?.data?.error ?? error.response?.data?.message ?? error.message;
    logger.warn(`api.check.et failed (${status ?? 'no response'}): ${msg}`);

    if (status === 401 || status === 403) {
      return { success: false, error: 'Verification service credentials were rejected.', statusCode: 503 };
    }
    return { success: false, error: msg, statusCode: status };
  }
}