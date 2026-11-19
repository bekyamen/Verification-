/**
 * formatter.ts — Format processVerification results into Telegram MarkdownV2 messages.
 *
 * Telegram MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * Characters inside inline code (backticks) do NOT need escaping.
 */

/** Escape all Telegram MarkdownV2 reserved characters in a plain string. */
export function esc(text: string | null | undefined): string {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/** Format a number as clean ETB currency amount, e.g. "10" or "10.50" */
export function fmtCleanAmount(val: any): string {
  const n = Number(val);
  if (isNaN(n) || val === null || val === undefined) return '0';
  if (n % 1 === 0) {
    return n.toLocaleString('en-US');
  }
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a number as "ETB 1,500.00" */
export function fmtAmount(val: any): string {
  const n = Number(val);
  if (isNaN(n) || val === null || val === undefined) return 'N/A';
  return `ETB ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format Gregorian date as "13 Oct 2026, 11:13 PM" (Africa/Addis_Ababa timezone) */
export function formatGregorian(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Addis_Ababa',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(d);

    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;
    const dayPeriod = m.dayPeriod ? m.dayPeriod.toUpperCase() : '';
    return `${m.day} ${m.month} ${m.year}, ${m.hour}:${m.minute} ${dayPeriod}`.trim();
  } catch {
    return d.toISOString();
  }
}

/**
 * Format Ethiopian Calendar date and 12-hour traditional cycle time.
 * e.g. "ጥቅምት 3, 2019, 5:13 ከምሽት"
 */
export function formatEthiopian(d: Date): string {
  try {
    const ethMonths = [
      'መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት',
      'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜ',
    ];

    const parts = new Intl.DateTimeFormat('en-US-u-ca-ethiopic', {
      timeZone: 'Africa/Addis_Ababa',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(d);

    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;

    const ethYear = m.year;
    const monthIdx = parseInt(m.month, 10) - 1;
    const ethMonthName = ethMonths[monthIdx] || m.month;
    const ethDay = m.day;

    const addisHour = parseInt(m.hour, 10) % 24;
    const minute = String(m.minute).padStart(2, '0');

    // Ethiopian 12-hour cycle (day starts at 6:00 AM)
    let ethHour = (addisHour - 6) % 12;
    if (ethHour <= 0) ethHour += 12;

    let period = '';
    if (addisHour >= 6 && addisHour < 12) {
      period = 'ከጠዋቱ';
    } else if (addisHour >= 12 && addisHour < 18) {
      period = 'ከሰዓት';
    } else if (addisHour >= 18 && addisHour < 24) {
      period = 'ከምሽት';
    } else {
      period = 'ከሌሊቱ';
    }

    return `${ethMonthName} ${ethDay}, ${ethYear}, ${ethHour}:${minute} ${period}`;
  } catch {
    return '';
  }
}

/**
 * Format relative elapsed time from verification.
 * e.g. "26d 13h from verification", "2h 15m from verification", "5m from verification"
 */
export function formatRelativeTime(targetDate: Date, baseDate: Date = new Date()): string {
  try {
    const diffMs = Math.max(0, baseDate.getTime() - targetDate.getTime());
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMinutes / 60);
    const days = Math.floor(diffHours / 24);
    const hours = diffHours % 24;
    const minutes = diffMinutes % 60;

    if (days > 0) {
      return `${days}d ${hours}h from verification`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes}m from verification`;
    }
    if (minutes > 0) {
      return `${minutes}m from verification`;
    }
    return '0m from verification';
  } catch {
    return '';
  }
}

