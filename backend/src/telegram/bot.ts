/**
 * bot.ts — CheckFlow ET Telegram Bot
 *
 * Integrates receipt verification directly into Telegram for all business owners & cashiers.
 *
 * Multi-Tenant Architecture:
 *   - Zero fixed branch or cashier IDs in .env.
 *   - Each Telegram user is dynamically matched to their own business and branch.
 *   - Verified receipts are matched against the receiving accounts of that user's business.
 *   - Unregistered users are greeted with a friendly message and a button to open the Mini App.
 *
 * Supported inputs:
 *   📸 Photo           → OCR + QR decode → bank verification
 *   📄 Document        → PDF or uncompressed image → bank verification
 *   🔗 Text URL        → CBE / Telebirr receipt URL → bank verification
 *   ✉️  Text reference  → Raw text / FT reference → bank verification
 *   /manual            → Manual provider + reference + optional amount entry
 *   /accounts          → (Admin only) List registered receiving accounts
 *   /addaccount        → (Admin only) Add a receiving account via wizard
 *   /start, /help      → Usage instructions
 *   /status            → Dynamic bot status & statistics
 */

import { Bot, Context, InlineKeyboard } from 'grammy';
import axios from 'axios';
import https from 'https';
import { getRegisteredUser, TelegramUserContext } from './auth';
import { formatVerificationResult, formatStatusLine } from './formatter';
import { runImageVerification } from '../services/imageVerify.service';
import { processVerification } from '../services/verification.service';
import { dissectPayload } from '../services/linkDissector';
import { parseRawText } from '../services/receiptParser.service';
import { accountsCache } from '../utils/verifyCache';
import prisma from '../utils/prisma';
import logger from '../utils/logger';

// ── Configuration ────────────────────────────────────────────────────────────

const getBotToken   = () => process.env.TELEGRAM_BOT_TOKEN ?? '';
const getMiniAppUrl = () => process.env.MINIAPP_URL        ?? '';

const BOT_TOKEN = () => getBotToken();

// Cached bot username
let _botUsername: string | null = null;
async function getBotUsername(bot: Bot): Promise<string> {
  if (_botUsername) return _botUsername;
  try {
    const me = await bot.api.getMe();
    _botUsername = me.username ?? '';
    logger.info(`[telegram] Bot username: @${_botUsername}`);
  } catch {
    _botUsername = '';
  }
  return _botUsername;
}

/** Return the Mini App URL configured in .env */
async function getMiniAppOpenUrl(_bot: Bot): Promise<string> {
  return getMiniAppUrl();
}

/** MarkdownV2 character escaping helper */
function escMd(text: string | null | undefined): string {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

const SUPPORTED_PROVIDERS = [
  'CBE', 'TELEBIRR', 'DASHEN', 'AWASH', 'BOA',
  'ZEMEN', 'CBE_BIRR', 'MPESA', 'SIINQEE',
] as const;

type Provider = typeof SUPPORTED_PROVIDERS[number];

// ── Per-user context lookup ─────────────────────────────────────────────────

interface CachedUserContext {
  context: TelegramUserContext | null;
  expiresAt: number;
}

const USER_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const userContextCache = new Map<string, CachedUserContext>();

/** Invalidate cached Telegram user context on login, linking, or role update */
export function clearUserContextCache(telegramId?: number | bigint | string): void {
  if (telegramId !== undefined && telegramId !== null) {
    userContextCache.delete(telegramId.toString());
  } else {
    userContextCache.clear();
  }
}

async function resolveUserContext(fromId: number | undefined): Promise<TelegramUserContext | null> {
  if (!fromId) return null;
  const key = fromId.toString();
  const cached = userContextCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.context;
  }

  const context = await getRegisteredUser(fromId);
  userContextCache.set(key, {
    context,
    // If not found, cache for shorter time (30s) so newly linked users are discovered quickly
    expiresAt: Date.now() + (context ? USER_CONTEXT_TTL_MS : 30 * 1000),
  });
  return context;
}

