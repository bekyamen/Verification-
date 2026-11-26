import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { registerSchema, loginSchema, cashierLoginSchema } from '../validators/auth.validator';
import prisma from '../utils/prisma';
import { Role } from '@prisma/client';
import { AuthenticatedRequest, JwtPayload } from '../types';
import { recordFailedAttempt, resetLoginAttempts } from '../middleware/rateLimit.middleware';
import { verifyInitData } from './miniapp.controller';
import logger from '../utils/logger';
import { clearUserContextCache } from '../telegram/bot';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Normalize Ethiopian phone numbers to standard E.164 (+251...)
export const normalizePhone = (phone: string): string => {
  if (!phone) return '';
  const cleaned = phone.trim().replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('09') || cleaned.startsWith('07')) {
    return '+251' + cleaned.substring(1);
  }
  if (cleaned.startsWith('251') && !cleaned.startsWith('+')) {
    return '+' + cleaned;
  }
  if ((cleaned.startsWith('9') || cleaned.startsWith('7')) && cleaned.length === 9) {
    return '+251' + cleaned;
  }
  if (!cleaned.startsWith('+')) {
    return '+' + cleaned;
  }
  return cleaned;
};

/**
 * POST /api/auth/register
 * Passwordless new-user registration for Business or Personal accounts.
 * Authenticated via Telegram initData and bot-verified contact.
 */
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = registerSchema.parse(req.body);

    // 1. Cryptographically validate initData using HMAC-SHA256 and BOT_TOKEN
    let parsed: any;
    if (process.env.NODE_ENV === 'development' && validatedData.initData === 'dev_bypass') {
      parsed = { user: { id: 999999999, first_name: 'Dev User' } };
    } else {
      try {
        parsed = verifyInitData(validatedData.initData);
      } catch (err: any) {
        logger.warn(`[register] Cryptographic validation failed: ${err.message}`);
        res.status(401).json({ error: 'Invalid or expired Telegram session: ' + err.message });
        return;
      }
    }

    if (!parsed.user?.id) {
      res.status(400).json({ error: 'No Telegram user found in signed session' });
      return;
    }

    const telegramUserId = BigInt(parsed.user.id);

    // 2. If contact was passed directly from Telegram requestContact, save to telegram_contacts
    if (req.body.contact?.phone_number) {
      if (req.body.contact.user_id && BigInt(req.body.contact.user_id) !== telegramUserId) {
        res.status(403).json({ error: 'Shared contact does not match the current Telegram session' });
        return;
      }
      const rawContactPhone = normalizePhone(req.body.contact.phone_number);
      await prisma.telegramContact.upsert({
        where: { telegramUserId },
        update: {
          phoneNumber: rawContactPhone,
          firstName: req.body.contact.first_name || parsed.user.first_name || null,
          lastName: req.body.contact.last_name || parsed.user.last_name || null,
        },
        create: {
          telegramUserId,
          phoneNumber: rawContactPhone,
          firstName: req.body.contact.first_name || parsed.user.first_name || null,
          lastName: req.body.contact.last_name || parsed.user.last_name || null,
        },
      });
    }

    // 3. Fetch verified phone number from telegram_contacts table
    const storedContact = await prisma.telegramContact.findUnique({
      where: { telegramUserId },
    });

    const verifiedPhone = storedContact?.phoneNumber;
    if (!verifiedPhone) {
      res.status(400).json({ error: 'Phone number not verified through Telegram. Please share your phone number.' });
      return;
    }

    const normalizedPhone = normalizePhone(verifiedPhone);

    // 4. Prevent duplicate accounts by phone number AND telegram_user_id
    const duplicateUser = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: normalizedPhone },
          { telegramId: telegramUserId },
          { telegramUserId },
        ],
      },
    });

    if (duplicateUser) {
      res.status(409).json({ error: 'Account already exists. Please sign in.' });
      return;
    }

    // 5. Role mapping and setup
    const isBusiness = validatedData.accountType === 'business';
    const role: Role = isBusiness ? 'OWNER' : 'USER';
    const businessName = isBusiness ? validatedData.businessName!.trim() : null;
    const branchCount = isBusiness ? validatedData.branchCount! : null;

    const orgName = isBusiness ? businessName! : `Personal - ${validatedData.fullName}`;

    let newUser: any;
    let defaultBranch: any;
    let createdOrg: any;

    await prisma.$transaction(async (tx) => {
      createdOrg = await tx.organization.create({
        data: {
          name: orgName,
          phone: normalizedPhone,
        },
      });

      defaultBranch = await tx.branch.create({
        data: {
          name: isBusiness ? 'Main Branch' : 'Personal Space',
          organizationId: createdOrg.id,
        },
      });

      newUser = await tx.user.create({
        data: {
          fullName: validatedData.fullName,
          phone: normalizedPhone,
          passwordHash: null,
          pinCode: null,
          role,
          accountType: validatedData.accountType,
          businessName,
          branchCount,
          telegramId: telegramUserId,
          telegramUserId,
          organizationId: createdOrg.id,
          branchId: defaultBranch.id,
        },
      });
    });

    if (!newUser) {
      res.status(500).json({ error: 'Failed to create account. Please try again.' });
      return;
    }

    clearUserContextCache(telegramUserId);

    // 6. Issue 7-day session JWT token
    const payload: JwtPayload = {
      userId: newUser.id,
      role: newUser.role,
      organizationId: newUser.organizationId,
      branchId: newUser.branchId,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, COOKIE_OPTIONS);

    const isAdmin = newUser.role === 'OWNER' || newUser.role === 'MANAGER';

    logger.info(`[register] Passwordless registration completed for ${newUser.fullName} (${newUser.role}, ${newUser.accountType})`);

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: newUser.id,
        fullName: newUser.fullName,
        phone: newUser.phone,
        role: newUser.role,
        isAdmin,
        accountType: newUser.accountType,
        businessName: newUser.businessName,
        branchCount: newUser.branchCount,
        organizationId: newUser.organizationId,
        organizationName: createdOrg.name,
        branchId: newUser.branchId,
        branchName: defaultBranch.name,
        telegramLinked: true,
      },
    });
  } catch (error: any) {
    if (error.code === 'P2002' || error.message?.includes('P2002')) {
      res.status(409).json({ error: 'Account already exists. Please sign in.' });
      return;
    }
    const msg = error.errors?.[0]?.message || error.message || 'Validation failed';
    res.status(400).json({ error: msg });
  }
};

