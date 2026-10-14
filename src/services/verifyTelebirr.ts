/**
 * verifyTelebirr.ts
 *
 * Self-hosted Telebirr verification — no external api.check.et dependency.
 *
 * Fetches the official Telebirr receipt page at:
 *   https://transactioninfo.ethiotelecom.et/receipt/{RECEIPT_NO}
 *   https://transactioninfo.ethiotelecom.et/receipt/view?transactionno={RECEIPT_NO}
 *
 * The page is server-rendered HTML containing bilingual (English + Amharic)
 * key-value rows. We parse with Cheerio.
 */

import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import logger from '../utils/logger';

const TELEBIRR_RECEIPT_BASE = 'https://transactioninfo.ethiotelecom.et/receipt';
const TELEBIRR_RECEIPT_VIEW = 'https://transactioninfo.ethiotelecom.et/receipt/view';

// Some Telebirr domains have self-signed / untrusted leaf certificates
const agent = new https.Agent({ rejectUnauthorized: false });

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_500;

export interface TelebirrReceipt {
  payerName: string;
  payerTelebirrNo: string;
  creditedPartyName: string;
  creditedPartyAccountNo: string;
  transactionStatus: string;
  receiptNo: string;
  paymentDate: string;
  settledAmount: string;
  serviceFee: string;
  serviceFeeVAT: string;
  totalPaidAmount: string;
  bankName: string;
  customerNote: string;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: AxiosError): boolean {
  if (err.response) return false;
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(err.code ?? '');
}

/**
 * Parse the Telebirr receipt HTML page.
 *
 * The page typically has a structure like:
 *   <table>
 *     <tr><td>Payer Name</td><td>ABEBE KEBEDE</td></tr>
 *     <tr><td>Payer Telebirr No</td><td>251912345678</td></tr>
 *     ...
 *   </table>
 *
 * Labels appear in both English and Amharic. We target English labels.
 */
