import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { registerSchema, loginSchema } from '../validators/auth.validator';
import prisma from '../utils/prisma';
import { JwtPayload } from '../types';
import { User } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: 24 * 60 * 60 * 1000 // 1 day
};

// Normalize Ethiopian phone numbers
const normalizePhone = (phone: string): string => {
  if (phone.startsWith('09') || phone.startsWith('07')) {
    return '+251' + phone.substring(1);
  }
  if (!phone.startsWith('+')) {
    return '+' + phone;
  }
  return phone;
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = registerSchema.parse(req.body);
    const normalizedPhone = normalizePhone(validatedData.phone);

    // Hash the PIN (we store it in passwordHash as required by the schema, and also pinCode for consistency if needed, but passwordHash is required)
    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(validatedData.pinCode, salt);

    let newUser: User | undefined;
    let defaultBranchId: string | null = null;
    let organizationId: string;

    await prisma.$transaction(async (tx) => {
      // Check if user already exists
      const existingUser = await tx.user.findUnique({
        where: { phone: normalizedPhone }
      });
      if (existingUser) {
        throw new Error('P2002'); // Simulate Prisma unique constraint error
      }

      if (validatedData.accountType === 'BUSINESS') {
        const org = await tx.organization.create({
          data: {
            name: `${validatedData.fullName}'s Business`,
            phone: normalizedPhone,
          }
        });
        organizationId = org.id;

        const branch = await tx.branch.create({
          data: {
            name: 'Main Branch',
            organizationId: org.id
          }
        });
        defaultBranchId = branch.id;

      } else {
        // PERSONAL
        const org = await tx.organization.create({
          data: {
            name: `Personal - ${validatedData.fullName}`,
            phone: normalizedPhone,
          }
        });
        organizationId = org.id;
        
        // Personal users might not need a branch for basic things, but creating a default one keeps structure clean
        const branch = await tx.branch.create({
          data: {
            name: 'Personal Space',
            organizationId: org.id
          }
        });
        defaultBranchId = branch.id;
      }

      newUser = await tx.user.create({
        data: {
          fullName: validatedData.fullName,
          phone: normalizedPhone,
          passwordHash: hashedPin, // Required string
          pinCode: hashedPin,      // Required for cashier login in older flow
          role: 'OWNER',
          organizationId: organizationId,
          branchId: defaultBranchId
        }
      });
    });

    if (!newUser) {
      res.status(500).json({ error: 'Failed to create user' });
      return;
    }

    const payload: JwtPayload = {
      userId: newUser.id,
      role: newUser.role,
      organizationId: newUser.organizationId,
      branchId: newUser.branchId
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1d' });
    
    res.cookie('token', token, COOKIE_OPTIONS);
    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: newUser.id,
        fullName: newUser.fullName,
        phone: newUser.phone,
        role: newUser.role,
        branchId: newUser.branchId,
        organizationId: newUser.organizationId
      }
    });

  } catch (error: any) {
    if (error.message === 'P2002' || error.code === 'P2002') {
      res.status(409).json({ error: 'An account with this phone number already exists.' });
      return;
    }
    res.status(400).json({ error: 'Validation failed or database error', details: error.errors || error.message });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = loginSchema.parse(req.body);
    const normalizedPhone = normalizePhone(validatedData.phone);

    const user = await prisma.user.findUnique({
      where: { phone: normalizedPhone }
    });

    if (!user) {
      res.status(401).json({ error: 'Invalid phone or PIN' });
      return;
    }

    const isMatch = await bcrypt.compare(validatedData.pinCode, user.passwordHash);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid phone or PIN' });
      return;
    }

    const payload: JwtPayload = {
      userId: user.id,
      role: user.role,
      organizationId: user.organizationId,
      branchId: user.branchId
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1d' });

    res.cookie('token', token, COOKIE_OPTIONS);
    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        branchId: user.branchId,
        organizationId: user.organizationId
      }
    });

  } catch (error: any) {
    res.status(400).json({ error: 'Validation failed', details: error.errors || error.message });
  }
};

/**
 * POST /auth/cashier-token
 *
 * Called once at shift start from a counter tablet.  Accepts the raw PIN and
 * branchId, verifies with bcrypt (the only time bcrypt runs), and returns a
 * short-lived JWT.  All subsequent /verify/* requests use that JWT via the
 * standard requireAuth middleware — no more bcrypt on every scan.
 *
 * Body: { pin: string, branchId: string }
 * Response: { token: string, cashier: { id, fullName, role } }
 */
export const cashierLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { pin, branchId } = req.body as { pin?: string; branchId?: string };

    if (!pin || !branchId) {
      res.status(400).json({ error: 'pin and branchId are required.' });
      return;
    }

    // Load all cashier-role users for this branch in one query
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

    // bcrypt compare — runs once here, never again per-request
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

    // 8-hour token — covers a full shift
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.status(200).json({
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
