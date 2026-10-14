/**
 * verifyCBE.ts
 *
 * 
 * Self-hosted CBE verification — no external api.check.et dependency.
 *
 * Supports two reference types:
 *
 * 1. NEW receipt token / URL (mbreciept.cbe.com.et)
 *    → Calls the official CBE public JSON API directly.
 *
 * 2. LEGACY FT reference (apps.cbe.com.et:100/?id=FT...{8-digit suffix})
 *    → Fetches the HTML receipt page and parses with Cheerio.
 */

import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { PDFParse } from 'pdf-parse';
import logger from '../utils/logger';

// ── CBE Public JSON API ──────────────────────────────────────────────────────
// Official public endpoint: https://mbreciept.cbe.com.et/v2-{token}
// When called with Accept: application/json this returns the transaction JSON.
const CBE_JSON_API_BASE = 'https://mbreciept.cbe.com.et';
const CBE_APP_ID = process.env.CBE_APP_ID ?? 'd1292e42-7400-49de-a2d3-9731caa4c819';
const CBE_APP_VERSION = process.env.CBE_APP_VERSION ?? '0a01980b-9859-1369-8198-59f403820000';

// ── Legacy CBE HTML portal ───────────────────────────────────────────────────
const CBE_LEGACY_BASE = 'https://apps.cbe.com.et:100';

// ── Reference patterns ───────────────────────────────────────────────────────
// Matches https://mbreciept.cbe.com.et/v2-<token> — captures the full "v2-xxx" path segment
const MBRECIEPT_URL_RE = /^https?:\/\/(?:mbreciept|mbreceipt)\.cbe\.com\.et\/(v2-[A-Za-z0-9]+)/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{15,60}$/;      // new short token
const FT_RE = /^FT[A-Z0-9]{8,14}$/i;             // legacy FT reference
const LEGACY_APPS_URL_RE = /^https?:\/\/apps\.cbe\.com\.et/i;
const LEGACY_COMBINED_RE = /^(FT[A-Z0-9]{8,14})(\d{8})$/i; // FT...{8-digit suffix}

const ACCOUNT_LENGTH = 13;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

// Accept self-signed cert from apps.cbe.com.et:100
const legacyAgent = new https.Agent({ rejectUnauthorized: false });

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

// ── Utilities ─────────────────────────────────────────────────────────────────

const toNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const toDate = (v: unknown): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * Parses CBE's processingDate field which comes back as "YYYYMMDD" (e.g. "20260928").
 * Falls back to a generic Date parse for any other date-like value.
 */
const parseCBEDate = (v: unknown): Date | undefined => {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) {
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return toDate(v);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: AxiosError): boolean {
  if (err.response) return false; // HTTP error — don't blindly retry
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(err.code ?? '');
}

// ── 1. NEW CBE receipt token → JSON API ──────────────────────────────────────