/** Send friendly onboarding prompt with a Mini App button */
async function sendRegisterPrompt(ctx: Context, bot: Bot): Promise<void> {
  const miniAppUrl = await getMiniAppOpenUrl(bot);
  const message =
    `👋 *Welcome to CheckFlow ET\\!*\n\n` +
    `Your Telegram account is not connected to a business yet\\.\n\n` +
    `Tap the button below to *register your business* or *sign in* with your existing account\\. Once signed in, you can verify receipts instantly right here in Telegram\\!`;

  if (miniAppUrl) {
    const keyboard = new InlineKeyboard().webApp('📲 Open CheckFlow App', miniAppUrl);
    await ctx.reply(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } else {
    await ctx.reply(
      `👋 *Welcome to CheckFlow ET\\!*\n\n` +
      `Your Telegram account is not connected to a business yet\\.\n\n` +
      `Please open the CheckFlow Mini App to register your business or sign in with your cashier credentials\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ── Account registration wizard ───────────────────────────────────────────────

type BankProvider = 'CBE' | 'TELEBIRR' | 'BOA' | 'AWASH';
const ACCOUNT_PROVIDERS: BankProvider[] = ['CBE', 'TELEBIRR', 'BOA', 'AWASH'];

type WizardStep = 'provider' | 'accountNumber' | 'holderName';

interface WizardState {
  step: WizardStep;
  provider?: BankProvider;
  accountNumber?: string;
  expiresAt: number;
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
  session.expiresAt = Date.now() + WIZARD_TIMEOUT_MS;
  return session;
}

function clearWizard(chatId: number): void {
  wizardSessions.delete(chatId);
}

// ── Startup validation ───────────────────────────────────────────────────────

export function validateBotConfig(): string[] {
  const errors: string[] = [];
  if (!BOT_TOKEN()) {
    errors.push('TELEGRAM_BOT_TOKEN is not set in .env');
  }
  return errors;
}

// ── Helper: download Telegram file to a Buffer ───────────────────────────────

const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1_500;

// Persistent keep-alive agent for Telegram API file downloads
const telegramDownloadAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 30,
  keepAliveMsecs: 60_000,
});

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Select the optimal photo size (~1000px - 1400px).
 * Screenshots taken on modern smartphones can be 4K (2-5MB). Downloading bloated files
 * adds 2-3 seconds of unnecessary latency. An image with ~1280px dimension is typically
 * ~100-250KB, downloads in <100ms, and provides full fidelity for QR code and OCR parsing.
 */
function selectOptimalPhoto(photos: Array<{ file_id: string; width: number; height: number }>): { file_id: string; width: number; height: number } {
  if (!photos || photos.length === 0) throw new Error('No photos in message');
  if (photos.length === 1) return photos[0];

  // Try to find the sweet spot: max dimension between 900px and 1600px
  const ideal = photos.find((p) => {
    const maxDim = Math.max(p.width, p.height);
    return maxDim >= 900 && maxDim <= 1600;
  });
  if (ideal) return ideal;

  // Otherwise find first photo with max dimension >= 800px
  const medium = photos.find((p) => Math.max(p.width, p.height) >= 800);
  if (medium) return medium;

  // Fallback: largest available
  return photos[photos.length - 1];
}

async function downloadTelegramFile(
  bot: Bot,
  fileId: string
): Promise<{ buffer: Buffer; mime: string }> {
  const fileInfo = await bot.api.getFile(fileId);
  if (!fileInfo.file_path) throw new Error('Telegram did not return a file_path');

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN()}/${fileInfo.file_path}`;
  const ext = fileInfo.file_path.split('.').pop()?.toLowerCase() ?? '';
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
        timeout: 20_000,
        httpsAgent: telegramDownloadAgent,
      });
      const buffer = Buffer.from(resp.data);
      return { buffer, mime };
    } catch (err: any) {
      lastErr = err;
      logger.warn(`[telegram] File download attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} failed (${err.code ?? err.message})`);
      if (attempt === DOWNLOAD_MAX_ATTEMPTS) break;
      await sleep(DOWNLOAD_RETRY_DELAY_MS);
    }
  }

  throw lastErr;
}

