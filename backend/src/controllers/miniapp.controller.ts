/**
 * miniapp.controller.ts
 *
 * Handles Telegram Mini App initData validation and account linking.
 *
 * Flow:
 *  1. Browser sends initData (from Telegram.WebApp.initData) to POST /api/miniapp/auth
 *  2. Server validates HMAC-SHA256 against TELEGRAM_BOT_TOKEN (never trust client TG IDs)
 *  3. If valid and user is linked → return a JWT
 *  4. If valid but no linked user → return { needsRegistration: true, telegramUser }
 *  5. After register/login → POST /api/miniapp/link to store telegramId on the user record
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import { AuthenticatedRequest, JwtPayload } from '../types';
import logger from '../utils/logger';

const JWT_SECRET   = process.env.JWT_SECRET   || 'fallback_secret';
const BOT_TOKEN    = () => process.env.TELEGRAM_BOT_TOKEN ?? '';
const MAX_AGE_SECS = 24 * 60 * 60; // 24 hours

// ── Telegram initData validation ─────────────────────────────────────────────

interface TelegramUser {
  id:         number;
  first_name: string;
  last_name?: string;
  username?:  string;
  phone?:     string;
}

interface ParsedInitData {
  hash:         string;
  auth_date:    number;
  user?:        TelegramUser;
  query_id?:    string;
  chat_instance?: string;
}

function verifyInitData(initDataRaw: string): ParsedInitData {
  const params = new URLSearchParams(initDataRaw);
  const hash   = params.get('hash') ?? '';
  params.delete('hash');

  // Build data-check string: sorted k=v pairs joined by \n
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // HMAC-SHA256(dataCheckString, HMAC-SHA256("WebAppData", botToken))
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN())
    .digest();

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) {
    throw new Error('initData signature mismatch — possible tampering');
  }

  const authDate = parseInt(params.get('auth_date') ?? '0', 10);
  if (Date.now() / 1000 - authDate > MAX_AGE_SECS) {
    throw new Error('initData is older than 24 hours');
  }

  const userRaw = params.get('user');
  const parsedUser: TelegramUser | undefined = userRaw ? JSON.parse(userRaw) : undefined;

  return {
    hash,
    auth_date:    authDate,
    user:         parsedUser,
    query_id:     params.get('query_id') ?? undefined,
    chat_instance: params.get('chat_instance') ?? undefined,
  };
}

// ── POST /api/miniapp/auth ─────────────────────────────────────────────────────

export const miniappAuth = async (req: Request, res: Response): Promise<void> => {
  try {
    const { initData } = req.body as { initData?: string };

    if (!initData) {
      res.status(400).json({ error: 'initData is required' });
      return;
    }

    // Accept empty initData in development mode
    if (process.env.NODE_ENV === 'development' && initData === 'dev_bypass') {
      res.status(200).json({ needsRegistration: true, telegramUser: { id: 0, first_name: 'Dev' } });
      return;
    }

    let parsed: ParsedInitData;
    try {
      parsed = verifyInitData(initData);
    } catch (err: any) {
      logger.warn(`[miniapp] initData validation failed: ${err.message}`);
      res.status(401).json({ error: 'Invalid or expired Telegram session' });
      return;
    }

    if (!parsed.user?.id) {
      res.status(400).json({ error: 'No Telegram user in initData' });
      return;
    }

    const telegramId = BigInt(parsed.user.id);

    // Check if this Telegram ID is already linked to an API user
    const linked = await prisma.user.findUnique({
      where: { telegramId },
      select: {
        id: true, role: true, organizationId: true, branchId: true,
        fullName: true, phone: true,
      },
    });

    if (linked) {
      // Return a 7-day JWT so the Mini App stays logged in
      const payload: JwtPayload = {
        userId: linked.id,
        role:   linked.role,
        organizationId: linked.organizationId,
        branchId: linked.branchId,
      };
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

      res.status(200).json({
        token,
        user: {
          id:             linked.id,
          fullName:       linked.fullName,
          phone:          linked.phone,
          role:           linked.role,
          branchId:       linked.branchId,
          organizationId: linked.organizationId,
        },
        telegramUser: parsed.user,
      });
      return;
    }

    // Not linked yet — client should show Register or Login screen
    res.status(200).json({
      needsRegistration: true,
      telegramUser: {
        id:         parsed.user.id,
        first_name: parsed.user.first_name,
        last_name:  parsed.user.last_name,
        username:   parsed.user.username,
        phone:      parsed.user.phone,
      },
    });

  } catch (err: any) {
    logger.error(`[miniapp] auth error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/miniapp/link ────────────────────────────────────────────────────
// Called right after a successful register or login to persist the telegramId.
// Requires a valid JWT (requireAuth) + the original initData for re-validation.

export const miniappLink = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { initData } = req.body as { initData?: string };
    const userId = req.user?.userId;

    if (!initData || !userId) {
      res.status(400).json({ error: 'initData and a valid auth token are required' });
      return;
    }

    let parsed: ParsedInitData;
    try {
      parsed = verifyInitData(initData);
    } catch (err: any) {
      res.status(401).json({ error: 'Invalid or expired Telegram session' });
      return;
    }

    if (!parsed.user?.id) {
      res.status(400).json({ error: 'No Telegram user in initData' });
      return;
    }

    const telegramId = BigInt(parsed.user.id);

    // Check the telegramId isn't already linked to a DIFFERENT user
    const conflict = await prisma.user.findUnique({
      where: { telegramId },
      select: { id: true },
    });
    if (conflict && conflict.id !== userId) {
      res.status(409).json({ error: 'This Telegram account is already linked to another user' });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data:  { telegramId },
    });

    logger.info(`[miniapp] Linked telegramId=${parsed.user.id} to userId=${userId}`);
    res.status(200).json({ ok: true });

  } catch (err: any) {
    logger.error(`[miniapp] link error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/miniapp/me ───────────────────────────────────────────────────────
// Returns full profile for the logged-in user (used by the Profile screen).

export const miniappMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, fullName: true, phone: true, role: true,
        branchId: true, organizationId: true, telegramId: true,
        organization: { select: { name: true } },
        _count: { select: { createdAccounts: true } },
      },
    });

    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const accountCount = await prisma.bankSettlementAccount.count({
      where: { organizationId: user.organizationId },
    });

    res.status(200).json({
      user: {
        id:               user.id,
        fullName:         user.fullName,
        phone:            user.phone,
        role:             user.role,
        branchId:         user.branchId,
        organizationId:   user.organizationId,
        organizationName: user.organization.name,
        telegramLinked:   user.telegramId !== null,
        accountCount,
      },
    });
  } catch (err: any) {
    logger.error(`[miniapp] me error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
};
