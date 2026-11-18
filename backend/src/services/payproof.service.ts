/**
 * payproof.service.ts
 *
 * Integration with the PayProof verification API for TELEBIRR PAYMENTS ONLY.
 *
 * Upstream API flow:
 * 1. POST /api/v1/verifications/ with multipart/form-data ("images[]")
 *    Returns { id: number, status: "PENDING" }
 * 2. Poll GET /api/v1/verifications/{id}/ every ~2 seconds until a terminal
 *    state ("VERIFIED", "FAILED", or "REJECTED").
 * 3. Log X-Request-Id header from every PayProof response.
 * 4. Parse response:
 *    - Reject non-Telebirr banks (CBE, Awash, etc. are NOT in scope).
 *    - Settle Amount Trap: Top-level amount includes fee (total debited).
 *      Actual credited amount is pdf_link_data.settled_amount or link_receipt_data.settled_amount.
 *      Compare expected order price against settled_amount in integer cents!
 *    - Time Trap: Top-level transaction_date is UTC ISO; pdf_link_data.date is local EAT.
 *      Use UTC for freshness validation.
 *    - Masked phone matching: Match first 4 + last 4 digits against registered accounts.
 */

import axios, { AxiosResponse } from 'axios';
import FormData from 'form-data';
import https from 'https';
import logger from '../utils/logger';

// Persistent keep-alive IPv4 agent to avoid repeated TCP/TLS handshakes & slow IPv6 routes on Render
const payproofAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 25,
  keepAliveMsecs: 30_000,
  family: 4,
});

export interface PayProofLinkReceiptData {
  settled_amount?: number;
  service_fee?: number;
  service_fee_vat?: number;
  total_paid_amount?: number;
  transaction_status?: string;
  receipt_no?: string;
  payment_date?: string;
  credited_party_name?: string;
  credited_party_account_no?: string;
  payer_name?: string;
  payer_telebirr_no?: string;
  bank_name?: string;
  [key: string]: any;
}

export interface PayProofPdfLinkData {
  settled_amount?: number;
  service_fee?: number;
  date?: string;
  to_name?: string;
  credited_party_account_no?: string;
  payer_name?: string;
  payer_telebirr_no?: string;
  [key: string]: any;
}

export interface PayProofVerificationData {
  id: number | string;
  status: 'PENDING' | 'PROCESSING' | 'VERIFIED' | 'FAILED' | 'REJECTED' | string;
  bank_name?: string;
  bank?: string;
  reference_number?: string;
  amount?: number; // Total debited from sender (including fee)
  service_fee?: number;
  transaction_date?: string; // UTC ISO 8601
  payer_name?: string;
  payer_phone?: string;
  to_name?: string;
  to_account?: string;
  pdf_link_data?: PayProofPdfLinkData;
  link_receipt_data?: PayProofLinkReceiptData;
  ai_extracted_data?: Record<string, any>;
  failure_reason?: string;
  message?: string;
  [key: string]: any;
}

export interface PayProofVerificationResult {
  success: boolean;
  verified: boolean;
  status: 'VERIFIED' | 'AMOUNT_MISMATCH' | 'INVALID_RECEIPT' | 'FAILED_UPSTREAM' | 'WRONG_RECEIVER' | 'FLAGGED_DUPLICATE';
  code?: string;
  provider: 'TELEBIRR';
  reference: string;
  amount: number; // Credited / settled amount in ETB
  settledAmount: number;
  totalDebitedAmount?: number;
  serviceFee?: number;
  currency: 'ETB';
  senderName?: string;
  senderPhone?: string;
  receiverName?: string;
  receiverAccount?: string;
  transactionDate?: Date;
  durationMs?: number;
  message?: string;
  requestId?: string;
  verificationId?: number | string;
  raw?: any;
}

export interface RegisteredAccountItem {
  accountNumber: string;
  accountHolderName: string;
}

export interface VerifyPayProofOptions {
  expectedAmount?: number;
  registeredAccounts?: RegisteredAccountItem[];
  maxAgeHours?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (stage: string) => void;
}

const DEFAULT_BASE_URL = 'https://verifyitet.duckdns.org';
const DEFAULT_TIMEOUT_MS = 75000; // 75 seconds safety timeout
const DEFAULT_POLL_INTERVAL_MS = 650; // 650ms fast polling over keep-alive TLS