async function verifyByToken(token: string): Promise<VerifyResult> {
  // URL format: https://mbreciept.cbe.com.et/v2-{token}
  // token already contains the "v2-" prefix (e.g. "v2-hfHCxHm0dwBHOQSgWNOf")
  const url = `${CBE_JSON_API_BASE}/${token}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`[CBE/token] Fetching (attempt ${attempt}/${MAX_RETRIES}): ${url}`);

      const { data } = await axios.get(url, {
        headers: {
          'X-App-ID': CBE_APP_ID,
          'X-App-Version': CBE_APP_VERSION,
          'Accept': 'application/json, text/plain, */*',
          'Origin': 'https://mbreciept.cbe.com.et',
          'Referer': 'https://mbreciept.cbe.com.et/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 20_000,
      });

      if (process.env.LOG_CHECK_RAW === '1') {
        logger.debug(`[CBE/token] Raw response: ${JSON.stringify(data)}`);
      }

      // Normalise the response (some versions wrap inside `data` key)
      const d: any = data?.data ?? data;

      if (!d) {
        return { success: false, error: 'Empty response from CBE API.', statusCode: 502 };
      }

      // Honour the API's own success flag
      // Real API returns "COMPLETED" — also accept SUCCESS/SUCCESSFUL for safety
      const statusField = (d.status ?? d.transactionStatus ?? '').toString().toUpperCase();
      if (statusField && !['SUCCESS', 'COMPLETED', 'SUCCESSFUL'].includes(statusField)) {
        return {
          success: false,
          error: `CBE transaction status: ${d.status}`,
          statusCode: 400,
        };
      }

      // Real API field is "debitAmount"; fall back to all known variants
      const amount = toNumber(
        d.debitAmount ?? d.amount ?? d.transferredAmount ?? d.settledAmount ??
        d.creditAmount ?? d.totalAmount ?? d.transactionAmount ?? d.paidAmount ??
        d.principal ?? d.value ?? d.netAmount ?? d.credit ?? d.debit
      );
      if (amount === undefined) {
        // Log all keys in the response to help diagnose unknown field names
        logger.warn(`[CBE/token] Response had no usable amount field. Available keys: ${Object.keys(d).join(', ')}`);
        return { success: false, error: 'CBE API response missing amount.', statusCode: 502 };
      }

      // Real API: date is in processingDate ("YYYYMMDD"), names use "Holder" suffix
      // paymentDetails is an array of strings (e.g. ["MB Transfer"])
      return {
        success: true,
        payer:          d.debitAccountHolder  ?? d.debitAccountName  ?? d.payerName    ?? d.senderName   ?? undefined,
        payerAccount:   d.debitAccountNo      ?? d.payerAccount      ?? undefined,
        receiver:       d.creditAccountHolder ?? d.creditAccountName ?? d.receiverName ?? undefined,
        receiverAccount: d.creditAccountNo    ?? d.receiverAccount   ?? undefined,
        amount,
        date: parseCBEDate(d.processingDate ?? d.transactionDate ?? d.date ?? d.dateTime),
        reference: d.id ?? d.transactionId ?? d.reference ?? token,
        reason: Array.isArray(d.paymentDetails)
          ? d.paymentDetails.join(' ')
          : (d.description ?? d.narrative ?? d.reason ?? null),
      };
    } catch (err: any) {
      const axiosErr = err as AxiosError;
      
      if (axiosErr.response?.status === 404) {
        return { success: false, error: 'CBE receipt not found.', statusCode: 404 };
      }
      if (axiosErr.response?.status === 401 || axiosErr.response?.status === 403) {
        return { success: false, error: 'CBE API authentication failed. Check CBE_APP_ID/CBE_APP_VERSION.', statusCode: 503 };
      }

      if (isRetryable(axiosErr) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(`[CBE/token] Network error, retrying in ${delay}ms… [${axiosErr.code}]`);
        await sleep(delay);
        continue;
      }

      const msg = (axiosErr.response?.data as any)?.message ?? axiosErr.message;
      logger.warn(`[CBE/token] Failed: ${msg}`);
      return { success: false, error: msg, statusCode: axiosErr.response?.status ?? 502 };
    }
  }

  return { success: false, error: 'CBE API request failed after retries.', statusCode: 502 };
}

// ── 2. LEGACY FT reference → HTML scrape ──────────────────────────────────────

/**
 * Parses the apps.cbe.com.et:100 receipt HTML page.
 * The page contains a two-column table with label: value rows.
 */
function parseLegacyHtml(html: string): VerifyResult {
  const $ = cheerio.load(html);

  // Build a label → value map from all two-column table rows
  const fields: Record<string, string> = {};

  $('table tr, .info-row, dl dt, dl dd').each((_i, el) => {
    const cells = $(el).find('td, th');
    if (cells.length >= 2) {
      const label = $(cells[0]).text().trim().replace(/[:\s]+$/, '');
      const value = $(cells[1]).text().trim();
      if (label) fields[label.toLowerCase()] = value;
    }
  });

  // Also try key-value spans/divs (alternate layout)
  $('[class*="label"], [class*="key"]').each((_i, el) => {
    const label = $(el).text().trim().replace(/[:\s]+$/, '');
    const value = $(el).next().text().trim();
    if (label && value) fields[label.toLowerCase()] = value;
  });

  // Fallback: raw page text scraping
  const pageText = $('body').text();

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      if (fields[k.toLowerCase()]) return fields[k.toLowerCase()];
    }
    return undefined;
  };

  // Amount: look for "Amount" or "Transaction Amount" field, then fallback regex
  const amountStr = pick(
    'Transaction Amount', 'Amount', 'Transferred Amount', 'Settled Amount', 'Total Amount'
  );
  let amount = toNumber(amountStr);
  if (!amount) {
    const m = pageText.match(/(?:Amount|ETB)[:\s]+([\d,]+\.?\d*)/i);
    if (m) amount = toNumber(m[1]);
  }

  // Reference
  const reference = pick('Transaction ID', 'Reference', 'FT Reference', 'Transaction Reference')
    || (pageText.match(/\b(FT[A-Z0-9]{8,14})\b/i)?.[1]);

  // Date
  const dateStr = pick('Transaction Date', 'Date', 'Value Date', 'Date & Time');
  const date = toDate(dateStr);

  // Names
  const payer = pick('Debit Account Name', 'Sender Name', "Payer's Name", 'Source Account Name');
  const payerAccount = pick('Debit Account No', 'Sender Account', "Payer's Account", 'Source Account');
  const receiver = pick('Credit Account Name', 'Receiver Name', "Receiver's Name", 'Beneficiary Name');
  const receiverAccount = pick('Credit Account No', 'Receiver Account', "Receiver's Account", 'Beneficiary Account');

  if (!amount && !reference) {
    logger.warn('[CBE/legacy] Could not extract amount or reference from HTML');
    return { success: false, error: 'CBE legacy receipt page structure not recognised.', statusCode: 502 };
  }

  return {
    success: true,
    payer,
    payerAccount,
    receiver,
    receiverAccount,
    amount,
    date,
    reference,
    reason: pick('Narrative', 'Description', 'Reason') ?? null,
  };
}

// ── 2b. CBE legacy PDF parser ─────────────────────────────────────────────────

/**
 * Parses text extracted from a CBE PDF receipt.
 * We use a broad set of regex patterns because the exact label wording
 * varies across CBE receipt generations.
 */
function parseCbePdfText(text: string): VerifyResult {
  // Normalise line endings; collapse runs of spaces/tabs (but keep newlines)
  const t = text.replace(/\r\n/g, '\n').replace(/[ \t]{2,}/g, ' ');

  if (process.env.LOG_CHECK_RAW === '1') {
    logger.debug(`[CBE/legacy-pdf] Extracted text (first 3000 chars):\n${t.slice(0, 3000)}`);
  }

  // Grab the first capture group from a regex applied to the full text.
  const grab = (re: RegExp): string | undefined =>
    (t.match(re) ?? [])[1]?.trim() || undefined;

  // ── Amount ────────────────────────────────────────────────────────────────
  const amountStr = grab(
    /(?:Transaction\s*Amount|Transferred\s*Amount|Total\s*Amount|Settled\s*Amount)[:\s]+(?:ETB\s*)?(\d[\d,]*\.?\d*)/im
  ) ?? grab(
    /Amount[:\s]+(?:ETB\s*)?(\d[\d,]*\.?\d*)/im
  ) ?? grab(
    /\bETB\s+(\d[\d,]*\.\d{2})\b/i
  );
  const amount = toNumber(amountStr);

  // ── Reference ─────────────────────────────────────────────────────────────
  const reference =
    grab(/(?:Transaction\s*(?:ID|Reference|Ref\.?)|FT\s*Reference|Reference\s*No?\.?)[:\s]+(FT[A-Z0-9]{8,14})/im) ??
    (t.match(/\b(FT[A-Z0-9]{8,14})\b/)?.[1]);

  // ── Date ──────────────────────────────────────────────────────────────────
  const dateRaw = grab(
    /(?:Transaction\s*Date|Payment\s*Date|Date\s*(?:&|and)\s*Time|Value\s*Date)[:\s]+([^\n]{6,30})/im
  ) ?? grab(/Date[:\s]+([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4}[^\n]{0,20})/im);
  const date = toDate(dateRaw);

  // ── Payer / Sender ────────────────────────────────────────────────────────
  const payer = grab(
    /(?:Debit\s*Account\s*(?:Name|Holder)|Sender\s*Name|Payer(?:'?s)?\s*Name)[:\s]+([^\n]{2,60})/im
  );

  const payerAccount = grab(
    /(?:Debit\s*Account\s*(?:No\.?|Number)|Sender\s*Account|Payer(?:'?s)?\s*Account)[:\s]+([\d*X]{5,20})/im
  );

  // ── Receiver / Beneficiary ────────────────────────────────────────────────
  const receiver = grab(
    /(?:Credit\s*Account\s*(?:Name|Holder)|Receiver(?:'?s)?\s*Name|Beneficiary\s*Name)[:\s]+([^\n]{2,60})/im
  );

  const receiverAccount = grab(
    /(?:Credit\s*Account\s*(?:No\.?|Number)|Receiver(?:'?s)?\s*Account|Beneficiary\s*Account)[:\s]+([\d*X]{5,20})/im
  );

  // ── Narrative ─────────────────────────────────────────────────────────────
  const reason = grab(
    /(?:Narrative|Description|Reason|Payment\s*Detail|Remark)[:\s]+([^\n]{1,120})/im
  );

  if (!amount && !reference) {
    logger.warn('[CBE/legacy-pdf] Could not extract amount or reference from PDF text');
    return { success: false, error: 'CBE legacy PDF receipt structure not recognised.', statusCode: 502 };
  }

  return { success: true, payer, payerAccount, receiver, receiverAccount, amount, date, reference, reason: reason ?? null };
}

async function verifyByLegacyUrl(combinedId: string): Promise<VerifyResult> {
  const url = `${CBE_LEGACY_BASE}/?id=${combinedId}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`[CBE/legacy] Fetching receipt (attempt ${attempt}/${MAX_RETRIES}): ${url}`);

      // Fetch as binary so we can handle both HTML and PDF responses
      const response = await axios.get(url, {
        httpsAgent: legacyAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*',
        },
        timeout: 25_000,
        responseType: 'arraybuffer',
      });

      const contentType = ((response.headers['content-type'] as string) ?? '').toLowerCase();
      logger.info(`[CBE/legacy] Response content-type: ${contentType}`);

      if (contentType.includes('application/pdf')) {
        // ── PDF path ──────────────────────────────────────────────────────────
        logger.info('[CBE/legacy] Detected PDF receipt — extracting text with pdf-parse');
        const pdfParser = new PDFParse({ data: Buffer.from(response.data) });
        let pdfText: string;
        try {
          const result = await pdfParser.getText();
          pdfText = result.text;
        } finally {
          await pdfParser.destroy().catch(() => undefined);
        }
        if (process.env.LOG_CHECK_RAW === '1') {
          logger.debug(`[CBE/legacy-pdf] Extracted text (first 3000 chars):\n${pdfText.slice(0, 3000)}`);
        }
        return parseCbePdfText(pdfText);
      } else {
        // ── HTML path ─────────────────────────────────────────────────────────
        const html = Buffer.from(response.data).toString('utf8');
        if (process.env.LOG_CHECK_RAW === '1') {
          logger.debug(`[CBE/legacy] Raw HTML (first 2000 chars): ${html.slice(0, 2000)}`);
        }
        return parseLegacyHtml(html);
      }
    } catch (err: any) {
      const axiosErr = err as AxiosError;

      if (axiosErr.response?.status === 404) {
        return { success: false, error: 'CBE legacy receipt not found.', statusCode: 404 };
      }

      if (isRetryable(axiosErr) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(`[CBE/legacy] Network error, retrying in ${delay}ms… [${axiosErr.code}]`);
        await sleep(delay);
        continue;
      }

      logger.warn(`[CBE/legacy] Failed: ${axiosErr.message}`);
      return { success: false, error: axiosErr.message, statusCode: axiosErr.response?.status ?? 502 };
    }
  }

  return { success: false, error: 'CBE legacy request failed after retries.', statusCode: 502 };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Verify a CBE payment using the bank's official endpoints directly.
 *
 * @param reference — One of:
 *   - New receipt URL:  https://mbreciept.cbe.com.et/<TOKEN>
 *   - New token:        fHCxyV4mg5pRIwEkJO  (15–60 alphanumeric chars, not FT-prefixed)
 *   - Legacy URL:       https://apps.cbe.com.et:100/?id=FT...{8-digit suffix}
 *   - FT reference:     FT26149ABC  (needs accountNumber for legacy confirmation)
 *
 * @param accountNumber — Full 13-digit receiving account (required for FT references only).
 */
