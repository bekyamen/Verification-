import { Api } from 'grammy';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { formatVerificationResult, esc } from '../telegram/formatter';

let tgApi: Api | null = null;

function getTelegramApi(): Api | null {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return null;
  if (!tgApi) {
    tgApi = new Api(token);
  }
  return tgApi;
}

export interface CashierVerificationNotificationInput {
  branchId: string;
  cashierId: string;
  result: any;
}

/**
 * Notifies the business admin(s) via Telegram whenever a cashier completes a receipt verification.
 */
export async function notifyAdminsOnCashierVerification({
  branchId,
  cashierId,
  result,
}: CashierVerificationNotificationInput): Promise<void> {
  try {
    if (!result || result.status !== 'VERIFIED') return;

    const api = getTelegramApi();
    if (!api) {
      logger.debug('[admin-notify] TELEGRAM_BOT_TOKEN not configured; skipping admin notification.');
      return;
    }

    // 1. Fetch cashier details to identify organization and name
    const cashier = await prisma.user.findUnique({
      where: { id: cashierId },
      select: {
        id: true,
        fullName: true,
        role: true,
        organizationId: true,
        branch: { select: { id: true, name: true } },
      },
    });

    if (!cashier) {
      logger.debug(`[admin-notify] Cashier user not found for ID: ${cashierId}`);
      return;
    }

    // If an OWNER/MANAGER verifies themselves, skip notifying (only notify on cashier work)
    if (cashier.role === 'OWNER') {
      return;
    }

    const orgId = cashier.organizationId;
    if (!orgId) return;

    // 2. Fetch admins for this organization who have Telegram linked
    const admins = await prisma.user.findMany({
      where: {
        organizationId: orgId,
        role: { in: ['OWNER', 'MANAGER'] },
        telegramId: { not: null },
      },
      select: {
        id: true,
        fullName: true,
        telegramId: true,
      },
    });

    if (admins.length === 0) {
      logger.debug(`[admin-notify] No Telegram-linked admins found for organization: ${orgId}`);
      return;
    }

    // 3. Format the verification response message
    const baseCard = formatVerificationResult({ httpStatus: 200, result });
    const cashierName = cashier.fullName || 'Cashier';

    // Append cashier attribution footer
    const adminMessage =
      `${baseCard}\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Cashier:* ${esc(cashierName)}`;

    // 4. Send notification to each admin via Telegram Bot API
    for (const admin of admins) {
      if (!admin.telegramId || admin.id === cashierId) continue;

      const chatId = admin.telegramId.toString();
      try {
        await api.sendMessage(chatId, adminMessage, {
          parse_mode: 'MarkdownV2',
        });
        logger.info(`[admin-notify] ✅ Verification alert sent to admin ${admin.fullName} (chat: ${chatId}) for cashier ${cashierName}`);
      } catch (err: any) {
        logger.warn(`[admin-notify] ❌ Could not send notification to admin ${admin.fullName} (${chatId}): ${err.message}`);
      }
    }
  } catch (error: any) {
    logger.error(`[admin-notify] Unexpected error in notifyAdminsOnCashierVerification: ${error.message}`);
  }
}
