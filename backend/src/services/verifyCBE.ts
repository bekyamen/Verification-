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
import { cbeCache } from '../utils/verifyCache';

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
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 150;
/** Timeout for the v2 token endpoint — kept short so ISP blocks fail fast. */
const TOKEN_TIMEOUT_MS = 3_000;
/** Timeout for the legacy apps.cbe.com.et portal — kept short; hedging covers slowness. */
const LEGACY_TIMEOUT_MS = 4_500;

// Keep-alive agents — reuses TCP connections across requests (saves ~300 ms handshake)
const tokenAgent  = new https.Agent({ keepAlive: true });
const legacyAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// ── Token-endpoint circuit breaker ────────────────────────────────────────────
// Tracks consecutive network-level failures (ECONNABORTED, ETIMEDOUT, etc.).
// After CIRCUIT_OPEN_THRESHOLD failures, the breaker opens for CIRCUIT_RESET_MS.
// While open, callers skip the token fetch and receive FAILED_UPSTREAM immediately,
// saving TOKEN_TIMEOUT_MS × accounts of dead-wait time per request.
const CIRCUIT_OPEN_THRESHOLD = 1;  // open after the first network failure
const CIRCUIT_RESET_MS       = 60_000; // stay open for 60 s then auto-reset

let _circuitFailures  = 0;
let _circuitOpenUntil = 0; // epoch ms; 0 = closed

function circuitIsOpen(): boolean {
  if (_circuitOpenUntil && Date.now() < _circuitOpenUntil) return true;
  if (_circuitOpenUntil && Date.now() >= _circuitOpenUntil) {
    // Half-open: allow one probe through, reset counter
    _circuitOpenUntil = 0;
    _circuitFailures  = 0;
  }
  return false;
}

function circuitOnSuccess(): void {
  _circuitFailures  = 0;
  _circuitOpenUntil = 0;
}

function circuitOnFailure(): void {
  _circuitFailures++;
  if (_circuitFailures >= CIRCUIT_OPEN_THRESHOLD) {
    _circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
    logger.warn(`[CBE/circuit] Token endpoint circuit OPEN — will skip for ${CIRCUIT_RESET_MS / 1000}s`);
  }
}

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

// ── 1a. Helper: parse JSON object as a CBE receipt ─────────────────────────────

function tryExtractFromJsonObject(obj: any, token: string): VerifyResult | null {
  if (!obj || typeof obj !== 'object') return null;
  const d: any = obj?.data ?? obj;
  if (!d || typeof d !== 'object') return null;

  const statusField = (d.status ?? d.transactionStatus ?? '').toString().toUpperCase();
  if (statusField && !['', 'SUCCESS', 'COMPLETED', 'SUCCESSFUL'].includes(statusField)) return null;

  const amount = toNumber(
    d.debitAmount ?? d.amount ?? d.transferredAmount ?? d.settledAmount ??
    d.creditAmount ?? d.totalAmount ?? d.transactionAmount ?? d.paidAmount ??
    d.principal ?? d.value ?? d.netAmount ?? d.credit ?? d.debit ??
    d.txnAmount ?? d.transAmount ?? d.transferAmount ?? d.originalAmount ??
    d.txn_amount ?? d.trans_amount ?? d.transfer_amount ??
    (d.transaction as any)?.amount ?? (d.transaction as any)?.debitAmount ??
    (d.data as any)?.amount ?? (d.data as any)?.debitAmount
  );
  if (amount === undefined) return null;

  return {
    success: true,
    payer:           d.debitAccountHolder  ?? d.debitAccountName  ?? d.payerName   ?? d.senderName  ?? undefined,
    payerAccount:    d.debitAccountNo      ?? d.payerAccount      ?? undefined,
    receiver:        d.creditAccountHolder ?? d.creditAccountName ?? d.receiverName ?? undefined,
    receiverAccount: d.creditAccountNo     ?? d.receiverAccount   ?? undefined,
    amount,
    date:      parseCBEDate(d.processingDate ?? d.transactionDate ?? d.date ?? d.dateTime),
    reference: d.id ?? d.transactionId ?? d.reference ?? token,
    reason:    Array.isArray(d.paymentDetails)
      ? d.paymentDetails.join(' ')
      : (d.description ?? d.narrative ?? d.reason ?? null),
  };
}