function getBaseUrl(): string {
  const url = process.env.PAYPROOF_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return url.replace(/\/+$/, '');
}

function getSecretKey(): string {
  const key = process.env.PAYPROOF_SECRET_KEY?.trim() || '';
  if (!key) {
    logger.warn('[PayProof] PAYPROOF_SECRET_KEY is not configured in environment variables');
  }
  return key;
}

/** Normalize Ethiopian phone number to digits only (e.g. 251912345678 -> 912345678) */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('2519') || digits.startsWith('2517')) return digits.slice(3);
  if (digits.startsWith('09') || digits.startsWith('07')) return digits.slice(1);
  return digits;
}

/**
 * Match a masked Telebirr phone number (e.g. "2519****1087" or "09****1087")
 * against a registered phone number.
 */
export function phonesMatch(maskedOrFullA: string, fullOrMaskedB: string): boolean {
  if (!maskedOrFullA || !fullOrMaskedB) return false;
  const a = maskedOrFullA.trim();
  const b = fullOrMaskedB.trim();

  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (na === nb && !a.includes('*') && !b.includes('*')) return true;

  const matchMasked = (masked: string, full: string): boolean => {
    const starIdx = masked.indexOf('*');
    if (starIdx === -1) return false;
    const prefixRaw = masked.slice(0, starIdx);
    const suffixRaw = masked.slice(masked.lastIndexOf('*') + 1);

    const prefixDigits = normalizePhone(prefixRaw);
    const suffixDigits = suffixRaw.replace(/\D/g, '');
    const fullNormalized = normalizePhone(full);

    const prefixOk = !prefixDigits || fullNormalized.startsWith(prefixDigits);
    const suffixOk = !suffixDigits || fullNormalized.endsWith(suffixDigits);
    return prefixOk && suffixOk;
  };

  if (a.includes('*') && matchMasked(a, b)) return true;
  if (b.includes('*') && matchMasked(b, a)) return true;

  // Suffix matching (last 4 digits) if prefix is unavailable
  const digitsA = a.replace(/\*/g, '').replace(/\D/g, '');
  const digitsB = b.replace(/\*/g, '').replace(/\D/g, '');
  if (digitsA.length >= 4 && nb.endsWith(digitsA.slice(-4))) return true;
  if (digitsB.length >= 4 && na.endsWith(digitsB.slice(-4))) return true;

  return false;
}

/**
 * Upload receipt image to PayProof API:
 * POST /api/v1/verifications/
 * Header: Authorization: Bearer <PAYPROOF_SECRET_KEY>
 * Field: "images[]"
 */
