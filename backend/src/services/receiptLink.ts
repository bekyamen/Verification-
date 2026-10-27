/**
 * receiptLink.ts
 *
 * Allowlist-only URL parser for payment receipt links.
 *
 * Only genuine CBE and Telebirr receipt URLs are accepted.
 * Any other URL (including internal-network links like 169.254.x.x,
 * look-alike hostnames, or plain HTTP) returns null.
 *
 * Usage:
 *   const parsed = parseReceiptLink(url);
 *   if (!parsed) { reject(); }
 */

export type ParsedReceiptLink =
  | { provider: 'CBE';      ref: string }
  | { provider: 'TELEBIRR'; ref: string };

// Exact hostnames (and their common OCR typo variant) that host real receipts.
const CBE_RECEIPT_HOSTS = new Set([
  'mbreceipt.cbe.com.et',
  'mbreciept.cbe.com.et',   // known OCR / copy-paste typo
  'apps.cbe.com.et',
]);

// Telebirr receipts live on *.ethiotelecom.et
const TELEBIRR_RECEIPT_HOST_SUFFIX = '.ethiotelecom.et';
const TELEBIRR_RECEIPT_EXACT_HOST  = 'ethiotelecom.et';

/**
 * Parse a string that might be a receipt link.
 *
 * Returns { provider, ref } if it is a known-good receipt URL,
 * or null for anything else.
 */
export function parseReceiptLink(raw: string): ParsedReceiptLink | null {
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();

  // Must be HTTPS (we never accept plain HTTP for receipt links)
  if (!trimmed.startsWith('https://')) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  // ── CBE ───────────────────────────────────────────────────────────────────
  if (CBE_RECEIPT_HOSTS.has(host)) {
    // Path token style: https://mbreceipt.cbe.com.et/<token>
    const pathToken = parsed.pathname.replace(/^\/+/, '');
    if (pathToken && /^[A-Za-z0-9_-]{10,80}$/.test(pathToken)) {
      return { provider: 'CBE', ref: pathToken };
    }

    // Query-param style: ?ref=FT... or ?txnId=...
    const ref =
      parsed.searchParams.get('ref') ||
      parsed.searchParams.get('txnId') ||
      parsed.searchParams.get('token');
    if (ref && ref.length >= 6) {
      return { provider: 'CBE', ref };
    }

    return null; // CBE host but no usable reference
  }

  // ── Telebirr ──────────────────────────────────────────────────────────────
  if (
    host === TELEBIRR_RECEIPT_EXACT_HOST ||
    host.endsWith(TELEBIRR_RECEIPT_HOST_SUFFIX)
  ) {
    // Path style: /receipt/<txnId>
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const txnId =
      pathParts[pathParts.length - 1] ||           // last path segment
      parsed.searchParams.get('transactionno') ||
      parsed.searchParams.get('txId') ||
      parsed.searchParams.get('id');

    if (txnId && /^[A-Za-z0-9]{6,30}$/.test(txnId)) {
      return { provider: 'TELEBIRR', ref: txnId };
    }

    return null; // Telebirr host but no usable transaction ID
  }

  // Every other hostname → reject
  return null;
}