// ── 1b. Helper: extract receipt data from a CBE SPA HTML page ────────────────
// The receipt viewer is a Next.js SPA. When our server fetches the token URL it
// gets the HTML shell. We recover the data by:
//   1. Reading the __NEXT_DATA__ JSON island Next.js embeds in every SSR page.
//   2. Scanning any <script type="application/json"> blocks.
//   3. Probing the most likely REST sub-paths that the SPA's JS would call.

async function extractFromHtmlSpa(html: string, token: string): Promise<VerifyResult> {
  const $ = cheerio.load(html);

  // Strategy 1: __NEXT_DATA__ island (present on SSR/ISR Next.js pages)
  const nextDataText = $('#__NEXT_DATA__').text().trim();
  if (nextDataText) {
    try {
      const nextData = JSON.parse(nextDataText);
      // Walk common locations: pageProps, pageProps.receipt, pageProps.transaction, etc.
      const candidates = [
        nextData?.props?.pageProps,
        nextData?.props?.pageProps?.receipt,
        nextData?.props?.pageProps?.transaction,
        nextData?.props?.pageProps?.data,
      ];
      for (const c of candidates) {
        const r = tryExtractFromJsonObject(c, token);
        if (r) {
          logger.info('[CBE/spa] Extracted receipt from __NEXT_DATA__');
          return r;
        }
      }
    } catch {
      /* malformed JSON — ignore */ }
  }

  // Strategy 2: any <script type="application/json"> or similar data islands
  let jsonIslandResult: VerifyResult | null = null;
  $('script[type="application/json"], script[type="application/ld+json"]').each((_i, el) => {
    if (jsonIslandResult) return; // already found one
    try {
      const parsed = JSON.parse($(el).text().trim());
      const r = tryExtractFromJsonObject(parsed, token);
      if (r) {
        logger.info('[CBE/spa] Extracted receipt from embedded <script> JSON island');
        jsonIslandResult = r;
      }
    } catch { /* ignore */ }
  });
  if (jsonIslandResult) return jsonIslandResult;

  // Strategy 3: probe probable REST API sub-paths the SPA's JS calls
  const apiPaths = [
    `/api/${token}`,
    `/api/receipt/${token}`,
    `/api/receipts/${token}`,
    `/api/transaction/${token}`,
    `/api/v1/receipt/${token}`,
    `/api/v2/receipt/${token}`,
    `/receipt/api/${token}`,
  ];

  const commonHeaders = {
    'X-App-ID': CBE_APP_ID,
    'X-App-Version': CBE_APP_VERSION,
    'Accept': 'application/json',
    'Origin': 'https://mbreciept.cbe.com.et',
    'Referer': `https://mbreciept.cbe.com.et/${token}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  for (const path of apiPaths) {
    const apiUrl = `${CBE_JSON_API_BASE}${path}`;
    try {
      logger.info(`[CBE/spa] Probing API sub-path: ${apiUrl}`);
      const apiRes = await axios.get(apiUrl, {
        headers: commonHeaders,
        timeout: 5_000,
        responseType: 'arraybuffer',
        // Don't throw on 4xx/5xx so we can inspect the body
        validateStatus: () => true,
      });
      const apiBuf = Buffer.from(apiRes.data);
      const apiCT  = ((apiRes.headers['content-type'] as string) ?? '').toLowerCase();

      if (apiCT.includes('application/pdf') || apiBuf.slice(0, 8).toString('ascii').startsWith('%PDF')) {
        logger.info(`[CBE/spa] Sub-path ${path} returned a PDF — parsing`);
        const pdfParser = new PDFParse({ data: apiBuf });
        try {
          const res = await pdfParser.getText();
          return parseCbePdfText(res.text);
        } finally {
          await pdfParser.destroy().catch(() => undefined);
        }
      }

      if (apiCT.includes('application/json') || (apiRes.status >= 200 && apiRes.status < 300)) {
        try {
          const json = JSON.parse(apiBuf.toString('utf8'));
          const r = tryExtractFromJsonObject(json, token);
          if (r) {
            logger.info(`[CBE/spa] Extracted receipt from API sub-path: ${path}`);
            return r;
          }
        } catch { /* not JSON */ }
      }
    } catch (e: any) {
      logger.debug(`[CBE/spa] Sub-path ${path} failed: ${e.message}`);
    }
  }

  // Log a snippet of the HTML so future debugging is easier
  logger.warn(`[CBE/spa] Could not extract receipt from SPA. HTML title: "${$('title').text()}". All API sub-paths exhausted.`);
  if (process.env.LOG_CHECK_RAW === '1') {
    logger.debug(`[CBE/spa] HTML preview (1000 chars): ${html.slice(0, 1000)}`);
  }
  return { success: false, error: 'CBE receipt page is a client-side SPA and no API sub-path returned receipt data.', statusCode: 502 };
}

// ── 1c. NEW CBE receipt token → JSON / PDF / SPA ─────────────────────────────

async function verifyByToken(token: string): Promise<VerifyResult> {
  // ── Feature flag ─────────────────────────────────────────────────────────────
  // The CBE receipt viewer (mbreciept.cbe.com.et) currently returns an HTML SPA
  // shell that exposes no usable API sub-paths, so every token lookup wastes ~7 s
  // before falling through to the legacy FT route.  Keep this route disabled until
  // the viewer starts returning JSON again.  Set CBE_TOKEN_ROUTE=on to re-enable.
  if (process.env.CBE_TOKEN_ROUTE !== 'on') {
    logger.info('[CBE/token] Skipped — set CBE_TOKEN_ROUTE=on to enable (SPA returns no data).');
    return { success: false, error: 'CBE receipt-link lookup is disabled (viewer returns no data).', statusCode: 502 };
  }

  // URL format: https://mbreciept.cbe.com.et/v2-{token}
  // token already contains the "v2-" prefix (e.g. "v2-hfHCxHm0dwBHOQSgWNOf")
  const url = `${CBE_JSON_API_BASE}/${token}`;

  // ── Circuit-breaker check ────────────────────────────────────────────────────
  if (circuitIsOpen()) {
    logger.warn('[CBE/token] Circuit is OPEN — fast-failing to allow legacy/FT fallback');
    return { success: false, error: 'CBE token endpoint unreachable (circuit open).', statusCode: 502 };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Re-check circuit at the start of every retry: if attempt 1 opened it,
    // skip attempt 2 immediately instead of waiting for another full timeout.
    if (attempt > 1 && circuitIsOpen()) {
      logger.warn(`[CBE/token] Circuit opened during attempt ${attempt - 1} — skipping remaining retries`);
      break;
    }
    try {
      logger.info(`[CBE/token] Fetching (attempt ${attempt}/${MAX_RETRIES}): ${url}`);

      // Download as binary so we can detect PDF before parsing
      const response = await axios.get(url, {
        httpsAgent: tokenAgent,
        headers: {
          'X-App-ID': CBE_APP_ID,
          'X-App-Version': CBE_APP_VERSION,
          'Accept': 'application/json, application/pdf, */*',
          'Origin': 'https://mbreciept.cbe.com.et',
          'Referer': 'https://mbreciept.cbe.com.et/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: TOKEN_TIMEOUT_MS,
        responseType: 'arraybuffer',
      });
      circuitOnSuccess(); // Received a response — endpoint is reachable

      const buf = Buffer.from(response.data);
      const contentType = ((response.headers['content-type'] as string) ?? '').toLowerCase();

      // ── PDF path ────────────────────────────────────────────────────────────
      // The v2 endpoint sometimes returns a PDF instead of JSON.
      // Detect by content-type OR the %PDF magic bytes in the first 8 bytes.
      const isPdf =
        contentType.includes('application/pdf') ||
        buf.slice(0, 8).toString('ascii').startsWith('%PDF');

      if (isPdf) {
        logger.info('[CBE/token] Response is a PDF — extracting text with pdf-parse');
        if (process.env.LOG_CHECK_RAW === '1') {
          logger.debug(`[CBE/token] PDF size: ${buf.length} bytes`);
        }
        const pdfParser = new PDFParse({ data: buf });
        let pdfText: string;
        try {
          const result = await pdfParser.getText();
          pdfText = result.text;
        } finally {
          await pdfParser.destroy().catch(() => undefined);
        }
        if (process.env.LOG_CHECK_RAW === '1') {
          logger.debug(`[CBE/token] PDF text (first 3000 chars):\n${pdfText.slice(0, 3000)}`);
        }
        return parseCbePdfText(pdfText);
      }

      // ── HTML SPA path ────────────────────────────────────────────────────────
      const isHtml = contentType.includes('text/html') || buf.slice(0, 15).toString('utf8').trimStart().startsWith('<');
      if (isHtml) {
        logger.info('[CBE/token] Response is an HTML SPA page — probing for API sub-paths');
        return extractFromHtmlSpa(buf.toString('utf8'), token);
      }

      // ── JSON path ───────────────────────────────────────────────────────────
      let data: any;
      try {
        data = JSON.parse(buf.toString('utf8'));
      } catch {
        // Not JSON, not PDF, not HTML — log and fail gracefully
        const preview = buf.toString('utf8').slice(0, 200);
        logger.warn(`[CBE/token] Response is neither JSON, PDF, nor HTML. Preview: ${preview}`);
        return { success: false, error: 'CBE API returned an unrecognised response format.', statusCode: 502 };
      }

      // Always log the raw response for debugging amount field issues
      logger.debug(`[CBE/token] Raw JSON response: ${JSON.stringify(data)}`);

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

      // Log every key we see so we can identify new field names in production
      logger.info(`[CBE/token] Response keys: ${Object.keys(d).join(', ')}`);

      // Real API field is "debitAmount"; fall back to all known variants.
      const amount = toNumber(
        d.debitAmount ?? d.amount ?? d.transferredAmount ?? d.settledAmount ??
        d.creditAmount ?? d.totalAmount ?? d.transactionAmount ?? d.paidAmount ??
        d.principal ?? d.value ?? d.netAmount ?? d.credit ?? d.debit ??
        d.txnAmount ?? d.transAmount ?? d.transferAmount ?? d.originalAmount ??
        d.txn_amount ?? d.trans_amount ?? d.transfer_amount ??
        // Also check one level nested (e.g. { transaction: { amount: 30 } })
        (d.transaction as any)?.amount ?? (d.transaction as any)?.debitAmount ??
        (d.data as any)?.amount ?? (d.data as any)?.debitAmount
      );
      if (amount === undefined) {
        logger.warn(`[CBE/token] Response had no usable amount field. Keys: ${Object.keys(d).join(', ')} | Full: ${JSON.stringify(d).slice(0, 500)}`);
        return { success: false, error: 'CBE API response missing amount.', statusCode: 502 };
      }

      // Real API: date is in processingDate ("YYYYMMDD"), names use "Holder" suffix
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

      // ── 502 with PDF body ─────────────────────────────────────────────────────
      // CBE's gateway sometimes returns HTTP 502 but the response body is the real
      // PDF receipt. Axios treats 502 as an error, so we must fish the body out of
      // the error object and run the same PDF path we would on a 200.
      if (axiosErr.response?.status === 502 && axiosErr.response?.data) {
        try {
          const errBuf = Buffer.from(axiosErr.response.data as ArrayBuffer);
          const errCT  = ((axiosErr.response.headers?.['content-type'] as string) ?? '').toLowerCase();
          const errIsPdf =
            errCT.includes('application/pdf') ||
            errBuf.slice(0, 8).toString('ascii').startsWith('%PDF');

          if (errIsPdf) {
            logger.info('[CBE/token] 502 response contains a PDF body — extracting with pdf-parse');
            const pdfParser = new PDFParse({ data: errBuf });
            let pdfText: string;
            try {
              const result = await pdfParser.getText();
              pdfText = result.text;
            } finally {
              await pdfParser.destroy().catch(() => undefined);
            }
            if (process.env.LOG_CHECK_RAW === '1') {
              logger.debug(`[CBE/token] PDF (from 502) text (first 3000 chars):\n${pdfText.slice(0, 3000)}`);
            }
            return parseCbePdfText(pdfText);
          }

          // 502 with HTML (SPA shell) — probe API sub-paths
          const errIsHtml = errCT.includes('text/html') || errBuf.slice(0, 15).toString('utf8').trimStart().startsWith('<');
          if (errIsHtml) {
            logger.info('[CBE/token] 502 body is HTML — probing SPA API sub-paths');
            return extractFromHtmlSpa(errBuf.toString('utf8'), token);
          }

          // 502 with an unknown body — log for diagnostics
          const bodyPreview = errBuf.toString('utf8').slice(0, 300);
          logger.warn(`[CBE/token] 502 body (unknown content): ${bodyPreview}`);
        } catch (innerErr: any) {
          logger.warn(`[CBE/token] Failed to inspect 502 body: ${innerErr.message}`);
        }
      }

      if (axiosErr.response?.status === 404) {
        return { success: false, error: 'CBE receipt not found.', statusCode: 404 };
      }
      if (axiosErr.response?.status === 401 || axiosErr.response?.status === 403) {
        return { success: false, error: 'CBE API authentication failed. Check CBE_APP_ID/CBE_APP_VERSION.', statusCode: 503 };
      }

      if (isRetryable(axiosErr)) {
        circuitOnFailure();
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
          logger.warn(`[CBE/token] Network error, retrying in ${delay}ms… [${axiosErr.code}]`);
          await sleep(delay);
          continue;
        }
      }

      const msg = axiosErr.message;
      logger.warn(`[CBE/token] Failed (${axiosErr.response?.status ?? 'no-status'}): ${msg}`);
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

/**
 * Start `run`, and if it has not resolved/rejected after `hedgeAfterMs`, launch
 * another copy. First result wins; all others are discarded.
 */
function hedged<T>(run: () => Promise<T>, hedgeAfterMs = 2_500, max = 3): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let launched = 0, pending = 0, done = false, lastErr: unknown;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const launch = () => {
      if (done || launched >= max) return;
      launched++; pending++;
      if (launched < max) timer = setTimeout(launch, hedgeAfterMs);

      run().then(
        (v) => finish(() => resolve(v)),
        (e) => {
          lastErr = e; pending--;
          if (done) return;
          if (launched < max) { if (timer) clearTimeout(timer); launch(); }
          else if (pending === 0) finish(() => reject(lastErr));
        },
      );
    };

    launch();
  });
}

type LegacyBody =
  | { notFound: true }
  | { notFound: false; buf: Buffer; contentType: string };

// Hard cap per request. Target ≤5 s total. Raise via env-vars if CBE is consistently slower.
const LEGACY_TOTAL_TIMEOUT_MS = Number(process.env.CBE_LEGACY_TIMEOUT_MS ?? 4_500);
const LEGACY_HEDGE_MS         = Number(process.env.CBE_HEDGE_MS          ?? 2_000);
const LEGACY_HEDGE_MAX        = Number(process.env.CBE_HEDGE_MAX          ?? 2);   // 2 = hedge after 2 s

async function legacyFetchOnce(url: string, t0: number): Promise<LegacyBody> {
  const s = Date.now();
  try {
    const response = await axios.get(url, {
      httpsAgent: legacyAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*',
      },
      timeout: LEGACY_TOTAL_TIMEOUT_MS,
      // axios `timeout` only covers idle sockets; this caps the whole request
      signal: AbortSignal.timeout(LEGACY_TOTAL_TIMEOUT_MS),
      responseType: 'arraybuffer',
    });
    logger.info(`[CBE/legacy] attempt started +${s - t0}ms, answered in ${Date.now() - s}ms`);
    return {
      notFound: false,
      buf: Buffer.from(response.data),
      contentType: ((response.headers['content-type'] as string) ?? '').toLowerCase(),
    };
  } catch (err) {
    if ((err as AxiosError).response?.status === 404) return { notFound: true };
    logger.warn(`[CBE/legacy] attempt started +${s - t0}ms, failed after ${Date.now() - s}ms: ${(err as Error).message}`);
    throw err; // let hedged() start another copy when hedging is on
  }
}

async function verifyByLegacyUrl(combinedId: string): Promise<VerifyResult> {
  const url = `${CBE_LEGACY_BASE}/?id=${combinedId}`;
  const t0 = Date.now();
  try {
    const body = await hedged(() => legacyFetchOnce(url, t0), LEGACY_HEDGE_MS, LEGACY_HEDGE_MAX);
    const fetchMs = Date.now() - t0;
    if (body.notFound) {
      logger.info(`[CBE/legacy] 404 after ${fetchMs}ms`);
      return { success: false, error: 'CBE legacy receipt not found.', statusCode: 404 };
    }

    const t1 = Date.now();
    let result: VerifyResult;
    const isPdf = body.contentType.includes('application/pdf') || body.buf.subarray(0, 4).toString('latin1') === '%PDF';
    if (isPdf) {
      const parser = new PDFParse({ data: body.buf });
      try {
        result = parseCbePdfText((await parser.getText()).text);
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    } else {
      const html = body.buf.toString('utf8');
      if (process.env.LOG_CHECK_RAW === '1') {
        logger.debug(`[CBE/legacy] Raw HTML (first 2000 chars): ${html.slice(0, 2000)}`);
      }
      result = parseLegacyHtml(html);
    }
    logger.info(`[CBE/legacy] fetch=${fetchMs}ms parse=${Date.now() - t1}ms`);
    return result;
  } catch (err: any) {
    logger.warn(`[CBE/legacy] failed after ${Date.now() - t0}ms: ${err.message}`);
    return { success: false, error: err.message, statusCode: (err as AxiosError).response?.status ?? 502 };
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

const WARM_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF',
);

export async function warmPdf(): Promise<void> {
  const p = new PDFParse({ data: WARM_PDF });
  try { await p.getText(); } catch { /* best effort */ } finally { await p.destroy().catch(() => undefined); }
}

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

/** Cache successes only. On failure return the real error instead of running the lookup again. */
async function cachedLookup(key: string, run: () => Promise<VerifyResult>): Promise<VerifyResult> {
  let failure: VerifyResult | null = null;
  const hit = await cbeCache.getOrFetch(key, async () => {
    const r = await run();
    if (r.success) return r;
    failure = r;
    return null;
  });
  const f = failure as VerifyResult | null;
  // run() again only if another caller's in-flight fetch failed and we never saw its error
  return hit ?? f ?? run();
}

export async function verifyCBE(reference: string, accountNumber?: string): Promise<VerifyResult> {
  const ref = reference.trim();

  // ── New receipt URL ─────────────────────────────────────────────────────────
  const newUrlMatch = ref.match(MBRECIEPT_URL_RE);
  if (newUrlMatch) {
    const token = newUrlMatch[1];
    return cachedLookup(token, () => verifyByToken(token));
  }

  // ── New receipt token (not an FT reference) ─────────────────────────────────
  if (TOKEN_RE.test(ref) && !FT_RE.test(ref)) {
    return cachedLookup(ref, () => verifyByToken(ref));
  }

  // ── Legacy apps.cbe.com.et URL ──────────────────────────────────────────────
  if (LEGACY_APPS_URL_RE.test(ref)) {
    try {
      const combinedId = new URL(ref).searchParams.get('id') ?? '';
      if (!combinedId) {
        return { success: false, error: 'Legacy CBE URL is missing the id parameter.', statusCode: 400 };
      }
      return cachedLookup(combinedId, () => verifyByLegacyUrl(combinedId));
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
    const combinedId = `${ref.toUpperCase()}${acct.slice(-8)}`;
    return cachedLookup(combinedId, () => verifyByLegacyUrl(combinedId));
  }

  return { success: false, error: 'Unrecognised CBE reference format.', statusCode: 400 };
}