export async function uploadReceiptToPayProof(
  imageBuffer: Buffer,
  filename = 'receipt.jpg',
  mimetype = 'image/jpeg'
): Promise<{ verificationId: number | string; initialStatus: string; requestId?: string }> {
  const baseUrl = getBaseUrl();
  const secretKey = getSecretKey();

  if (!secretKey) {
    throw new Error('PAYPROOF_SECRET_KEY is not configured on the server.');
  }

  // Compress oversized images (> 180KB) just like the Mini App frontend does (~25ms, speeds up upload 2-5x)
  let uploadBuffer = imageBuffer;
  let uploadFilename = filename;
  let uploadMimetype = mimetype;
  if (imageBuffer.length > 180_000 && mimetype.startsWith('image/')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharpMod = require('sharp');
      const sharpFn: (input: Buffer) => any = sharpMod.default ?? sharpMod;
      const compressed: Buffer = await sharpFn(imageBuffer)
        .rotate()
        .resize({ width: 1200, height: 2200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      if (compressed.length < imageBuffer.length) {
        uploadBuffer = compressed;
        uploadFilename = 'receipt.jpg';
        uploadMimetype = 'image/jpeg';
      }
    } catch {
      // Safely fall back to original buffer
    }
  }

  const formData = new FormData();
  formData.append('images[]', uploadBuffer, {
    filename: uploadFilename,
    contentType: uploadMimetype,
  });

  const uploadUrl = `${baseUrl}/api/v1/verifications/`;
  logger.info(`[PayProof] Uploading receipt image to ${uploadUrl} (field: images[], size: ${uploadBuffer.length} bytes)...`);

  const response: AxiosResponse = await axios.post(uploadUrl, formData, {
    headers: {
      ...formData.getHeaders(),
      Authorization: `Bearer ${secretKey}`,
      Accept: 'application/json',
    },
    timeout: 30000,
    httpsAgent: payproofAgent,
  });

  const requestId = (response.headers['x-request-id'] || response.headers['x-correlation-id']) as string | undefined;
  logger.info(`[PayProof] Upload response HTTP ${response.status} | X-Request-Id: ${requestId || 'none'}`);

  const data = response.data;
  const verificationId = data?.id ?? data?.verification_id ?? data?.verification?.id;
  const initialStatus = data?.status ?? data?.verification?.status ?? 'PENDING';

  if (!verificationId) {
    throw new Error(`PayProof did not return a verification ID. Response: ${JSON.stringify(data)}`);
  }

  return { verificationId, initialStatus, requestId };
}

/**
 * Poll PayProof verification status:
 * GET /api/v1/verifications/{id}/
 * Polls every intervalMs until terminal state ("VERIFIED", "FAILED", "REJECTED") or timeout.
 */
export async function pollPayProofVerification(
  verificationId: number | string,
  options?: {
    timeoutMs?: number;
    intervalMs?: number;
    onProgress?: (status: string) => void;
  }
): Promise<{ data: PayProofVerificationData; requestId?: string }> {
  const baseUrl = getBaseUrl();
  const secretKey = getSecretKey();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startTime = Date.now();

  const statusUrl = `${baseUrl}/api/v1/verifications/${verificationId}/`;
  const terminalStatuses = new Set(['VERIFIED', 'FAILED', 'REJECTED']);

  let lastRequestId: string | undefined;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response: AxiosResponse = await axios.get(statusUrl, {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: 'application/json',
        },
        timeout: 15000,
        httpsAgent: payproofAgent,
      });

      lastRequestId = (response.headers['x-request-id'] || response.headers['x-correlation-id']) as string | undefined;
      const respData = response.data;
      const verification: PayProofVerificationData = respData?.verification || respData;
      const currentStatus = (verification?.status || '').toUpperCase();

      logger.info(
        `[PayProof] Poll #${verificationId} -> ${currentStatus} | X-Request-Id: ${lastRequestId || 'none'} (${Date.now() - startTime}ms elapsed)`
      );

      if (options?.onProgress) {
        try {
          options.onProgress(currentStatus || 'PROCESSING');
        } catch {}
      }

      if (terminalStatuses.has(currentStatus)) {
        return { data: verification, requestId: lastRequestId };
      }
    } catch (pollErr: any) {
      const status = pollErr.response?.status;
      if (status === 404) {
        throw new Error(`PayProof verification #${verificationId} not found.`);
      }
      logger.warn(`[PayProof] Poll error for #${verificationId} (${pollErr.message}), will retry next tick...`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Verification timed out after ${Math.round(timeoutMs / 1000)} seconds. Upstream PayProof engine still processing.`);
}

/**
 * Parse and validate Telebirr payment data according to business rules:
 * 1. Scope: Reject non-Telebirr receipts immediately.
 * 2. Amount Trap: Read settled_amount, not top-level amount (debited total). Compare in integer cents.
 * 3. Time Trap: Validate freshness using UTC transaction_date.
 * 4. Receiver Matching: Verify masked phone or official beneficiary name against registered accounts.
 */
export function validateAndParseTelebirrData(
  data: PayProofVerificationData,
  options?: {
    expectedAmount?: number;
    registeredAccounts?: RegisteredAccountItem[];
    maxAgeHours?: number;
    requestId?: string;
  }
): PayProofVerificationResult {
  const reqId = options?.requestId;

  // ── Helper: Safe numeric parser for string or number values ─────────────────
  const parseNumeric = (val: any): number | undefined => {
    if (val === undefined || val === null || val === '') return undefined;
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
    return isNaN(n) ? undefined : n;
  };

  const getFirstNonEmpty = (...candidates: any[]): string | undefined => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    }
    return undefined;
  };

  // ── 1. Bank Scope Check: TELEBIRR ONLY ──────────────────────────────────────
  const rawBank = (
    data.bank_name ||
    data.bank ||
    data.link_receipt_data?.bank_name ||
    data.pdf_link_data?.bank_name ||
    data.ai_extracted_data?.bank_name ||
    ''
  ).toUpperCase();

  const isTelebirr = rawBank.includes('TELEBIRR') || rawBank.includes('ETHIO') || rawBank === '';
  if (!isTelebirr && rawBank.length > 0) {
    logger.warn(`[PayProof] Non-Telebirr bank detected: "${rawBank}". Rejecting non-Telebirr receipt.`);
    return {
      success: false,
      verified: false,
      status: 'INVALID_RECEIPT',
      code: 'UNSUPPORTED_BANK',
      provider: 'TELEBIRR',
      reference: data.reference_number || '',
      amount: 0,
      settledAmount: 0,
      currency: 'ETB',
      message: `Unsupported bank: Only Telebirr receipts are supported by this service. The uploaded receipt is from "${rawBank}".`,
      requestId: reqId,
      raw: data,
    };
  }

  // ── 2. Check if Ethio Telecom verified the receipt ──────────────────────────
  // PayProof sets its company status to FAILED when an account is not configured in
  // PayProof dashboard (admin_note: ACCOUNT_NOT_CONFIGURED), even though the receipt
  // was 100% verified on Ethio Telecom portal (step1_link_verification.status = "verified").
  const isUpstreamReceiptVerified =
    data.status?.toUpperCase() === 'VERIFIED' ||
    data.ai_extracted_data?.step1_link_verification?.status?.toLowerCase() === 'verified' ||
    (typeof data.admin_note === 'string' && data.admin_note.includes('ACCOUNT_NOT_CONFIGURED')) ||
    (parseNumeric(data.pdf_link_data?.settled_amount) !== undefined && Boolean(data.pdf_link_data?.reference_number));

  const statusUpper = (data.status || '').toUpperCase();
  if ((statusUpper === 'FAILED' || statusUpper === 'REJECTED') && !isUpstreamReceiptVerified) {
    const reason = data.failure_reason || data.message || `Telebirr receipt verification ${statusUpper.toLowerCase()}.`;
    return {
      success: false,
      verified: false,
      status: 'INVALID_RECEIPT',
      code: statusUpper,
      provider: 'TELEBIRR',
      reference: data.reference_number || '',
      amount: 0,
      settledAmount: 0,
      currency: 'ETB',
      message: reason,
      requestId: reqId,
      raw: data,
    };
  }

  if (statusUpper === 'FAILED' && isUpstreamReceiptVerified) {
    logger.info(
      '[PayProof] Upstream Ethio Telecom confirmed payment. Proceeding with tenant business matching in CheckFlow ET...'
    );
  }

  // ── 3. Settled Amount Trap: pdf_link_data.settled_amount vs top-level amount
  const serviceFee =
    parseNumeric(data.service_fee) ??
    parseNumeric(data.pdf_link_data?.service_fee) ??
    parseNumeric(data.pdf_link_data?.transaction_fee) ??
    parseNumeric(data.link_receipt_data?.service_fee) ??
    0;

  const rawSettled =
    parseNumeric(data.pdf_link_data?.settled_amount) ??
    parseNumeric(data.link_receipt_data?.settled_amount) ??
    parseNumeric(data.step1_link_data?.settled_amount) ??
    parseNumeric(data.ai_extracted_data?.step1_link_verification?.receipt_data?.settled_amount);

  let settledAmount: number;
  if (rawSettled !== undefined) {
    settledAmount = rawSettled;
  } else {
    const rawTotal =
      parseNumeric(data.amount) ??
      parseNumeric(data.pdf_link_data?.total_amount_debited) ??
      parseNumeric(data.pdf_link_data?.total_paid_amount);
    if (rawTotal !== undefined) {
      settledAmount = rawTotal - serviceFee;
    } else {
      settledAmount = 0;
    }
  }

  const totalDebitedAmount =
    parseNumeric(data.amount) ??
    parseNumeric(data.pdf_link_data?.total_amount_debited) ??
    parseNumeric(data.pdf_link_data?.total_paid_amount) ??
    (settledAmount + serviceFee);

  // Reference number
  const reference = getFirstNonEmpty(
    data.reference_number,
    data.pdf_link_data?.reference_number,
    data.link_receipt_data?.receipt_no,
    data.step1_link_data?.reference_number,
    data.ai_extracted_data?.reference_number
  ) || '';

  // Parties: prioritize official Ethio Telecom link receipt data
  const receiverAccount = getFirstNonEmpty(
    data.pdf_link_data?.to_account,
    data.to_account,
    data.pdf_link_data?.credited_party_account_no,
    data.link_receipt_data?.credited_party_account_no,
    data.step1_link_data?.to_account,
    data.ai_extracted_data?.to_account
  );

  const receiverName = getFirstNonEmpty(
    data.pdf_link_data?.to_name,
    data.to_name,
    data.link_receipt_data?.credited_party_name,
    data.step1_link_data?.to_name,
    data.ai_extracted_data?.to_name
  );

  const senderName = getFirstNonEmpty(
    data.pdf_link_data?.from_name,
    data.from_name,
    data.payer_name,
    data.pdf_link_data?.payer_name,
    data.link_receipt_data?.payer_name
  );

  const senderPhone = getFirstNonEmpty(
    data.pdf_link_data?.from_account,
    data.from_account,
    data.payer_phone,
    data.pdf_link_data?.payer_telebirr_no,
    data.link_receipt_data?.payer_telebirr_no
  );

  // ── 4. Freshness Validation (Time Trap: use UTC transaction_date) ─────────────
  let txDate: Date | undefined;
  if (data.transaction_date) {
    txDate = new Date(data.transaction_date);
  } else if (data.pdf_link_data?.date) {
    // EAT format e.g. "08-10-2026 19:59:43" (DD-MM-YYYY HH:mm:ss)
    const match = data.pdf_link_data.date.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      const [, dd, mm, yyyy, hh, min, ss] = match;
      // Convert EAT (UTC+3) to UTC ISO
      const eatDate = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+03:00`);
      if (!isNaN(eatDate.getTime())) txDate = eatDate;
    }
  }

  const maxAgeHours = options?.maxAgeHours ?? Number(process.env.RECEIPT_MAX_AGE_HOURS || 72);
  if (txDate && !isNaN(txDate.getTime())) {
    const ageMs = Date.now() - txDate.getTime();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) {
      logger.warn(`[PayProof] Telebirr receipt is older than max allowed age (${maxAgeHours}h): ${txDate.toISOString()}`);
    }
  }

  // ── 5. Amount Matching (Integer Cents) ───────────────────────────────────────
  if (options?.expectedAmount !== undefined && options.expectedAmount !== null) {
    const settledCents = Math.round(settledAmount * 100);
    const expectedCents = Math.round(Number(options.expectedAmount) * 100);

    if (settledCents !== expectedCents) {
      logger.warn(
        `[PayProof] Amount mismatch! Expected: ${options.expectedAmount} ETB (${expectedCents}¢), ` +
        `Settled: ${settledAmount} ETB (${settledCents}¢), Debited: ${totalDebitedAmount} ETB, Fee: ${serviceFee} ETB`
      );

      return {
        success: false,
        verified: false,
        status: 'AMOUNT_MISMATCH',
        code: 'AMOUNT_MISMATCH',
        provider: 'TELEBIRR',
        reference,
        amount: settledAmount,
        settledAmount,
        totalDebitedAmount,
        serviceFee: Number(serviceFee),
        currency: 'ETB',
        senderName,
        senderPhone,
        receiverName,
        receiverAccount,
        transactionDate: txDate,
        message: `Amount mismatch: expected ${options.expectedAmount} ETB, but Telebirr credited amount is ${settledAmount} ETB (total paid: ${totalDebitedAmount} ETB, fee: ${serviceFee} ETB).`,
        requestId: reqId,
        raw: data,
      };
    }
  }

  // ── 6. Masked Account & Receiver Matching ───────────────────────────────────
  const registeredAccounts = options?.registeredAccounts || [];
  if (registeredAccounts.length > 0) {
    let matched = false;

    // A. Check phone matching (handles masked numbers like 2519****1087)
    if (receiverAccount) {
      matched = registeredAccounts.some((acc) => phonesMatch(receiverAccount, acc.accountNumber));
    }

    // B. Check official beneficiary name matching
    if (!matched && receiverName) {
      const rUpper = receiverName.toUpperCase();
      const rWords = rUpper.split(/\s+/).filter((w) => w.length > 2);

      matched = registeredAccounts.some((acc) => {
        if (!acc.accountHolderName) return false;
        const aUpper = acc.accountHolderName.toUpperCase();
        const aWords = aUpper.split(/\s+/).filter((w) => w.length > 2);
        return rWords.some((w) => aWords.includes(w)) || aWords.some((w) => rWords.includes(w));
      });
    }

    if (!matched) {
      const regList = registeredAccounts.map((a) => `${a.accountNumber} (${a.accountHolderName})`).join(', ');
      logger.warn(
        `[PayProof] Wrong receiver: Payment was sent to ${receiverAccount || 'unknown'} (${receiverName || 'unknown'}), not registered account (${regList})`
      );

      return {
        success: false,
        verified: false,
        status: 'WRONG_RECEIVER',
        code: 'WRONG_RECEIVER',
        provider: 'TELEBIRR',
        reference,
        amount: settledAmount,
        settledAmount,
        totalDebitedAmount,
        serviceFee: Number(serviceFee),
        currency: 'ETB',
        senderName,
        senderPhone,
        receiverName,
        receiverAccount,
        transactionDate: txDate,
        message: `Wrong receiver: Payment was sent to ${receiverAccount || 'another number'} (${receiverName || 'unmatched party'}), not to your registered Telebirr accounts (${regList}).`,
        requestId: reqId,
        raw: data,
      };
    }
  }

  // ── 7. Verification Success ─────────────────────────────────────────────────
  return {
    success: true,
    verified: true,
    status: 'VERIFIED',
    provider: 'TELEBIRR',
    reference,
    amount: settledAmount,
    settledAmount,
    totalDebitedAmount,
    serviceFee: Number(serviceFee),
    currency: 'ETB',
    senderName,
    senderPhone,
    receiverName,
    receiverAccount,
    transactionDate: txDate,
    message: `Payment of ${settledAmount} ETB verified successfully via Telebirr.`,
    requestId: reqId,
    raw: data,
  };
}