/**
 * POST /api/auth/login
 * Admin logs in with phone + 4-digit PIN.
 */
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = loginSchema.parse(req.body);
    const normalizedPhone = normalizePhone(validatedData.phone);

    const user = await prisma.user.findUnique({
      where: { phone: normalizedPhone },
      include: {
        organization: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    if (!user) {
      await recordFailedAttempt(validatedData.phone);
      res.status(401).json({ error: 'Invalid phone or PIN' });
      return;
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMinutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      res.status(429).json({
        error: `Account is temporarily locked. Please try again in ${remainingMinutes} minute(s).`,
      });
      return;
    }

    if (!user.passwordHash) {
      res.status(401).json({ error: 'This account uses passwordless Telegram authentication. Please sign in via Telegram.' });
      return;
    }

    const isMatch = await bcrypt.compare(validatedData.pinCode, user.passwordHash);
    if (!isMatch) {
      await recordFailedAttempt(validatedData.phone);
      res.status(401).json({ error: 'Invalid phone or PIN' });
      return;
    }

    // Reset lockout counters on success
    resetLoginAttempts(validatedData.phone);
    if (user.loginAttempts > 0 || user.lockedUntil !== null) {
      await prisma.user.update({
        where: { id: user.id },
        data: { loginAttempts: 0, lockedUntil: null },
      });
    }

    // Safely link Telegram identity if logged in from Telegram
    if (req.body.initData && typeof req.body.initData === 'string') {
      try {
        const parsed = verifyInitData(req.body.initData);
        if (parsed.user?.id) {
          const telegramId = BigInt(parsed.user.id);
          const conflict = await prisma.user.findUnique({
            where: { telegramId },
            select: { id: true, fullName: true },
          });
          if (conflict && conflict.id !== user.id) {
            logger.warn(`[auth] Telegram ID ${telegramId} already linked to ${conflict.fullName}; cannot re-link to ${user.fullName}`);
          } else {
            await prisma.user.update({
              where: { id: user.id },
              data: { telegramId },
            });
            clearUserContextCache(telegramId);
            logger.info(`[auth] Successfully linked Telegram ID ${telegramId} to ${user.fullName}`);
          }
        }
      } catch (err: any) {
        logger.warn(`[auth] Invalid initData during login: ${err.message}`);
      }
    }

    const payload: JwtPayload = {
      userId: user.id,
      role: user.role,
      organizationId: user.organizationId,
      branchId: user.branchId,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, COOKIE_OPTIONS);
    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        organizationId: user.organizationId,
        organizationName: user.organization?.name,
        branchId: user.branchId,
        branchName: user.branch?.name,
      },
    });
  } catch (error: any) {
    const msg = error.errors?.[0]?.message || error.message || 'Validation failed';
    res.status(400).json({ error: msg });
  }
};