/** Extract credited party / recipient or payer name from result */
export function extractPartyName(result: any): string {
  if (result.receiverName && typeof result.receiverName === 'string' && result.receiverName.trim()) {
    return result.receiverName.trim();
  }
  const raw = result.raw;
  if (raw) {
    if (typeof raw.to_name === 'string' && raw.to_name.trim()) return raw.to_name.trim();
    if (raw.pdf_link_data?.to_name && typeof raw.pdf_link_data.to_name === 'string' && raw.pdf_link_data.to_name.trim()) {
      return raw.pdf_link_data.to_name.trim();
    }
    if (raw.link_receipt_data?.credited_party_name && typeof raw.link_receipt_data.credited_party_name === 'string') {
      return raw.link_receipt_data.credited_party_name.trim();
    }
  }
  if (result.receivingAccount && typeof result.receivingAccount === 'string' && result.receivingAccount.trim()) {
    return result.receivingAccount.trim();
  }
  if (result.payerName && typeof result.payerName === 'string' && result.payerName.trim()) {
    return result.payerName.trim();
  }
  if (result.payerPhone && typeof result.payerPhone === 'string' && result.payerPhone.trim()) {
    return result.payerPhone.trim();
  }
  return 'N/A';
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
  const ref           = String(result.txnReference ?? result.id ?? result.reference ?? '?');
  const amount        = fmtAmount(result.amount);
  const expected      = result.expectedAmount != null ? fmtAmount(result.expectedAmount) : null;
  const payer         = esc(result.payerName || result.payerPhone || null) || 'N/A';
  const receiver      = esc(result.receivingAccount || null) || 'N/A';
  const message       = esc(result.message || null);

  switch (status) {
    case 'VERIFIED': {
      const cleanAmt = fmtCleanAmount(result.settledAmount ?? result.amount);
      const party = extractPartyName(result);

      const rawTxDate = result.transactionDate || result.verifiedAt || result.createdAt;
      const txDate = rawTxDate ? new Date(rawTxDate) : new Date();
      const validTxDate = isNaN(txDate.getTime()) ? new Date() : txDate;

      const rawVerifyDate = result.verifiedAt || result.createdAt;
      const verifyDate = rawVerifyDate ? new Date(rawVerifyDate) : new Date();
      const validVerifyDate = isNaN(verifyDate.getTime()) ? new Date() : verifyDate;

      const gregStr = formatGregorian(validTxDate);
      const ethStr = formatEthiopian(validTxDate);
      const relStr = formatRelativeTime(validTxDate, validVerifyDate);

      return (
        `✅ *Verified / ተረጋግጧል*\n\n` +
        `🏦 \`${esc(provider)}\`\n` +
        `💰 *ETB ${cleanAmt}*\n` +
        `🔖 \`${esc(ref)}\`\n` +
        `👥 *${esc(party)}*\n` +
        `📅 ${esc(gregStr)}\n` +
        (ethStr ? `   \\(${esc(ethStr)}\\)\n` : '') +
        (relStr ? `   ${esc(relStr)}` : '')
      );
    }

    case 'FLAGGED_DUPLICATE': {
      const ownerName = result.ownerName || 'Beki Plc';
      const numAmt = Number(result.settledAmount ?? result.amount ?? 0);
      const amtStr = !isNaN(numAmt) ? numAmt.toFixed(2) : '0.00';
      const party = result.receiverParty || extractPartyName(result) || 'SADA';

      const rawVerifyDate = result.verifiedAt || result.createdAt;
      const verifyDate = rawVerifyDate ? new Date(rawVerifyDate) : new Date();
      const validVerifyDate = isNaN(verifyDate.getTime()) ? new Date() : verifyDate;

      const rawTxDate = result.transactionDate || result.verifiedAt || result.createdAt;
      const txDate = rawTxDate ? new Date(rawTxDate) : validVerifyDate;
      const validTxDate = isNaN(txDate.getTime()) ? validVerifyDate : txDate;

      const isoDateStr = validVerifyDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const gregStr = formatGregorian(validTxDate);
      const ethStr = formatEthiopian(validTxDate);
      const relStr = formatRelativeTime(validTxDate, new Date());

      return (
        `🔄 *FLAGGED DUPLICATE / የተደገመ ደረሰኝ*\n\n` +
        `Already verified by *${esc(ownerName)}* at \`${isoDateStr}\`\\. Amount confirmed correct: *ETB ${esc(amtStr)}*\\.\n\n` +
        `ቀድሞውኑ በ*${esc(ownerName)}* በ\`${isoDateStr}\` ተረጋግጧል\\. የመጠን ማረጋገጫ፦ *ETB ${esc(amtStr)}*\\።\n` +
        `👥 *${esc(party)}*\n` +
        `📅 ${esc(gregStr)}\n` +
        (ethStr ? `   \\(${esc(ethStr)}\\)\n` : '') +
        (relStr ? `   ${esc(relStr)}\n` : '') +
        `\n_⚠ Duplicate blocked by CheckFlow ET_`
      );
    }

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
  const ref    = result?.txnReference ?? result?.reference ?? '?';
  const amt    = result?.amount != null ? ` ${fmtAmount(result.amount)}` : '';
  return `[${status}] ${ref}${amt}`;
}
