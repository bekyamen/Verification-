/**
 * bot.ts — CheckFlow ET Telegram Bot
 *
 * Integrates the existing receipt verification backend with Telegram so that
 * operators can verify payment receipts directly from the Telegram app.
 *
 * Supported inputs:
 *   📸 Photo           → OCR + QR decode → bank verification
 *   📄 Document        → PDF or uncompressed image → bank verification
 *   🔗 Text URL        → CBE / Telebirr receipt URL → bank verification
 *   ✉️  Text reference  → Raw text / FT reference → bank verification
 *   /manual            → Manual provider + reference + optional amount entry
 *   /start, /help      → Usage instructions
 *   /status            → Check if bot is running and config is valid
 *
 * Authentication: fixed service-account cashier (BOT_CASHIER_ID + BOT_BRANCH_ID in .env).
 * Access control: whitelist via TELEGRAM_ALLOWED_CHAT_IDS in .env.
 */

import { Bot, Context } from 'grammy';
import axios from 'axios';
import { isAllowed, allowedIdCount, isPublicMode, isAdmin } from './auth';
import { formatVerificationResult, formatStatusLine } from './formatter';
import { runImageVerification } from '../services/imageVerify.service';
import { processVerification } from '../services/verification.service';
import { dissectPayload } from '../services/linkDissector';
import { parseRawText } from '../services/receiptParser.service';
import { accountsCache } from '../utils/verifyCache';
import prisma from '../utils/prisma';
import logger from '../utils/logger';

// ── Configuration (read lazily so dotenv has time to run) ────────────────────

const getBotToken      = () => process.env.TELEGRAM_BOT_TOKEN   ?? '';
const getBotBranchId   = () => process.env.BOT_BRANCH_ID        ?? '';
const getBotCashierId  = () => process.env.BOT_CASHIER_ID       ?? '';

// Convenience aliases used inline in handlers
const BOT_TOKEN      = () => getBotToken();
const BOT_BRANCH_ID  = () => getBotBranchId();
const BOT_CASHIER_ID = () => getBotCashierId();

const SUPPORTED_PROVIDERS = [
  'CBE', 'TELEBIRR', 'DASHEN', 'AWASH', 'BOA',
  'ZEMEN', 'CBE_BIRR', 'MPESA', 'SIINQEE',
] as const;

type Provider = typeof SUPPORTED_PROVIDERS[number];

// ── Account registration wizard ───────────────────────────────────────────────

type BankProvider = 'CBE' | 'TELEBIRR' | 'BOA' | 'AWASH';
const ACCOUNT_PROVIDERS: BankProvider[] = ['CBE', 'TELEBIRR', 'BOA', 'AWASH'];

type WizardStep = 'provider' | 'accountNumber' | 'holderName';

interface WizardState {
  step: WizardStep;
  provider?: BankProvider;
  accountNumber?: string;
  expiresAt: number; // ms timestamp
}

const WIZARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const wizardSessions = new Map<number, WizardState>();

function startWizard(chatId: number): void {
  wizardSessions.set(chatId, { step: 'provider', expiresAt: Date.now() + WIZARD_TIMEOUT_MS });
}

function getWizard(chatId: number): WizardState | null {
  const session = wizardSessions.get(chatId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    wizardSessions.delete(chatId);
    return null;
  }
  // Refresh timeout on activity
  session.expiresAt = Date.now() + WIZARD_TIMEOUT_MS;
  return session;
}

function clearWizard(chatId: number): void {
  wizardSessions.delete(chatId);
}

// ── Startup validation ───────────────────────────────────────────────────────

export function validateBotConfig(): string[] {
  const errors: string[] = [];
  if (!BOT_TOKEN())      errors.push('TELEGRAM_BOT_TOKEN is not set in .env');
  if (!BOT_BRANCH_ID())  errors.push('BOT_BRANCH_ID is not set in .env');
  if (!BOT_CASHIER_ID()) errors.push('BOT_CASHIER_ID is not set in .env');
  if (!isPublicMode() && allowedIdCount() === 0) {
    errors.push('TELEGRAM_ALLOWED_CHAT_IDS is empty — all access will be denied. Add at least one Telegram ID, or set BOT_PUBLIC_ACCESS=true.');
  }
  return errors;
}

// ── Helper: download Telegram file to a Buffer (with retry) ─────────────────

