/**
 * formatter.ts — Format processVerification results into Telegram MarkdownV2 messages.
 *
 * Telegram MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * Characters inside inline code (backticks) do NOT need escaping.
 */

/** Escape all Telegram MarkdownV2 reserved characters in a plain string. */
function esc(text: string | null | undefined): string {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/** Format a number as "ETB 1,500.00" */
function fmtAmount(val: any): string {
  const n = Number(val);
  if (isNaN(n) || val === null || val === undefined) return 'N/A';
  return `ETB ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a date with EAT timezone */
function fmtDate(val: any): string {
  if (!val) return '';
  try {
    return new Date(val).toLocaleString('en-ET', {
      timeZone: 'Africa/Addis_Ababa',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(val);
  }
}

export interface FormatOptions {
  httpStatus: number;
  result: any;
}

export function formatVerificationResult({ httpStatus, result }: FormatOptions): string {
  if (!result) {
    return '❓ *Unknown result* — no data returned\\.';
  }

  const status        = result.status as string | undefined;
  const provider      = String(result.provider ?? '?');
  const ref           = String(result.txnReference ?? result.id ?? '?');
  const amount        = fmtAmount(result.amount);
  const expected      = result.expectedAmount != null ? fmtAmount(result.expectedAmount) : null;
  const payer         = esc(result.payerName || result.payerPhone || null) || 'N/A';
  const receiver      = esc(result.receivingAccount || null) || 'N/A';
  const verifiedAt    = fmtDate(result.verifiedAt);
  const message       = esc(result.message || null);

  switch (status) {
    case 'VERIFIED':
      return (
        `✅ *VERIFIED*\n\n` +
        `🏦 Provider: \`${provider}\`\n` +
        `🔖 Reference: \`${ref}\`\n` +
        `💰 Amount: *${esc(amount)}*\n` +
        (expected ? `💵 Expected: ${esc(expected)}\n` : '') +
        `👤 Payer: ${payer}\n` +
        `🏧 To Account: ${receiver}\n` +
        (verifiedAt ? `🕐 Verified: ${esc(verifiedAt)}\n` : '') +
        `\n_Recorded by CheckFlow ET ✔_`
      );

    case 'FLAGGED_DUPLICATE':
      return (
        `🔄 *FLAGGED DUPLICATE*\n\n` +
        `This transaction has already been verified before\\.\n\n` +
        `🏦 Provider: \`${provider}\`\n` +
        `🔖 Reference: \`${ref}\`\n` +
        `💰 Amount: *${esc(amount)}*\n` +
        (verifiedAt ? `🕐 First verified: ${esc(verifiedAt)}\n` : '') +
        `\n_⚠ Duplicate blocked by CheckFlow ET_`
      );

    case 'AMOUNT_MISMATCH':
      return (
        `❌ *AMOUNT MISMATCH*\n\n` +
        `The paid amount does not match the expected amount\\.\n\n` +
        `🏦 Provider: \`${provider}\`\n` +
        `🔖 Reference: \`${ref}\`\n` +
        `💰 Actual paid: *${esc(amount)}*\n` +
        (expected ? `💵 Expected: *${esc(expected)}*\n` : '') +
        `\n_⚠ Mismatch recorded by CheckFlow ET_`
      );

    case 'INVALID_RECEIPT': {
      const isWrongReceiver = /wrong receiver|receiver account mismatch|receiver mismatch|not to your registered/i.test(result.message || '');
      const hasRef      = ref && ref !== '?' && ref.trim().length > 1;
      const hasProvider = provider && provider !== '?' && provider.trim().length > 1;

      if (isWrongReceiver) {
        return (
          `⚠️ *WRONG RECEIVER — PAYMENT NOT ACCEPTED*\n\n` +
          `❌ This payment was *NOT* received by your business\\!\n` +
          `The customer transferred money to *another person's account*\\.\n\n` +
          (message ? `📋 *Details:* ${message}\n\n` : '') +
          `🏦 Provider: ${hasProvider ? `\`${provider}\`` : '_Unknown_'}\n` +
          `🔖 Reference: ${hasRef ? `\`${ref}\`` : '*⚠️ Not found*'}\n` +
          (amount && amount !== 'N/A' && amount !== 'ETB 0.00' ? `💰 Amount on Receipt: *${esc(amount)}*\n` : '') +
          (receiver && receiver !== 'N/A' ? `🏧 Paid To Account: ${receiver}\n` : '') +
          (payer && payer !== 'N/A' ? `👤 Payer: ${payer}\n` : '') +
          `\n⛔ *Do NOT provide goods or services for this payment, Contact support if you need\\.*`
        );
      }

      return (
        `🚫 *UNVERIFIED — RECEIPT NOT ACCEPTED*\n\n` +
        `⛔ This receipt could *not* be verified and may be *fake or tampered*\\.\n\n` +
        (message ? `📋 Reason: _${message}_\n\n` : '') +
        `🏦 Provider: ${hasProvider ? `\`${esc(provider)}\`` : '_Unknown_'}\n` +
        `🔖 Reference: ${hasRef ? `\`${esc(ref)}\`` : '*⚠️ Not found / Invalid*'}\n\n` +
        `_Do NOT accept this payment\\. Contact support if you believe this is an error\\._`
      );
    }

    case 'FAILED_UPSTREAM':
      return (
        `🔌 *UPSTREAM ERROR*\n\n` +
        `Could not reach the bank's verification API\\. Please retry in a moment\\.\n` +
        (message ? `\nDetails: _${message}_` : '')
      );

    case 'NEEDS_INPUT':
    case 'NEEDS_SUFFIX':
      return (
        `ℹ️ *MORE INFORMATION NEEDED*\n\n` +
        (message ? message : 'Additional input is required to complete verification\\.')
      );

    default:
      // Fallback — show HTTP status + raw message if any
      if (httpStatus >= 500) {
        return `🆘 *SERVER ERROR* \\(${httpStatus}\\)\n\n` + (message || 'An internal error occurred\\. Please try again or contact support\\.');
      }
      if (message) return `ℹ️ ${message}`;
      return `❓ *Unexpected result* \\(status: ${esc(status)}, HTTP ${httpStatus}\\)`;
  }
}

/** One-liner status summary for logging / inline notifications */
export function formatStatusLine(result: any): string {
  const status = result?.status ?? 'UNKNOWN';
  const ref    = result?.txnReference ?? '?';
  const amt    = result?.amount != null ? ` ${fmtAmount(result.amount)}` : '';
  return `[${status}] ${ref}${amt}`;
}
