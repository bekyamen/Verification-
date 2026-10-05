import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest, JwtPayload } from '../types';
import prisma from '../utils/prisma';
import bcrypt from 'bcryptjs';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

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
    // Embed standard user auth context if not present
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