function parseTelebirrHtml(html: string, inputRef: string): TelebirrReceipt {
  const $ = cheerio.load(html);

  // Build a normalised label → value map from all table rows, dl/dt/dd, and div pairs
  const fields: Record<string, string> = {};

  const normalise = (s: string) =>
    s.trim()
      .toLowerCase()
      .replace(/[/ዊ-ፙ\u1200-\u137f]+/g, '') // strip Amharic characters in the key
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  // Strategy 1: two-column <tr>
  $('tr').each((_i, row) => {
    const tds = $(row).find('td');
    if (tds.length >= 2) {
      const key = normalise($(tds[0]).text());
      const val = $(tds[1]).text().trim();
      if (key && val) fields[key] = val;
    }
  });

  // Strategy 2: <dl><dt>key</dt><dd>val</dd></dl>
  $('dl').each((_i, dl) => {
    const dts = $(dl).find('dt');
    const dds = $(dl).find('dd');
    dts.each((i, dt) => {
      const key = normalise($(dt).text());
      const val = $(dds.eq(i)).text().trim();
      if (key && val) fields[key] = val;
    });
  });

  // Strategy 3: paired divs / spans with label class
  $('[class*="label"],[class*="key"],[class*="title"]').each((_i, el) => {
    const key = normalise($(el).text());
    const val = $(el).siblings('[class*="value"],[class*="data"],[class*="content"]').first().text().trim()
      || $(el).next().text().trim();
    if (key && val) fields[key] = val;
  });

  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const nk = normalise(k);
      if (fields[nk]) return fields[nk];
      // Also try without spaces
      const compact = nk.replace(/\s/g, '');
      for (const fk of Object.keys(fields)) {
        if (fk.replace(/\s/g, '') === compact) return fields[fk];
      }
    }
    return '';
  };

  // Fallback: raw page text for regex
  const pageText = $('body').text().replace(/\s+/g, ' ');

  const pickOrRegex = (keys: string[], pattern: RegExp): string => {
    const found = pick(...keys);
    if (found) return found;
    const m = pageText.match(pattern);
    return m ? m[1].trim() : '';
  };

  // ── Field extraction ────────────────────────────────────────────────────────
  const payerName = pick('Payer Name', 'Sender Name', 'From');
  const payerTelebirrNo = pick('Payer Telebirr No', 'Payer Account', 'Sender Phone', 'Payer Phone', 'Sender Number');
  const creditedPartyName = pick('Credited Party Name', 'Receiver Name', 'Beneficiary Name', 'To Name');
  const creditedPartyAccountNo = pick(
    'Credited Party Account No', 'Receiver Account', 'Receiver Phone',
    'Beneficiary Number', 'To', 'Recipient Number'
  );
  const transactionStatus = pick('Transaction Status', 'Status', 'Payment Status') || 'Completed';
  const receiptNo = pickOrRegex(
    ['Receipt No', 'Receipt Number', 'Transaction ID', 'Transaction No', 'Reference'],
    /(?:Receipt\s*No|Transaction\s*(?:ID|No))\s*[:\s]+([A-Z0-9]{6,20})/i
  ) || inputRef;
  const paymentDate = pick('Payment Date', 'Date', 'Transaction Date', 'Date & Time');
  // settledAmount is extracted below via multi-strategy approach
  const serviceFee = pick('Service Fee', 'Fee', 'Service Charge');
  const serviceFeeVAT = pick('Service Fee VAT', 'Fee VAT', 'VAT');
  const bankName = pick('Bank Name', 'Bank', 'Institution') || 'Telebirr';
  const customerNote = pick('Customer Note', 'Note', 'Remark', 'Narrative', 'Description');

  // ── Amount extraction: multi-strategy ────────────────────────────────────────
  // The Telebirr receipt page sometimes collapses the entire invoice section into
  // a single <td> key cell. We need to scan both the structured fields map AND the
  // raw page text to reliably extract amounts.

  // Strategy A: standard structured pick (using pickOrRegex for regex fallback too)
  let settledAmount = pickOrRegex(
    ['Settled Amount', 'Transaction Amount', 'Transferred Amount'],
    /(?:Settled|Transaction|Transferred)\s+Amount\s*[:\s]+([\d,]+\.?\d*)/i
  );
  let totalPaidAmount = pick('Total Paid Amount', 'Total Amount', 'Total');

  // Strategy B: scan the compound key strings of the fields map
  // e.g. key = "...settled amount dj90kv28yu 09102026 000445 5 birr..."
  if (!settledAmount || settledAmount === '0.0' || settledAmount === '0') {
    // Find the key that contains "settled amount" and extract the Birr value from it
    for (const [k, _v] of Object.entries(fields)) {
      // Look for pattern: "settled amount <ref> <date> <amount> birr"
      const m = k.match(/settled\s+amount\s+[a-z0-9]+\s+[\d\/\-\.]+\s+([\d,]+(?:\.\d+)?)\s*birr/i);
      if (m) { settledAmount = m[1].replace(/,/g, ''); break; }
    }
  }

  if (!totalPaidAmount || totalPaidAmount === '0.0' || totalPaidAmount === '0') {
    // Find key containing "total paid amount N birr"
    for (const [k, _v] of Object.entries(fields)) {
      const m = k.match(/total\s+paid\s+amount\s+([\d,]+(?:\.\d+)?)\s*birr/i);
      if (m) { totalPaidAmount = m[1].replace(/,/g, ''); break; }
    }
  }

  // Strategy C: scan raw page text
  if (!settledAmount || settledAmount === '0.0' || settledAmount === '0') {
    // "Settled Amount ... 5 Birr" (word boundary, allow separators)
    const mS = pageText.match(/settled\s+amount\s+[^a-z]*?([\d,]+(?:\.\d+)?)\s*birr/i);
    if (mS) settledAmount = mS[1].replace(/,/g, '');
  }

  if (!totalPaidAmount || totalPaidAmount === '0.0' || totalPaidAmount === '0') {
    const mT = pageText.match(/total\s+paid\s+amount\s+([\d,]+(?:\.\d+)?)\s*birr/i);
    if (mT) totalPaidAmount = mT[1].replace(/,/g, '');
  }

  // Strategy D: "Total Amount in word" → parse numeric words as a last resort
  // e.g. "six birr and zero cent" → 6
  const WORD_NUMS: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    hundred: 100, thousand: 1000,
  };
  if ((!totalPaidAmount || totalPaidAmount === '0.0' || totalPaidAmount === '0') && !settledAmount) {
    const wordMatch = pageText.match(/total\s+amount\s+in\s+word[:\s]+([a-z\s]+)\s+birr/i)
      || pageText.match(/total\s+paid\s+amount.*?([a-z]+)\s+birr/i);
    if (wordMatch) {
      const wordStr = wordMatch[1].toLowerCase().trim();
      const words = wordStr.split(/\s+/);
      let numValue = 0, current = 0;
      for (const w of words) {
        const v = WORD_NUMS[w];
        if (v === undefined) continue;
        if (v === 100) { current = current === 0 ? 100 : current * 100; }
        else if (v === 1000) { numValue += (current === 0 ? 1 : current) * 1000; current = 0; }
        else { current += v; }
      }
      numValue += current;
      if (numValue > 0) {
        totalPaidAmount = String(numValue);
        logger.info(`[Telebirr] Amount extracted from word form: "${wordStr}" → ${numValue}`);
      }
    }
  }

  logger.info(`[Telebirr] settledAmountRaw="${settledAmount}" totalPaidAmountRaw="${totalPaidAmount}"`);

  // Always log extracted fields so we can diagnose amount-parsing failures
  logger.info(`[Telebirr] Extracted fields: ${JSON.stringify(fields)}`);
  logger.info(`[Telebirr] Raw page text snippet: ${pageText.slice(0, 500)}...`);

  return {
    payerName,
    payerTelebirrNo,
    creditedPartyName,
    creditedPartyAccountNo,
    transactionStatus,
    receiptNo,
    paymentDate,
    settledAmount,
    serviceFee,
    serviceFeeVAT,
    totalPaidAmount,
    bankName,
    customerNote,
  };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchReceiptHtml(url: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`[Telebirr] Fetching receipt HTML (attempt ${attempt}/${MAX_RETRIES}): ${url}`);

      const { data } = await axios.get<string>(url, {
        httpsAgent: agent,
        headers: BROWSER_HEADERS,
        timeout: 30_000,
        responseType: 'text',
        maxRedirects: 5,
      });

      return data;
    } catch (err: any) {
      const axiosErr = err as AxiosError;

      if (axiosErr.response?.status === 404) {
        const e = new Error('Telebirr receipt not found.');
        (e as any).statusCode = 404;
        throw e;
      }

      if (isRetryable(axiosErr) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(`[Telebirr] Network error, retrying in ${delay}ms… [${axiosErr.code}]`);
        await sleep(delay);
        continue;
      }

      const e = new Error(axiosErr.message);
      (e as any).statusCode = axiosErr.response?.status ?? 502;
      throw e;
    }
  }

  const e = new Error('Telebirr receipt fetch failed after retries.');
  (e as any).statusCode = 502;
  throw e;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Verify a Telebirr transaction using the official Ethio Telecom receipt portal.
 *
 * @param reference — One of:
 *   - Full URL: https://transactioninfo.ethiotelecom.et/receipt/DJD5QVJV5EN
 *   - Raw transaction ID: DJD5QVJV5EN
 */
