/**
 * linkTelegram.ts
 *
 * One-step script to link an existing business admin or cashier in the database
 * to a specific Telegram user ID.
 *
 * Usage:
 *   npx tsx src/scripts/linkTelegram.ts <phone_or_user_id> <telegram_id>
 *   npm run link-telegram <phone_or_user_id> <telegram_id>
 *
 * Example:
 *   npm run link-telegram 0912345678 1773305484
 *   npm run link-telegram +251912345678 1773305484
 */

import prisma from '../utils/prisma';
import { normalizePhone } from '../controllers/auth.controller';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log(`
Usage:
  npm run link-telegram <phone_or_user_id> <telegram_id>

Examples:
  npm run link-telegram 0912345678 1773305484
  npm run link-telegram +251912345678 1773305484
`);
    process.exit(1);
  }

  const [identifier, rawTelegramId] = args;
  const cleanTgId = rawTelegramId.trim().replace(/^@/, '');
  const telegramId = BigInt(cleanTgId);

  // Try finding user by normalized phone, raw phone, or ID
  const normalized = normalizePhone(identifier);
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { phone: normalized },
        { phone: identifier },
        { id: identifier },
      ],
    },
    include: {
      organization: {
        include: {
          branches: { orderBy: { createdAt: 'asc' }, take: 1 },
        },
      },
      branch: true,
    },
  });

  if (!user) {
    console.error(`❌ User not found with phone or ID: "${identifier}"`);
    console.log(`\nExisting users in database:`);
    const all = await prisma.user.findMany({
      select: { fullName: true, phone: true, role: true, telegramId: true },
      take: 10,
    });
    console.table(all.map(u => ({
      name: u.fullName,
      phone: u.phone,
      role: u.role,
      telegramLinked: u.telegramId ? u.telegramId.toString() : 'No',
    })));
    process.exit(1);
  }

  // Ensure branchId is set
  let branchId = user.branchId;
  if (!branchId && user.organization?.branches?.[0]) {
    branchId = user.organization.branches[0].id;
  }

  // If this telegramId was previously assigned to a different user, unlink it first
  const existingWithTg = await prisma.user.findUnique({
    where: { telegramId },
  });

  if (existingWithTg && existingWithTg.id !== user.id) {
    console.log(`⚠️ Telegram ID ${telegramId} was linked to another user (${existingWithTg.fullName}). Unlinking previous user...`);
    await prisma.user.update({
      where: { id: existingWithTg.id },
      data: { telegramId: null },
    });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      telegramId,
      branchId: branchId ?? undefined,
    },
    include: {
      organization: true,
      branch: true,
    },
  });

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ TELEGRAM ACCOUNT SUCCESSFULLY LINKED!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 User:         ${updated.fullName} (${updated.role})
📞 Phone:        ${updated.phone}
🏢 Business:     ${updated.organization?.name}
📍 Branch:       ${updated.branch?.name ?? 'Main Branch'}
🆔 Telegram ID:  ${updated.telegramId?.toString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 You can now open your Telegram bot and send /start or
send receipt photos directly to verify payments for ${updated.organization?.name}!
`);
}

main()
  .catch((e) => {
    console.error('Error linking Telegram account:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
