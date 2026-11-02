/**
 * auth.ts — Telegram bot access control
 *
 * Reads TELEGRAM_ALLOWED_CHAT_IDS from .env (comma-separated Telegram user/chat IDs).
 * If the env var is empty or missing, ALL requests are denied to prevent accidental exposure.
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

/**
 * Returns true if the given Telegram chat ID is whitelisted.
 * Returns false (deny) when the whitelist is empty or the ID is not present.
 */
export function isAllowed(chatId: number): boolean {
  const ids = getAllowedIds();
  if (ids.size === 0) return false;
  return ids.has(chatId);
}

export function allowedIdCount(): number {
  return getAllowedIds().size;
}