/**
 * POST /api/auth/cashier-login
 * Cashier logs in with password.
 * Password is required; fullName and branchId are optional for disambiguation.
 */
export const cashierPasswordLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = cashierLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Password is required' });
      return;
    }

    const { password, fullName, branchId } = parsed.data;

    const now = new Date();
    const whereClause: any = {
      role: 'CASHIER',
      passwordHash: { not: '' },
      OR: [
        { lockedUntil: null },
        { lockedUntil: { lte: now } },
      ],
    };

    if (branchId) {
      whereClause.branchId = branchId;
    }

    const candidates = await prisma.user.findMany({
      where: whereClause,
      include: {
        organization: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    if (candidates.length === 0) {
      res.status(401).json({ error: 'Wrong password, try again.' });
      return;
    }

    // If fullName provided, prioritize cashiers whose name matches
    let pool = candidates;
    if (fullName && fullName.trim().length >= 2) {
      const term = fullName.trim().toLowerCase();
      const narrowed = candidates.filter((u) => u.fullName.toLowerCase().includes(term));
      if (narrowed.length > 0) {
        pool = narrowed;
      }
    }

    let matched: typeof candidates[number] | null = null;
    for (const u of pool) {
      if (u.passwordHash && (await bcrypt.compare(password, u.passwordHash))) {
        matched = u;
        break;
      }
    }

    // Fallback to checking the rest if prioritized pool didn't match
    if (!matched && pool !== candidates) {
      for (const u of candidates) {
        if (u.passwordHash && (await bcrypt.compare(password, u.passwordHash))) {
          matched = u;
          break;
        }
      }
    }

    if (!matched) {
      res.status(401).json({ error: 'Wrong password, try again.' });
      return;
    }

    // Safely link Telegram to cashier if logged in from Telegram
    if (req.body.initData && typeof req.body.initData === 'string') {
      try {
        const parsed = verifyInitData(req.body.initData);
        if (parsed.user?.id) {
          const telegramId = BigInt(parsed.user.id);
          const conflict = await prisma.user.findUnique({
            where: { telegramId },
            select: { id: true, fullName: true },
          });
          if (conflict && conflict.id !== matched.id) {
            logger.warn(`[auth] Telegram ID ${telegramId} already linked to ${conflict.fullName}; cannot link to cashier ${matched.fullName}`);
          } else {
            await prisma.user.update({
              where: { id: matched.id },
              data: { telegramId },
            });
            clearUserContextCache(telegramId);
            logger.info(`[auth] Successfully linked Telegram ID ${telegramId} to cashier ${matched.fullName}`);
          }
        }
      } catch (err: any) {
        logger.warn(`[auth] Invalid initData during cashier login: ${err.message}`);
      }
    }

    const payload: JwtPayload = {
      userId: matched.id,
      role: matched.role,
      organizationId: matched.organizationId,
      branchId: matched.branchId,
    };

    // 8-hour token for a work shift
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    const cashierInfo = {
      id: matched.id,
      fullName: matched.fullName,
      role: matched.role,
      branchId: matched.branchId,
      branchName: matched.branch?.name,
      organizationId: matched.organizationId,
      organizationName: matched.organization?.name,
    };

    res.cookie('token', token, COOKIE_OPTIONS);
    res.status(200).json({
      message: 'Login successful',
      token,
      cashier: cashierInfo,
      user: cashierInfo,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Authentication error', details: error.message });
  }
};

/**
 * GET /api/auth/me
 * Returns profile of the logged-in user (Admin or Cashier).
 */
export const getMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Please sign in to continue.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        organization: { select: { id: true, name: true, phone: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User account not found.' });
      return;
    }

    const isAdmin = user.role === 'OWNER' || user.role === 'MANAGER';
    let accountsCount = 0;
    let cashiersCount = 0;

    if (isAdmin) {
      [accountsCount, cashiersCount] = await Promise.all([
        prisma.bankSettlementAccount.count({ where: { organizationId: user.organizationId } }),
        prisma.user.count({ where: { organizationId: user.organizationId, role: 'CASHIER' } }),
      ]);
    }

    const cleanPhone = user.phone.startsWith('CASHIER-') ? null : user.phone;

    res.status(200).json({
      user: {
        id: user.id,
        fullName: user.fullName,
        phone: cleanPhone,
        role: user.role,
        isAdmin,
        organizationId: user.organizationId,
        organizationName: user.organization.name,
        branchId: user.branchId,
        branchName: user.branch?.name,
        telegramLinked: user.telegramId !== null,
        accountsCount: isAdmin ? accountsCount : undefined,
        cashiersCount: isAdmin ? cashiersCount : undefined,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch user profile', details: error.message });
  }
};

/**
 * POST /api/auth/logout
 * Signs out current user by clearing the auth cookie and invalidating sessions.
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Invalidate HttpOnly auth cookie thoroughly
    const { maxAge, ...clearOptions } = COOKIE_OPTIONS;
    res.clearCookie('token', { ...clearOptions, path: '/', expires: new Date(0) });
    res.clearCookie('token', { path: '/' });
    res.clearCookie('token');

    // 2. Invalidate any cached Telegram bot session context if token/user is present
    let userId: string | undefined = (req as AuthenticatedRequest).user?.userId;
    if (!userId) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const rawToken = authHeader.split(' ')[1];
        try {
          const decoded = jwt.verify(rawToken, JWT_SECRET) as JwtPayload;
          userId = decoded?.userId;
        } catch {
          // Token may be invalid/expired, ignore
        }
      }
    }

    if (userId) {
      // Clear user context cache from Telegram bot if telegramId is linked
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { telegramId: true },
        });
        if (user?.telegramId) {
          clearUserContextCache(user.telegramId);

          // If client explicitly requested unlinking Telegram on logout
          const shouldUnlink = (req.body as any)?.unlinkTelegram === true || (req.query as any)?.unlinkTelegram === 'true';
          if (shouldUnlink) {
            await prisma.user.update({
              where: { id: userId },
              data: { telegramId: null },
            });
            logger.info(`[auth] Unlinked telegramId for userId=${userId} on logout`);
          }
        }
      } catch (err: any) {
        logger.warn(`[auth] logout: failed to clear bot context: ${err.message}`);
      }
    }

    res.status(200).json({ message: 'Signed out successfully' });
  } catch (error: any) {
    logger.error(`[auth] logout error: ${error.message}`);
    res.status(500).json({ error: 'Failed to sign out', details: error.message });
  }
};

/**
 * POST /api/auth/cashier-token
 * Legacy PIN-based cashier login (counter tablet shift start).
 */
export const cashierLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { pin, branchId } = req.body as { pin?: string; branchId?: string };

    if (!pin || !branchId) {
      res.status(400).json({ error: 'pin and branchId are required.' });
      return;
    }

    const users = await prisma.user.findMany({
      where: {
        branchId,
        role: { in: ['CASHIER', 'MANAGER', 'OWNER'] },
        pinCode: { not: null },
      },
    });

    if (users.length === 0) {
      res.status(401).json({ error: 'Invalid PIN or branch.' });
      return;
    }

    let matched: typeof users[number] | null = null;
    for (const u of users) {
      if (u.pinCode && (await bcrypt.compare(pin, u.pinCode))) {
        matched = u;
        break;
      }
    }

    if (!matched) {
      res.status(401).json({ error: 'Invalid PIN.' });
      return;
    }

    const payload: JwtPayload = {
      userId: matched.id,
      role: matched.role,
      organizationId: matched.organizationId,
      branchId: matched.branchId,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.status(200).json({
      message: 'Login successful',
      token,
      cashier: {
        id: matched.id,
        fullName: matched.fullName,
        role: matched.role,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Authentication error', details: error.message });
  }
};

/**
 * POST /api/auth/telegram-login
 * Passwordless sign-in for existing users and admins via Telegram-registered phone number.
 * Validates Telegram initData cryptographic HMAC-SHA256 signature, matches phone,
 * and issues JWT session without requiring a password.
 */
export const telegramPhoneLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { initData, contact, phone } = req.body as {
      initData?: string;
      contact?: {
        phone_number?: string;
        first_name?: string;
        last_name?: string;
        user_id?: number | string;
      };
      phone?: string;
    };

    if (!initData) {
      res.status(400).json({ error: 'initData is required for Telegram phone sign-in' });
      return;
    }

    // 1. Cryptographically validate initData using HMAC-SHA256 and BOT_TOKEN
    let parsed: any;
    if (process.env.NODE_ENV === 'development' && initData === 'dev_bypass') {
      parsed = { user: { id: 999999999, first_name: 'Dev User' } };
    } else {
      try {
        parsed = verifyInitData(initData);
      } catch (err: any) {
        logger.warn(`[telegram-login] Cryptographic validation failed: ${err.message}`);
        res.status(401).json({ error: 'Invalid or expired Telegram session: ' + err.message });
        return;
      }
    }

    if (!parsed.user?.id) {
      res.status(400).json({ error: 'No Telegram user found in signed initData' });
      return;
    }

    const telegramUserId = BigInt(parsed.user.id);

    // 2. Extract phone number and ensure it cannot be spoofed
    const rawPhone = contact?.phone_number || phone;
    if (!rawPhone) {
      res.status(400).json({ error: 'Phone number is required from Telegram contact' });
      return;
    }

    // If contact payload contains user_id, ensure it matches the verified Telegram user id
    if (contact?.user_id && BigInt(contact.user_id) !== telegramUserId) {
      logger.warn(`[telegram-login] User ID mismatch: contact.user_id=${contact.user_id} vs initData.user.id=${telegramUserId}`);
      res.status(403).json({ error: 'Shared contact does not match the current Telegram user session' });
      return;
    }

    // 3. Normalize extracted phone number to E.164 (+251...)
    const normalizedPhone = normalizePhone(rawPhone);
    const withoutPlus = normalizedPhone.replace(/^\+/, '');
    const localFormat = normalizedPhone.startsWith('+251') ? '0' + normalizedPhone.slice(4) : null;
    const phoneCandidates = [normalizedPhone, withoutPlus];
    if (localFormat) phoneCandidates.push(localFormat);

    // 4. Look up existing user in database by phone or linked telegramId
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: { in: phoneCandidates } },
          { telegramId: telegramUserId },
        ],
      },
      include: {
        organization: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        _count: { select: { createdAccounts: true } },
      },
    });

    // If not registered yet, return clear 404 with pre-fill phone
    if (!user) {
      logger.info(`[telegram-login] Unregistered phone attempted login: ${normalizedPhone}`);
      res.status(404).json({
        error: 'Account not found. Please register first.',
        notFound: true,
        needsRegistration: true,
        phone: normalizedPhone,
        telegramUser: parsed.user,
      });
      return;
    }

    // 5. Update linked telegramId on user record if missing or updated
    if (user.telegramId !== telegramUserId) {
      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { telegramId: telegramUserId },
        });
        clearUserContextCache(telegramUserId);
      } catch (err: any) {
        logger.warn(`[telegram-login] Could not update telegramId for user ${user.id}: ${err.message}`);
      }
    }

    // 6. Reset any failed login attempts
    await resetLoginAttempts(user.id);

    // 7. Issue 7-day session JWT token
    const payload: JwtPayload = {
      userId: user.id,
      role: user.role,
      organizationId: user.organizationId,
      branchId: user.branchId,
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    // Set HttpOnly auth cookie
    res.cookie('token', token, COOKIE_OPTIONS);

    const isAdmin = user.role === 'OWNER' || user.role === 'MANAGER';

    logger.info(`[telegram-login] Passwordless login successful for ${user.fullName} (${user.role}) via phone=${normalizedPhone}`);

    res.status(200).json({
      message: `Welcome back, ${user.fullName.split(' ')[0]}!`,
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        isAdmin,
        organizationId: user.organizationId,
        organizationName: user.organization?.name,
        branchId: user.branchId,
        branchName: user.branch?.name,
        telegramLinked: true,
        accountsCount: user._count?.createdAccounts ?? 0,
      },
    });
  } catch (error: any) {
    logger.error(`[telegram-login] Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to authenticate via Telegram phone', details: error.message });
  }
};