const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1_500;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadTelegramFile(
  bot: Bot,
  fileId: string
): Promise<{ buffer: Buffer; mime: string }> {
  const fileInfo = await bot.api.getFile(fileId);
  if (!fileInfo.file_path) throw new Error('Telegram did not return a file_path');

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN()}/${fileInfo.file_path}`;
  const ext  = fileInfo.file_path.split('.').pop()?.toLowerCase() ?? '';
  const mime =
    ext === 'pdf'  ? 'application/pdf'  :
    ext === 'png'  ? 'image/png'        :
    ext === 'webp' ? 'image/webp'       :
    'image/jpeg';

  let lastErr: Error = new Error('Unknown download error');

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 30_000,
      });
      const buffer = Buffer.from(resp.data);
      if (attempt > 1) {
        logger.info(`[telegram] File download succeeded on attempt ${attempt} (fileId=${fileId})`);
      }
      return { buffer, mime };
    } catch (err: any) {
      lastErr = err;
      const isNetworkError =
        err.code === 'ETIMEDOUT'    ||
        err.code === 'ENETUNREACH'  ||
        err.code === 'ECONNRESET'   ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND';

      logger.warn(
        `[telegram] File download attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} failed` +
        ` (${err.code ?? err.message}) fileId=${fileId}`
      );

      if (!isNetworkError || attempt === DOWNLOAD_MAX_ATTEMPTS) break;
      await sleep(DOWNLOAD_RETRY_DELAY_MS);
    }
  }

  throw lastErr;
}

// ── Helper: send a "thinking" indicator and return a cleanup fn ──────────────
async function sendTyping(ctx: Context): Promise<void> {
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  } catch { /* non-critical */ }
}

// ── Helper: run raw-text / URL verification via processVerification ──────────
async function verifyText(
  text: string,
  expectedAmount?: number
): Promise<{ status: number; result: any }> {
  const normalized = dissectPayload(text);

  // Also try parseRawText for supplementary amount extraction
  const { amount: rawAmount } = parseRawText(text);

  return processVerification({
    branchId:       BOT_BRANCH_ID(),
    cashierId:      BOT_CASHIER_ID(),
    provider:       normalized.provider as any,
    txnReference:   normalized.txnReference ?? '',
    amount:         rawAmount ?? normalized.amount ?? undefined,
    expectedAmount,
    payerPhone:     normalized.payerPhone,
    payerName:      normalized.payerName,
    receivingAccount: normalized.receivingAccount,
    senderAccount:  normalized.senderAccount,
    printedDate:    normalized.printedDate,
    rawText:        text,
  });
}

// ── Bot creation ─────────────────────────────────────────────────────────────

export function createBot(): Bot {
  if (!BOT_TOKEN()) {
    throw new Error('Cannot create Telegram bot: TELEGRAM_BOT_TOKEN is missing from .env');
  }

  const bot = new Bot(BOT_TOKEN());

  // ── Global middleware: access control ──────────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply(
        '⛔ Access denied.\n\nYou are not authorized to use this bot. Contact your system administrator.'
      );
      logger.warn(`[telegram] Blocked unauthorized access from chatId=${chatId}`);
      return;
    }
    await next();
  });

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `👋 *Welcome to CheckFlow ET Verification Bot\\!*\n\n` +
      `I can verify payment receipts from *CBE*, *Telebirr*, *Dashen*, *Awash*, *BOA*, and more\\.\n\n` +
      `*How to use:*\n` +
      `📸 Send a *photo* of the receipt \\(screenshot or paper scan\\)\n` +
      `📄 Send a *PDF* receipt as a document\n` +
      `🔗 Paste a *CBE or Telebirr URL* \\(e\\.g\\. mbreceipt\\.cbe\\.com\\.et/…\\)\n` +
      `✉️ Paste the *transaction reference* text\n` +
      `⌨️ Use /manual for manual entry\n\n` +
      `*Account management:*\n` +
      `📋 /accounts — List registered receiving accounts\n` +
      `➕ /addaccount — Register a new CBE / Telebirr / BOA / Awash account\n\n` +
      `Type /help to see all commands\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ── /help ──────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `*CheckFlow ET Bot — Commands*\n\n` +
      `*Verification*\n` +
      `/start — Welcome message & usage guide\n` +
      `/help — Show this help\n` +
      `/status — Show bot configuration status\n` +
      `/manual — Manual verification entry\n\n` +
      `*Account Management*\n` +
      `/accounts — List all registered receiving accounts\n` +
      `/addaccount — Register a new receiving account \\(guided wizard\\)\n` +
      `/cancel — Cancel an in\\-progress wizard\n\n` +
      `*Manual entry format:*\n` +
      `\`/manual PROVIDER TXN\\_REF \\[AMOUNT\\]\`\n\n` +
      `Examples:\n` +
      `\`/manual CBE FT26300XXXXXX\`\n` +
      `\`/manual CBE FT26300XXXXXX 1500\`\n` +
      `\`/manual TELEBIRR SB9876543210 500\`\n\n` +
      `*Supported providers:*\n` +
      `\`CBE · TELEBIRR · DASHEN · AWASH · BOA · ZEMEN · CBE\\_BIRR · MPESA · SIINQEE\``,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ── /status ────────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const configErrors = validateBotConfig();
    if (configErrors.length > 0) {
      await ctx.reply(
        `⚠️ *Bot configuration issues:*\n\n` +
        configErrors.map((e) => `• ${e}`).join('\n'),
        { parse_mode: 'MarkdownV2' }
      );
    } else {
      await ctx.reply(
        `✅ *Bot is running correctly*\n\n` +
        `Branch ID: \`${BOT_BRANCH_ID()}\`\n` +
        `Cashier ID: \`${BOT_CASHIER_ID()}\`\n` +
        `Whitelisted IDs: ${allowedIdCount()}`,
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // ── /accounts — list registered receiving accounts ──────────────────────────
  bot.command('accounts', async (ctx) => {
    try {
      const branch = await prisma.branch.findUnique({
        where: { id: BOT_BRANCH_ID() },
        include: {
          organization: {
            include: {
              bankSettlementAccounts: { orderBy: { bankName: 'asc' } }
            }
          }
        }
      });

      const accounts = branch?.organization?.bankSettlementAccounts ?? [];

      if (accounts.length === 0) {
        await ctx.reply(
          `📋 *No receiving accounts registered yet\\.*\n\n` +
          `Use /addaccount to register your first CBE or Telebirr account\\.`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      // Group by bank
      const grouped = accounts.reduce<Record<string, typeof accounts>>((acc, a) => {
        if (!acc[a.bankName]) acc[a.bankName] = [];
        acc[a.bankName].push(a);
        return acc;
      }, {});

      let msg = `📋 *Registered Receiving Accounts*\n\n`;
      for (const [bank, list] of Object.entries(grouped)) {
        const bankLabel = bank === 'TELEBIRR' ? '📱 TELEBIRR' : `🏦 ${bank}`;
        msg += `*${bankLabel}*\n`;
        for (const a of list) {
          const status = a.isActive ? '✅' : '❌ \\(inactive\\)';
          msg += `  • \`${a.accountNumber}\` — ${a.accountHolderName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')} ${status}\n`;
        }
        msg += '\n';
      }
      msg += `Use /addaccount to add another account\\.`;

      await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
    } catch (err: any) {
      logger.error(`[telegram] /accounts error: ${err.message}`);
      await ctx.reply('🆘 Failed to fetch accounts\\. Please try again\\.', { parse_mode: 'MarkdownV2' });
    }
  });

  // ── /addaccount — start account registration wizard ───────────────────────
  bot.command('addaccount', async (ctx) => {
    startWizard(ctx.chat!.id);
    await ctx.reply(
      `🏦 *Register a Receiving Account*\n\n` +
      `Which bank/provider?\n\n` +
      `Reply with one of:\n` +
      `\`CBE\` · \`TELEBIRR\` · \`BOA\` · \`AWASH\`\n\n` +
      `Or send /cancel to abort\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ── /cancel — abort any active wizard ────────────────────────────────────
  bot.command('cancel', async (ctx) => {
    const chatId = ctx.chat!.id;
    if (wizardSessions.has(chatId)) {
      clearWizard(chatId);
      await ctx.reply('❌ Registration cancelled\\.', { parse_mode: 'MarkdownV2' });
    } else {
      await ctx.reply('Nothing to cancel\\.', { parse_mode: 'MarkdownV2' });
    }
  });

  // ── /manual PROVIDER TXN_REF [AMOUNT] ─────────────────────────────────────
  bot.command('manual', async (ctx) => {
    const args = ctx.match?.trim().split(/\s+/) ?? [];

    if (args.length < 2) {
      await ctx.reply(
        `❌ *Invalid format*\n\n` +
        `Usage: \`/manual PROVIDER TXN\\_REF \\[AMOUNT\\]\`\n\n` +
        `Example: \`/manual CBE FT26300XXXXXX 1500\`\n\n` +
        `Supported providers: \`${SUPPORTED_PROVIDERS.join(' · ')}\``,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const providerArg = args[0].toUpperCase();
    const txnRef      = args[1].toUpperCase();
    const amount      = args[2] ? parseFloat(args[2]) : undefined;

    if (!SUPPORTED_PROVIDERS.includes(providerArg as Provider)) {
      await ctx.reply(
        `❌ Unknown provider: \`${providerArg}\`\n\n` +
        `Supported: \`${SUPPORTED_PROVIDERS.join(' · ')}\``,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    await sendTyping(ctx);
    await ctx.reply('⏳ Verifying manual entry\\.\\.\\.',  { parse_mode: 'MarkdownV2' });

    try {
      logger.info(`[telegram] manual verify chatId=${ctx.chat!.id} provider=${providerArg} ref=${txnRef} amount=${amount ?? 'N/A'}`);

      const outcome = await processVerification({
        branchId:      BOT_BRANCH_ID(),
        cashierId:     BOT_CASHIER_ID(),
        provider:      providerArg as any,
        txnReference:  txnRef,
        amount:        amount,
        expectedAmount: amount,     // treat supplied amount as both actual + expected
        rawText:       'TELEGRAM_MANUAL_ENTRY',
      });

      logger.info(`[telegram] manual result: ${formatStatusLine(outcome.result)}`);
      const text = formatVerificationResult({ httpStatus: outcome.status, result: outcome.result });
      await ctx.reply(text, { parse_mode: 'MarkdownV2' });

    } catch (err: any) {
      logger.error(`[telegram] manual error: ${err.message}`);
      await ctx.reply('🆘 An internal error occurred\\. Please try again\\.', { parse_mode: 'MarkdownV2' });
    }
  });

  // ── Photo handler: receipt screenshot ─────────────────────────────────────
  // We send the ack reply BEFORE verification so the update is considered handled.
  // The final result reply is in its own try/catch so a Telegram ETIMEDOUT never
  // causes grammy to re-deliver the same photo and re-run CBE.
  bot.on('message:photo', async (ctx) => {
    await sendTyping(ctx);
    // Acknowledge immediately — update is "handled" from here on
    try { await ctx.reply('⏳ Verifying receipt photo\.\.\.', { parse_mode: 'MarkdownV2' }); } catch { /* non-critical */ }

    // Select the largest available resolution
    const photos  = ctx.message.photo;
    const largest = photos[photos.length - 1];
    logger.info(`[telegram] photo verify chatId=${ctx.chat!.id} fileId=${largest.file_id} size=${largest.file_size ?? '?'}B`);

    let replyText: string;
    try {
      const { buffer, mime } = await downloadTelegramFile(bot, largest.file_id);
      const outcome = await runImageVerification({
        buffer,
        mimetype:  mime,
        branchId:  BOT_BRANCH_ID(),
        cashierId: BOT_CASHIER_ID(),
      });
      logger.info(`[telegram] photo result: ${formatStatusLine(outcome.result)}`);
      replyText = formatVerificationResult({ httpStatus: outcome.status, result: outcome.result });
    } catch (err: any) {
      logger.error(`[telegram] photo error: ${err.message}`);
      replyText = '🆘 Failed to process this image\\. Please try again or send the receipt as a document \\(PDF / uncompressed image\\)\\.';
    }

    // Isolated send — a failure here must NOT re-trigger verification
    try {
      await ctx.reply(replyText, { parse_mode: 'MarkdownV2' });
    } catch (sendErr: any) {
      logger.error(`[telegram] photo reply failed (Telegram unreachable?): ${sendErr.message}`);
    }
  });

  // ── Document handler: PDF receipts or uncompressed images ─────────────────
  bot.on('message:document', async (ctx) => {
    const doc      = ctx.message.document;
    const mimeType = doc.mime_type ?? '';
    const isImage  = mimeType.startsWith('image/');
    const isPdf    = mimeType === 'application/pdf';

    if (!isImage && !isPdf) {
      try {
        await ctx.reply(
          '⚠️ Unsupported file type\\. Please send a *JPEG/PNG image* or a *PDF* receipt\\.',
          { parse_mode: 'MarkdownV2' }
        );
      } catch { /* non-critical */ }
      return;
    }

    await sendTyping(ctx);
    // Acknowledge immediately — update is "handled" from here on
    try { await ctx.reply(`⏳ Verifying ${isPdf ? 'PDF' : 'image'} document\.\.\.`, { parse_mode: 'MarkdownV2' }); } catch { /* non-critical */ }

    logger.info(`[telegram] document verify chatId=${ctx.chat!.id} mime=${mimeType} fileId=${doc.file_id}`);

    let replyText: string;
    try {
      const { buffer, mime } = await downloadTelegramFile(bot, doc.file_id);
      const outcome = await runImageVerification({
        buffer,
        mimetype:  isPdf ? 'application/pdf' : mime,
        branchId:  BOT_BRANCH_ID(),
        cashierId: BOT_CASHIER_ID(),
      });
      logger.info(`[telegram] document result: ${formatStatusLine(outcome.result)}`);
      replyText = formatVerificationResult({ httpStatus: outcome.status, result: outcome.result });
    } catch (err: any) {
      logger.error(`[telegram] document error: ${err.message}`);
      replyText = '🆘 Failed to process this document\\. Please try again\\.';
    }

    // Isolated send — a failure here must NOT re-trigger verification
    try {
      await ctx.reply(replyText, { parse_mode: 'MarkdownV2' });
    } catch (sendErr: any) {
      logger.error(`[telegram] document reply failed (Telegram unreachable?): ${sendErr.message}`);
    }
  });

  // ── Text handler: URL, raw transaction reference, or wizard input ───────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const chatId = ctx.chat!.id;

    // Ignore messages that look like commands (handled above)
    if (text.startsWith('/')) return;

    // ── Wizard intercept ───────────────────────────────────────────────────────
    const session = getWizard(chatId);
    if (session) {
      if (session.step === 'provider') {
        const input = text.toUpperCase() as BankProvider;
        if (!ACCOUNT_PROVIDERS.includes(input)) {
          await ctx.reply(
            `❌ Unknown provider \`${text}\`\.

Please reply with one of: \`CBE\` · \`TELEBIRR\` · \`BOA\` · \`AWASH\``,
            { parse_mode: 'MarkdownV2' }
          );
          return;
        }
        session.provider = input;
        session.step = 'accountNumber';
        await ctx.reply(
          `✏️ Enter the *${input}* account number:`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      if (session.step === 'accountNumber') {
        if (text.length < 5) {
          await ctx.reply('❌ Account number seems too short\\. Please enter a valid account number\\.', { parse_mode: 'MarkdownV2' });
          return;
        }
        session.accountNumber = text;
        session.step = 'holderName';
        await ctx.reply(
          `✏️ Enter the *account holder name* \\(as shown on the bank statement\\):`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      if (session.step === 'holderName') {
        const holderName = text;
        const { provider, accountNumber } = session;
        clearWizard(chatId);

        try {
          // Resolve org from branch
          const branch = await prisma.branch.findUnique({
            where: { id: BOT_BRANCH_ID() },
            select: { organizationId: true }
          });

          if (!branch) {
            await ctx.reply('🆘 Could not resolve branch\\. Check BOT\_BRANCH\_ID config\\.', { parse_mode: 'MarkdownV2' });
            return;
          }

          // Check for duplicate
          const existing = await prisma.bankSettlementAccount.findFirst({
            where: {
              organizationId: branch.organizationId,
              bankName: provider! as any,
              accountNumber: accountNumber!
            }
          });

          if (existing) {
            await ctx.reply(
              `⚠️ Account \`${accountNumber}\` is already registered for *${provider}*\\.`,
              { parse_mode: 'MarkdownV2' }
            );
            return;
          }

          await prisma.bankSettlementAccount.create({
            data: {
              organizationId: branch.organizationId,
              bankName: provider! as any,
              accountNumber: accountNumber!,
              accountHolderName: holderName,
              isActive: true,
            }
          });

          // Invalidate cache so next verification picks up the new account
          accountsCache.delete(`branch:${BOT_BRANCH_ID()}`);

          logger.info(`[telegram] registered account provider=${provider} account=${accountNumber} org=${branch.organizationId}`);

          const safeHolder = holderName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
          await ctx.reply(
            `✅ *Account registered successfully\\!*\n\n` +
            `🏦 Provider: *${provider}*\n` +
            `🔢 Account: \`${accountNumber}\`\n` +
            `👤 Holder: ${safeHolder}\n\n` +
            `Receipts sent to this account will now be verified\\.`,
            { parse_mode: 'MarkdownV2' }
          );
        } catch (err: any) {
          logger.error(`[telegram] wizard DB error: ${err.message}`);
          await ctx.reply('🆘 Failed to save account\\. Please try again\\.', { parse_mode: 'MarkdownV2' });
        }
        return;
      }
    }

    // ── Normal verification path ───────────────────────────────────────────────
    await sendTyping(ctx);

    const isUrl = /^https?:\/\//i.test(text);
    // Acknowledge immediately — update is "handled" from here on
    try {
      await ctx.reply(
        `⏳ Verifying ${isUrl ? 'URL' : 'text reference'}\.\.\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch { /* non-critical */ }

    logger.info(`[telegram] text verify chatId=${chatId} isUrl=${isUrl} text="${text.slice(0, 80)}"`);

    let replyText: string;
    try {
      const outcome = await verifyText(text);
      logger.info(`[telegram] text result: ${formatStatusLine(outcome.result)}`);
      replyText = formatVerificationResult({ httpStatus: outcome.status, result: outcome.result });
    } catch (err: any) {
      logger.error(`[telegram] text error: ${err.message}`);
      replyText = '🆘 Failed to process this text\\. Please check the reference and try again\\.';
    }

    // Isolated send — a failure here must NOT re-trigger verification
    try {
      await ctx.reply(replyText, { parse_mode: 'MarkdownV2' });
    } catch (sendErr: any) {
      logger.error(`[telegram] text reply failed (Telegram unreachable?): ${sendErr.message}`);
    }
  });

  // ── Catch-all error handler ────────────────────────────────────────────────
  bot.catch((err) => {
    logger.error(`[telegram] Unhandled bot error: ${err.message ?? err}`);
  });

  return bot;
}

/** Start the bot in long-polling mode (no public URL required). */
export function startBot(): void {
  const configErrors = validateBotConfig();
  if (configErrors.length > 0) {
    logger.error('[telegram] Bot NOT started due to configuration errors:');
    configErrors.forEach((e) => logger.error(`  • ${e}`));
    return;
  }

  logger.info('[telegram] Initialising bot...');
  logger.info(`[telegram] Public mode: ${isPublicMode()}, AllowedIDs: ${allowedIdCount()}`);
  logger.info(`[telegram] Branch=${BOT_BRANCH_ID()} Cashier=${BOT_CASHIER_ID()}`);

  // Use an async IIFE so we can await webhook deletion before polling starts.
  // A leftover webhook (from any previous deployment) causes Telegram to deliver
  // updates ONLY to the webhook URL and nothing to the long-poll connection —
  // resulting in a bot that appears alive but silently ignores every message.
  (async () => {
    try {
      const bot = createBot();

      // ── Step 1: clear any existing webhook ─────────────────────────────────
      logger.info('[telegram] Clearing any existing webhook...');
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      logger.info('[telegram] Webhook cleared — starting long-poll...');

      // ── Step 2: start polling ───────────────────────────────────────────────
      bot.start({
        onStart: (info) => {
          logger.info(`[telegram] ✅ Bot @${info.username} is online and polling`);
          logger.info(`[telegram] Branch=${BOT_BRANCH_ID()} Cashier=${BOT_CASHIER_ID()} AllowedIDs=${allowedIdCount()} PublicMode=${isPublicMode()}`);
        },
      });

    } catch (err: any) {
      logger.error(`[telegram] ❌ Fatal startup error: ${err.message ?? err}`);
      // Retry after 15 s so a transient network hiccup at boot doesn't kill the bot permanently
      logger.info('[telegram] Retrying bot startup in 15 s...');
      setTimeout(() => startBot(), 15_000);
    }
  })();
}