/**
 * End-to-end Telebirr verification pipeline:
 * Upload -> Poll until terminal -> Validate business rules -> Return result.
 */
export async function verifyTelebirrReceiptWithPayProof(
  imageBuffer: Buffer,
  filename = 'receipt.jpg',
  mimetype = 'image/jpeg',
  options?: VerifyPayProofOptions
): Promise<PayProofVerificationResult> {
  const t0 = Date.now();

  try {
    options?.onProgress?.('reading');

    // Step 1: Upload receipt image
    const { verificationId, initialStatus, requestId: uploadReqId } = await uploadReceiptToPayProof(
      imageBuffer,
      filename,
      mimetype
    );

    // Step 2: Poll status until complete
    options?.onProgress?.('checking_bank');
    const { data, requestId: pollReqId } = await pollPayProofVerification(verificationId, {
      timeoutMs: options?.timeoutMs,
      intervalMs: options?.pollIntervalMs,
      onProgress: options?.onProgress,
    });

    const activeRequestId = pollReqId || uploadReqId;

    // Step 3: Validate and parse Telebirr data
    const result = validateAndParseTelebirrData(data, {
      expectedAmount: options?.expectedAmount,
      registeredAccounts: options?.registeredAccounts,
      maxAgeHours: options?.maxAgeHours,
      requestId: activeRequestId,
    });

    result.verificationId = verificationId;
    result.durationMs = Date.now() - t0;

    return result;
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    logger.error(`[PayProof] Verification failed: ${err.message}`);

    const isTimeout = err.message?.toLowerCase().includes('timeout');
    return {
      success: false,
      verified: false,
      status: isTimeout ? 'FAILED_UPSTREAM' : 'INVALID_RECEIPT',
      code: isTimeout ? 'TIMEOUT' : 'ERROR',
      provider: 'TELEBIRR',
      reference: '',
      amount: 0,
      settledAmount: 0,
      currency: 'ETB',
      durationMs,
      message: err.message || 'Telebirr receipt verification failed.',
    };
  }
}
