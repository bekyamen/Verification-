import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { registerSchema, loginSchema, cashierLoginSchema } from '../validators/auth.validator';
import prisma from '../utils/prisma';
import { AuthenticatedRequest, JwtPayload } from '../types';
import { recordFailedAttempt, resetLoginAttempts } from '../middleware/rateLimit.middleware';
import { verifyInitData } from './miniapp.controller';
import logger from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Normalize Ethiopian phone numbers
export const normalizePhone = (phone: string): string => {
  const cleaned = phone.trim().replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('09') || cleaned.startsWith('07')) {
    return '+251' + cleaned.substring(1);
  }
  if (!cleaned.startsWith('+')) {
    return '+' + cleaned;
  }
  return cleaned;
};

/**
 * POST /api/auth/register
 * Admin creates a new account (Personal or Business).
 */
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = registerSchema.parse(req.body);
    const normalizedPhone = normalizePhone(validatedData.phone);

    // Safely extract Telegram identity from signed initData
    let telegramId: bigint | null = null;
    if (req.body.initData && typeof req.body.initData === 'string') {
      try {
        const parsed = verifyInitData(req.body.initData);
        if (parsed.user?.id) {
          telegramId = BigInt(parsed.user.id);
          const conflict = await prisma.user.findUnique({
            where: { telegramId },
            select: { id: true, fullName: true },
          });
          if (conflict) {
            res.status(409).json({
              error: `This Telegram account is already linked to ${conflict.fullName}. Each Telegram account can only be linked to one user.`,
            });
            return;
          }
        }
      } catch (err: any) {
        logger.warn(`[auth] Invalid initData during register: ${err.message}`);
      }
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(validatedData.pinCode, salt);

    let newUser: any;
    let defaultBranch: any;
    let createdOrg: any;

    await prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: { phone: normalizedPhone },
      });
      if (existingUser) {
        throw new Error('P2002');
      }

      const isBusiness = validatedData.accountType === 'BUSINESS';
      const orgName = isBusiness
        ? `${validatedData.fullName}'s Business`
        : `Personal - ${validatedData.fullName}`;

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
          passwordHash: hashedPin,
          pinCode: hashedPin,
          role: 'OWNER',
          organizationId: createdOrg.id,
          branchId: defaultBranch.id,
          telegramId: telegramId ?? undefined,
        },
      });
    });

    if (!newUser) {
      res.status(500).json({ error: 'Failed to create account. Please try again.' });
      return;
    }

    const payload: JwtPayload = {
      userId: newUser.id,
      role: newUser.role,
      organizationId: newUser.organizationId,
      branchId: newUser.branchId,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, COOKIE_OPTIONS);
    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: newUser.id,
        fullName: newUser.fullName,
        phone: newUser.phone,
        role: newUser.role,
        accountType: validatedData.accountType,
        organizationId: newUser.organizationId,
        organizationName: createdOrg.name,
        branchId: newUser.branchId,
      },
    });
  } catch (error: any) {
    if (error.message === 'P2002' || error.code === 'P2002') {
      res.status(409).json({ error: 'An account with this phone number already exists.' });
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
 * Signs out current user by clearing the auth cookie.
 */
export const logout = async (_req: Request, res: Response): Promise<void> => {
  res.clearCookie('token', COOKIE_OPTIONS);
  res.status(200).json({ message: 'Signed out successfully' });
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