async function sendTyping(ctx: Context): Promise<void> {
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  } catch { /* non-critical */ }
}

async function verifyText(
  text: string,
  branchId: string,
  cashierId: string,
  expectedAmount?: number
): Promise<{ status: number; result: any }> {
  const normalized = dissectPayload(text);
  const { amount: rawAmount } = parseRawText(text);

  return processVerification({
    branchId,
    cashierId,
    provider:         normalized.provider as any,
    txnReference:     normalized.txnReference ?? '',
    amount:           rawAmount ?? normalized.amount ?? undefined,
    expectedAmount,
    payerPhone:       normalized.payerPhone,
    payerName:        normalized.payerName,
    receivingAccount: normalized.receivingAccount,
    senderAccount:    normalized.senderAccount,
    printedDate:      normalized.printedDate,
    rawText:          text,
  });
}

// ── Bot creation ─────────────────────────────────────────────────────────────

export function createBot(): Bot {
  if (!BOT_TOKEN()) {
    throw new Error('Cannot create Telegram bot: TELEGRAM_BOT_TOKEN is missing from .env');
  }

  const bot = new Bot(BOT_TOKEN());

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const fromId = ctx.from?.id;
    const userCtx = await resolveUserContext(fromId);
    const miniAppUrl = await getMiniAppOpenUrl(bot);
    const keyboard = miniAppUrl ? new InlineKeyboard().webApp('📲 Open CheckFlow App', miniAppUrl) : undefined;

    if (userCtx) {
      const firstName = userCtx.fullName.split(' ')[0];
      const roleLabel = userCtx.isAdmin ? '👑 Business Admin' : '👤 Staff Cashier';
      await ctx.reply(
        `👋 *Welcome back, ${escMd(firstName)}\\!*\n\n` +
        `🏢 *Business:* ${escMd(userCtx.organizationName)}\n` +
        `📍 *Branch:* ${escMd(userCtx.branchName)}\n` +
        `👔 *Role:* ${roleLabel}\n\n` +
        `You are ready to verify receipts\\! Send me:\n` +
        `📸 A *photo* of a CBE or Telebirr receipt\n` +
        `📄 A *PDF* document\n` +
        `🔗 A *receipt link* or *transaction reference*\n` +
        `⌨️ Or use /manual for manual verification\\.\n\n` +
        (userCtx.isAdmin
          ? `*Admin commands:*\n📋 /accounts — List receiving accounts\n➕ /addaccount — Register new receiving account\n\n`
          : '') +
        `Type /help to see all commands\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: keyboard }
      );
    } else {
      await sendRegisterPrompt(ctx, bot);
    }
  });

  // ── /help ──────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    const fromId = ctx.from?.id;
    const userCtx = await resolveUserContext(fromId);
    const miniAppUrl = await getMiniAppOpenUrl(bot);
    const keyboard = miniAppUrl ? new InlineKeyboard().webApp('📲 Open CheckFlow App', miniAppUrl) : undefined;

    await ctx.reply(
      `*CheckFlow ET Bot — Commands*\n\n` +
      `*Verification*\n` +
      `/start — Welcome message & account status\n` +
      `/help — Show this help message\n` +
      `/status — Show system and session status\n` +
      `/manual — Manual verification entry\n\n` +
      (userCtx?.isAdmin
        ? `*Admin Management*\n` +
          `/accounts — List registered receiving accounts\n` +
          `/addaccount — Register a new receiving account \\(guided\\)\n` +
          `/cancel — Cancel an in\\-progress wizard\n\n`
        : '') +
      `*Manual entry format:*\n` +
      `\`/manual PROVIDER TXN\\_REF \\[AMOUNT\\]\`\n\n` +
      `Examples:\n` +
      `\`/manual CBE FT26300XXXXXX\`\n` +
      `\`/manual CBE FT26300XXXXXX 1500\`\n` +
      `\`/manual TELEBIRR SB9876543210 500\`\n\n` +
      `*Supported providers:*\n` +
      `\`CBE · TELEBIRR · DASHEN · AWASH · BOA · ZEMEN · CBE\\_BIRR · MPESA · SIINQEE\``,
      { parse_mode: 'MarkdownV2', reply_markup: keyboard }
    );
  });

  // ── /status ────────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const fromId = ctx.from?.id;
    const userCtx = await resolveUserContext(fromId);

    const totalOrgs = await prisma.organization.count().catch(() => 0);
    const totalUsers = await prisma.user.count().catch(() => 0);
    const totalAccounts = await prisma.bankSettlementAccount.count({ where: { isActive: true } }).catch(() => 0);

    let msg =
      `✅ *CheckFlow ET Bot Status*\n\n` +
      `🤖 *Bot:* @${escMd(_botUsername || 'CheckFlow')}\n` +
      `🌐 *Architecture:* Multi\\-tenant \\(Automatic business matching\\)\n` +
      `🏢 *Connected Businesses:* ${totalOrgs}\n` +
      `👥 *Registered Users:* ${totalUsers}\n` +
      `🏦 *Active Receiving Accounts:* ${totalAccounts}\n\n`;

    if (userCtx) {
      msg +=
        `👤 *Your Active Session:*\n` +
        `• Name: ${escMd(userCtx.fullName)}\n` +
        `• Business: ${escMd(userCtx.organizationName)}\n` +
        `• Branch: ${escMd(userCtx.branchName)}\n` +
        `• Role: ${userCtx.isAdmin ? '👑 Business Admin' : '👤 Cashier'}\n`;
    } else {
      msg += `⚠️ _Your Telegram account is not yet connected to a business\\. Tap below to register or log in\\._`;
    }

    const miniAppUrl = await getMiniAppOpenUrl(bot);
    const keyboard = (!userCtx && miniAppUrl) ? new InlineKeyboard().webApp('📲 Open CheckFlow App', miniAppUrl) : undefined;

    await ctx.reply(msg, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
  });

  // ── /accounts — list registered receiving accounts (Admin only) ─────────────
  bot.command('accounts', async (ctx) => {
    try {
      const fromId = ctx.from?.id;
      const userCtx = await resolveUserContext(fromId);

      if (!userCtx) {
        await sendRegisterPrompt(ctx, bot);
        return;
      }

      if (!userCtx.isAdmin) {
        await ctx.reply(
          `🔒 *Admins Only*\n\n` +
          `Viewing receiving accounts is for business admins only\\. You can verify customer payments by sending receipt photos or PDFs\\.`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      const accounts = await prisma.bankSettlementAccount.findMany({
        where: { organizationId: userCtx.organizationId },
        orderBy: { bankName: 'asc' },
      });

      if (accounts.length === 0) {
        await ctx.reply(
          `📋 *No receiving accounts registered yet for ${escMd(userCtx.organizationName)}\\.*\n\n` +
          `Use /addaccount to register your first CBE or Telebirr account\\.`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      const grouped = accounts.reduce<Record<string, typeof accounts>>((acc, a) => {
        if (!acc[a.bankName]) acc[a.bankName] = [];
        acc[a.bankName].push(a);
        return acc;
      }, {});

      let msg = `📋 *Receiving Accounts for ${escMd(userCtx.organizationName)}*\n\n`;
      for (const [bank, list] of Object.entries(grouped)) {
        const bankLabel = bank === 'TELEBIRR' ? '📱 TELEBIRR' : `🏦 ${bank}`;
        msg += `*${bankLabel}*\n`;
        for (const a of list) {
          const status = a.isActive ? '✅' : '❌ \\(inactive\\)';
          msg += `  • \`${a.accountNumber}\` — ${escMd(a.accountHolderName)} ${status}\n`;
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

  // ── /addaccount — start account registration wizard (Admin only) ────────────
  bot.command('addaccount', async (ctx) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat!.id;
    const userCtx = await resolveUserContext(fromId);

    if (!userCtx) {
      await sendRegisterPrompt(ctx, bot);
      return;
    }

    if (!userCtx.isAdmin) {
      await ctx.reply(
        `🔒 *Admins Only*\n\n` +
        `Adding receiving accounts is for business admins only\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    startWizard(chatId);
    await ctx.reply(
      `🏦 *Register a Receiving Account*\n\n` +
      `Business: *${escMd(userCtx.organizationName)}*\n\n` +
      `Which bank/provider?\n\n` +
      `Reply with one of:\n` +
      `\`CBE\` · \`TELEBIRR\` · \`BOA\` · \`AWASH\`\n\n` +
      `Or send /cancel to abort\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ── /cancel — abort active wizard ──────────────────────────────────────────
  bot.command('cancel', async (ctx) => {
    const chatId = ctx.chat!.id;
    if (wizardSessions.has(chatId)) {
      clearWizard(chatId);
      await ctx.reply('❌ Registration cancelled\\.', { parse_mode: 'MarkdownV2' });
    } else {
      await ctx.reply('Nothing to cancel\\.', { parse_mode: 'MarkdownV2' });
    }
  });

  // ── /manual PROVIDER TXN_REF [AMOUNT] ──────────────────────────────────────
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

    const fromId  = ctx.from?.id;
    const userCtx = await resolveUserContext(fromId);

    if (!userCtx) {
      await sendRegisterPrompt(ctx, bot);
      return;
    }

    await sendTyping(ctx);
    await ctx.reply('⏳ Verifying manual entry\\.\\.\\.', { parse_mode: 'MarkdownV2' });

    try {
      logger.info(`[telegram] manual verify user=${userCtx.fullName} org=${userCtx.organizationName} provider=${providerArg} ref=${txnRef}`);

      const outcome = await processVerification({
        branchId:      userCtx.branchId,
        cashierId:     userCtx.userId,
        provider:      providerArg as any,
        txnReference:  txnRef,
        amount:        amount,
        expectedAmount: amount,
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

  // ── Photo handler: receipt screenshot ──────────────────────────────────────
  bot.on('message:photo', async (ctx) => {
    const fromId  = ctx.from?.id;
    const userCtx = await resolveUserContext(fromId);

    if (!userCtx) {
      await sendRegisterPrompt(ctx, bot);
      return;
    }

    const photos = ctx.message.photo;
    const targetPhoto = selectOptimalPhoto(photos);
    logger.info(`[telegram] photo verify user=${userCtx.fullName} (${userCtx.organizationName}) dim=${targetPhoto.width}x${targetPhoto.height} fileId=${targetPhoto.file_id}`);

    // Fire typing and status prompt in parallel with download (do not block!)
    sendTyping(ctx).catch(() => {});
    const statusMsgPromise = ctx.reply('⏳ Verifying receipt photo\\.\\.\\.', { parse_mode: 'MarkdownV2' }).catch(() => null);

    let replyText: string;
    try {
      const { buffer, mime } = await downloadTelegramFile(bot, targetPhoto.file_id);
      const outcome = await runImageVerification({
        buffer,
        mimetype:  mime,
        branchId:  userCtx.branchId,
        cashierId: userCtx.userId,
      });
      logger.info(`[telegram] photo result: ${formatStatusLine(outcome.result)}`);
      replyText = formatVerificationResult({ httpStatus: outcome.status, result: outcome.result });
    } catch (err: any) {
      logger.error(`[telegram] photo error: ${err.message}`);
      replyText = '🆘 Failed to process this image\\. Please try again or send the receipt as a document \\(PDF\\)\\.';
    }

    // Deliver reply by transforming the status message in-place for instant feedback
    const statusMsg = await statusMsgPromise;
    if (statusMsg) {
      try {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, replyText, { parse_mode: 'MarkdownV2' });
        return;
      } catch {
        // Fall back to new reply if edit fails
      }
    }
    try {
      await ctx.reply(replyText, { parse_mode: 'MarkdownV2' });
    } catch (sendErr: any) {
      logger.error(`[telegram] photo reply failed: ${sendErr.message}`);
    }
  });

  // ── Document handler: PDF receipts or uncompressed images ──────────────────
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

    const fromId  = ctx.from?.id;
    const userCtx = await resolveUserContext(fromId);

    if (!userCtx) {
      await sendRegisterPrompt(ctx, bot);
      return;
    }

    sendTyping(ctx).catch(() => {});
    const statusMsgPromise = ctx.reply(`⏳ Verifying ${isPdf ? 'PDF' : 'image'} document\\.\\.\\.`, { parse_mode: 'MarkdownV2' }).catch(() => null);

    logger.info(`[telegram] document verify user=${userCtx.fullName} (${userCtx.organizationName}) mime=${mimeType} fileId=${doc.file_id}`);

    let replyText: string;
    try {
      const { buffer, mime } = await downloadTelegramFile(bot, doc.file_id);
      const outcome = await runImageVerification({
        buffer,
        mimetype:  isPdf ? 'application/pdf' : mime,
        branchId:  userCtx.branchId,
        cashierId: userCtx.userId,
      });
      logger.info(`[telegram] document result: ${formatStatusLine(outcome.result)}`);
      replyText = formatVerificationResult({ httpStatus: outcome.status, result: outcome.result });
    } catch (err: any) {
      logger.error(`[telegram] document error: ${err.message}`);
      replyText = '🆘 Failed to process this document\\. Please try again\\.';
    }

    const statusMsg = await statusMsgPromise;
    if (statusMsg) {
      try {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, replyText, { parse_mode: 'MarkdownV2' });
        return;
      } catch {
        // Fall back to new reply if edit fails
      }
    }
    try {
      await ctx.reply(replyText, { parse_mode: 'MarkdownV2' });
    } catch (sendErr: any) {
      logger.error(`[telegram] document reply failed: ${sendErr.message}`);
    }
  });

  // ── Text handler: URL, raw transaction reference, or wizard input ────────────
  bot.on('message:text', async (ctx) => {
    const text   = ctx.message.text.trim();
    const chatId = ctx.chat!.id;
    const fromId = ctx.from?.id;

    if (text.startsWith('/')) return;

    // ── Wizard intercept (account registration) ────────────────────────────────
    const session = getWizard(chatId);
    if (session) {
      const userCtx = await resolveUserContext(fromId);

      if (session.step === 'provider') {
        const input = text.toUpperCase() as BankProvider;
        if (!ACCOUNT_PROVIDERS.includes(input)) {
          await ctx.reply(
            `❌ Unknown provider \`${text}\`\\.\n\nPlease reply with one of: \`CBE\` · \`TELEBIRR\` · \`BOA\` · \`AWASH\``,
            { parse_mode: 'MarkdownV2' }
          );
          return;
        }
        session.provider = input;
        session.step = 'accountNumber';
        await ctx.reply(
          `✏️ Enter the *${input}* account number or phone:`,
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
          `✏️ Enter the *account holder name* \\(as registered at bank\\):`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      if (session.step === 'holderName') {
        const holderName = text;
        const { provider, accountNumber } = session;
        clearWizard(chatId);

        if (!userCtx || !userCtx.isAdmin) {
          await ctx.reply('🔒 Only registered business admins can save receiving accounts\\.', { parse_mode: 'MarkdownV2' });
          return;
        }

        try {
          const existing = await prisma.bankSettlementAccount.findFirst({
            where: {
              organizationId: userCtx.organizationId,
              bankName: provider! as any,
              accountNumber: accountNumber!
            }
          });

          if (existing) {
            await ctx.reply(
              `⚠️ Account \`${accountNumber}\` is already registered for *${provider}* in *${escMd(userCtx.organizationName)}*\\.`,
              { parse_mode: 'MarkdownV2' }
            );
            return;
          }

          await prisma.bankSettlementAccount.create({
            data: {
              organizationId: userCtx.organizationId,
              bankName: provider! as any,
              accountNumber: accountNumber!,
              accountHolderName: holderName,
              isActive: true,
            }
          });

          accountsCache.delete(`branch:${userCtx.branchId}`);
          logger.info(`[telegram] registered account provider=${provider} account=${accountNumber} org=${userCtx.organizationId}`);

          await ctx.reply(
            `✅ *Account registered successfully\\!*\n\n` +
            `🏢 Business: *${escMd(userCtx.organizationName)}*\n` +
            `🏦 Provider: *${provider}*\n` +
            `🔢 Account: \`${accountNumber}\`\n` +
            `👤 Holder: ${escMd(holderName)}\n\n` +
            `Customer receipts sent to this account will now be verified\\.`,
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
    const userCtx = await resolveUserContext(fromId);

    if (!userCtx) {
      await sendRegisterPrompt(ctx, bot);
      return;
    }

    await sendTyping(ctx);

    const isUrl = /^https?:\/\//i.test(text);
    try {
      await ctx.reply(
        `⏳ Verifying ${isUrl ? 'URL' : 'text reference'}\\.\\.\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch { /* non-critical */ }

    logger.info(`[telegram] text verify user=${userCtx.fullName} (${userCtx.organizationName}) isUrl=${isUrl}`);

    let replyText: string;
    try {
      const outcome = await verifyText(text, userCtx.branchId, userCtx.userId);
      logger.info(`[telegram] text result: ${formatStatusLine(outcome.result)}`);
      replyText = formatVerificationResult({ httpStatus: outcome.status, result: outcome.result });
    } catch (err: any) {
      logger.error(`[telegram] text error: ${err.message}`);
      replyText = '🆘 Failed to process this text\\. Please check the reference and try again\\.';
    }

    try {
      await ctx.reply(replyText, { parse_mode: 'MarkdownV2' });
    } catch (sendErr: any) {
      logger.error(`[telegram] text reply failed: ${sendErr.message}`);
    }
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  bot.catch((err) => {
    logger.error(`[telegram] Unhandled bot error: ${err.message ?? err}`);
  });

  return bot;
}

/** Start the bot in long-polling mode */
export function startBot(): void {
  const configErrors = validateBotConfig();
  if (configErrors.length > 0) {
    logger.error('[telegram] Bot NOT started due to configuration errors:');
    configErrors.forEach((e) => logger.error(`  • ${e}`));
    return;
  }

  logger.info('[telegram] Initialising bot...');
  logger.info('[telegram] Architecture: Multi-tenant (Dynamic user matching enabled)');

  (async () => {
    try {
      const bot = createBot();

      logger.info('[telegram] Clearing any existing webhook...');
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      logger.info('[telegram] Webhook cleared — starting long-poll...');

      await getBotUsername(bot);

      bot.start({
        onStart: (info) => {
          logger.info(`[telegram] ✅ Bot @${info.username} is online and polling (Multi-tenant mode)`);
        },
      });

    } catch (err: any) {
      logger.error(`[telegram] ❌ Fatal startup error: ${err.message ?? err}`);
      logger.info('[telegram] Retrying bot startup in 15 s...');
      setTimeout(() => startBot(), 15_000);
    }
  })();
}