export async function verifyCBE(reference: string, accountNumber?: string): Promise<VerifyResult> {
  const ref = reference.trim();

  // ── New receipt URL ─────────────────────────────────────────────────────────
  const newUrlMatch = ref.match(MBRECIEPT_URL_RE);
  if (newUrlMatch) {
    return verifyByToken(newUrlMatch[1]);
  }

  // ── New receipt token (not an FT reference) ─────────────────────────────────
  if (TOKEN_RE.test(ref) && !FT_RE.test(ref)) {
    return verifyByToken(ref);
  }

  // ── Legacy apps.cbe.com.et URL ──────────────────────────────────────────────
  if (LEGACY_APPS_URL_RE.test(ref)) {
    try {
      const parsed = new URL(ref);
      const combinedId = parsed.searchParams.get('id') ?? '';
      if (!combinedId) {
        return { success: false, error: 'Legacy CBE URL is missing the id parameter.', statusCode: 400 };
      }
      return verifyByLegacyUrl(combinedId);
    } catch {
      return { success: false, error: 'Could not parse legacy CBE URL.', statusCode: 400 };
    }
  }

  // ── FT reference ────────────────────────────────────────────────────────────
  if (FT_RE.test(ref)) {
    const acct = (accountNumber ?? '').replace(/\D/g, '');
    if (acct.length !== ACCOUNT_LENGTH) {
      return {
        success: false,
        error: `A full ${ACCOUNT_LENGTH}-digit receiver account is required for FT references.`,
        statusCode: 400,
      };
    }
    // Build the combined ID the legacy portal expects: FT...{last-8-digits-of-account}
    const suffix = acct.slice(-8);
    return verifyByLegacyUrl(`${ref.toUpperCase()}${suffix}`);
  }

 
  return { success: false, error: 'Unrecognised CBE reference format.', statusCode: 400 };
}