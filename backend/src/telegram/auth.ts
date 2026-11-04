/**
 * auth.ts — Telegram bot access control
 *
 * Reads TELEGRAM_ALLOWED_CHAT_IDS from .env (comma-separated Telegram user/chat IDs).
 * If the env var is empty or missing, ALL requests are denied to prevent accidental exposure.
 *
 * Set BOT_PUBLIC_ACCESS=true to open the bot to everyone while keeping the
 * whitelist as an admin roster (used by isAdmin()).
 */

function getAllowedIds(): Set<number> {
  const rawIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '';
  return new Set(
    rawIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n))
  );
}

/** Returns true when the bot is open to every Telegram user. */
export function isPublicMode(): boolean {
  return (process.env.BOT_PUBLIC_ACCESS ?? '').toLowerCase() === 'true';
}

/**
 * Returns true if the given Telegram chat ID is whitelisted.
 * In public mode every chat ID is considered allowed.
 * Returns false (deny) when the whitelist is empty and public mode is off.
 */
export function isAllowed(chatId: number): boolean {
  if (isPublicMode()) return true;
  const ids = getAllowedIds();
  if (ids.size === 0) return false;
  return ids.has(chatId);
}

/** Returns true when the chat ID is in the admin whitelist (regardless of public mode). */
export function isAdmin(chatId: number): boolean {
  return getAllowedIds().has(chatId);
}

export function allowedIdCount(): number {
  return getAllowedIds().size;
}
