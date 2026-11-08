import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest, JwtPayload } from '../types';
import prisma from '../utils/prisma';
import bcrypt from 'bcryptjs';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    res.status(401).json({ error: 'Please sign in to continue.' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  }
};

/**
 * Ensures caller is an Admin (OWNER or MANAGER).
 * Cashiers are rejected with a clear, friendly error.
 */
export const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).json({ error: 'Please sign in to continue.' });
    return;
  }

  if (req.user.role !== 'MANAGER' && req.user.role !== 'OWNER') {
    res.status(403).json({ error: 'This section is for business admins only.' });
    return;
  }

  next();
};

export const requireManager = requireAdmin;

/**
 * Legacy counter tablet PIN check (kept for backward compatibility).
 */
export const requireCashierPIN = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const pin = req.headers['x-cashier-pin'] as string;
  const branchId = req.headers['x-branch-id'] as string;

  if (!pin || !branchId) {
    res.status(400).json({ error: 'Missing cashier PIN or branch ID' });
    return;
  }

  try {
    const users = await prisma.user.findMany({
      where: {
        branchId,
        role: { in: ['CASHIER', 'MANAGER', 'OWNER'] },
        pinCode: { not: null }
      }
    });

    let matchedUser = null;
    for (const user of users) {
      if (user.pinCode && await bcrypt.compare(pin, user.pinCode)) {
        matchedUser = user;
        break;
      }
    }

    if (!matchedUser) {
      res.status(401).json({ error: 'Invalid PIN' });
      return;
    }

    req.cashierId = matchedUser.id;
    if (!req.user) {
      req.user = {
        userId: matchedUser.id,
        role: matchedUser.role,
        branchId: matchedUser.branchId,
        organizationId: matchedUser.organizationId
      };
    }

    next();
  } catch (error) {
    res.status(500).json({ error: 'Authentication error' });
  }
};