export async function verifyTelebirr(reference: string): Promise<TelebirrReceipt | null> {
  const ref = reference.trim();

  // ── Determine URL ───────────────────────────────────────────────────────────
  let receiptUrl: string;

  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    receiptUrl = ref;
  } else {
    // Try the path-based URL first; view URL is the alternate
    receiptUrl = `${TELEBIRR_RECEIPT_BASE}/${encodeURIComponent(ref)}`;
  }

  // ── Attempt 1: path-based URL ───────────────────────────────────────────────
  let html: string;
  try {
    html = await fetchReceiptHtml(receiptUrl);
  } catch (err: any) {
    // If the path-based URL 404s and we started with a raw ID, try the view URL
    if ((err as any).statusCode === 404 && !reference.startsWith('http')) {
      logger.info(`[Telebirr] Path URL not found, trying view URL for: ${ref}`);
      try {
        html = await fetchReceiptHtml(`${TELEBIRR_RECEIPT_VIEW}?transactionno=${encodeURIComponent(ref)}`);
      } catch (err2: any) {
        const wrappedErr = new Error(err2.message || 'Transaction not found.');
        wrappedErr.name = 'TelebirrVerificationError';
        (wrappedErr as any).statusCode = err2.statusCode ?? 404;
        throw wrappedErr;
      }
    } else {
      const wrappedErr = new Error(err.message || 'Failed to fetch Telebirr receipt.');
      wrappedErr.name = 'TelebirrVerificationError';
      (wrappedErr as any).statusCode = err.statusCode ?? 502;
      throw wrappedErr;
    }
  }

  // ── Guard: check HTML actually contains receipt data ────────────────────────
  if (!html || html.length < 100) {
    const e = new Error('Telebirr receipt page returned empty content.');
    e.name = 'TelebirrVerificationError';
    (e as any).statusCode = 502;
    throw e;
  }

  // A 404/error state page often contains "not found" text instead of receipt data
  const lower = html.toLowerCase();
  if (
    (lower.includes('not found') || lower.includes('error') || lower.includes('invalid')) &&
    !lower.includes('payer') &&
    !lower.includes('amount') &&
    !lower.includes('receipt')
  ) {
    const e = new Error('Transaction not found or receipt link is invalid.');
    e.name = 'TelebirrVerificationError';
    (e as any).statusCode = 404;
    throw e;
  }

  const receipt = parseTelebirrHtml(html, ref);

  // Validate we extracted at least a reference or amount
  if (!receipt.receiptNo && !receipt.settledAmount) {
    logger.warn(`[Telebirr] Could not extract receipt data from HTML for ref: ${ref}`);
    const e = new Error('Could not parse Telebirr receipt. The page format may have changed.');
    e.name = 'TelebirrVerificationError';
    (e as any).statusCode = 502;
    throw e;
  }

  logger.info(`[Telebirr] ✅ Parsed receipt for ${ref}: amount=${receipt.settledAmount}, receiver=${receipt.creditedPartyAccountNo}`);
  return receipt;
}

/**
 * Probe function for the status probe service.
 * Returns a fixed descriptor since we no longer use a proxy pool.
 */
export async function probeTelebirrProxyPool(_reference: string, _env: NodeJS.ProcessEnv) {
  return {
    activeRouteId: 'transactioninfo.ethiotelecom.et',
    preferredRouteAvailable: true,
    routes: [
      {
        id: 'transactioninfo.ethiotelecom.et',
        label: 'Ethio Telecom Receipt Portal',
        role: 'preferred' as const,
        status: 'operational' as const,
        latencyMs: null,
      },
    ],
  };
}
