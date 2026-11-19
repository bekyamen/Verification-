import { formatGregorian, formatEthiopian, formatRelativeTime } from '../telegram/formatter';

export interface DuplicateMessageDetails {
  ownerName?: string | null;
  isoDate?: string | Date | null;
  amount: number | string | any;
  receiverParty?: string | null;
  transactionDate?: Date | string | null;
  verifiedAt?: Date | string | null;
}

/**
 * Format a duplicate receipt message with English & Amharic details,
 * beneficiary party name, Gregorian date, Ethiopian calendar, and elapsed time.
 *
 * Example:
 * Already verified by Beki Plc at 2026-11-19T12:59:08Z. Amount confirmed correct: ETB 5.00.
 *
 * ቀድሞውኑ በBeki Plc በ2026-11-19T12:59:08Z ተረጋግጧል። የመጠን ማረጋገጫ፦ ETB 5.00።
 * 👥 SADA
 * 📅 19 Nov 2026, 3:49 PM
 *    (ሕዳር 10, 2019, 9:49 ከሰዓት)
 *    9m from verification
 */
export function buildDuplicateMessage(details: DuplicateMessageDetails): string {
  const owner = details.ownerName && details.ownerName.trim() ? details.ownerName.trim() : 'Beki Plc';

  const num = Number(details.amount);
  const amtStr = !isNaN(num) ? num.toFixed(2) : String(details.amount ?? '0.00');

  const rawVerify = details.verifiedAt || details.isoDate || new Date();
  const verifyDate = new Date(rawVerify);
  const validVerifyDate = isNaN(verifyDate.getTime()) ? new Date() : verifyDate;
  const isoDateStr = validVerifyDate.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const rawTx = details.transactionDate || details.verifiedAt || validVerifyDate;
  const txDate = new Date(rawTx);
  const validTxDate = isNaN(txDate.getTime()) ? validVerifyDate : txDate;

  const party = details.receiverParty && details.receiverParty.trim() ? details.receiverParty.trim() : 'SADA';

  const gregStr = formatGregorian(validTxDate);
  const ethStr = formatEthiopian(validTxDate);
  const relStr = formatRelativeTime(validTxDate, new Date());

  const lines = [
    `Already verified by ${owner} at ${isoDateStr}. Amount confirmed correct: ETB ${amtStr}.`,
    '',
    `ቀድሞውኑ በ${owner} በ${isoDateStr} ተረጋግጧል። የመጠን ማረጋገጫ፦ ETB ${amtStr}።`,
    `👥 ${party}`,
    `📅 ${gregStr}`,
  ];

  if (ethStr) {
    lines.push(`   (${ethStr})`);
  }
  if (relStr) {
    lines.push(`   ${relStr}`);
  }

  return lines.join('\n');
}
