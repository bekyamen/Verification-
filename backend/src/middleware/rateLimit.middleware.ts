/**
 * rateLimit.middleware.ts
 *
 * In-memory rate limiter for POST /api/auth/login.
 * Tracks failed PIN attempts per phone number.
 * After MAX_ATTEMPTS failures the account is locked for LOCKOUT_MS.
 *
 * This also checks the DB-level lockedUntil field written by the login
 * controller so that a server restart doesn't reset the lockout.
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';
import logger from '../utils/logger';

const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes

interface Bucket {
  attempts:   number;
  lockedUntil: number | null; // epoch ms
}

const buckets = new Map<string, Bucket>();

/** Called by the login controller after a successful PIN check. */
export function resetLoginAttempts(phone: string): void {
  buckets.delete(phone);
}

/** Called by the login controller after a failed PIN check. */
export async function recordFailedAttempt(phone: string): Promise<void> {
  const bucket = buckets.get(phone) ?? { attempts: 0, lockedUntil: null };
  bucket.attempts += 1;

  if (bucket.attempts >= MAX_ATTEMPTS) {
    bucket.lockedUntil = Date.now() + LOCKOUT_MS;
    // Persist to DB so restarts keep the lockout
    const normalizedPhone = normalizePhone(phone);
    await prisma.user.updateMany({
      where: { phone: normalizedPhone },
      data: {
        loginAttempts: bucket.attempts,
        lockedUntil:  new Date(bucket.lockedUntil),
      },
    });
    logger.warn(`[rateLimit] Account locked for phone ${phone} until ${new Date(bucket.lockedUntil).toISOString()}`);
  }

  buckets.set(phone, bucket);
}

function normalizePhone(phone: string): string {
  if (phone.startsWith('09') || phone.startsWith('07')) return '+251' + phone.substring(1);
  if (!phone.startsWith('+')) return '+' + phone;
  return phone;
}

/**
 * Express middleware — must be mounted BEFORE the login controller.
 * Reads phone from req.body.phone.
 */
export const loginRateLimit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const phone = (req.body?.phone ?? '') as string;
  if (!phone) { next(); return; } // body validation error will be caught downstream

  const normalized = normalizePhone(phone);

  // 1. Check in-memory bucket first (fast path)
  const bucket = buckets.get(phone) ?? buckets.get(normalized);
  if (bucket?.lockedUntil && Date.now() < bucket.lockedUntil) {
    const remaining = Math.ceil((bucket.lockedUntil - Date.now()) / 60_000);
    res.status(429).json({
      error: `Too many failed attempts. Account locked for ${remaining} more minute(s).`,
    });
    return;
  }

  // 2. Fallback: check DB (covers the case after a server restart)
  try {
    const user = await prisma.user.findUnique({ where: { phone: normalized }, select: { lockedUntil: true } });
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const remaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      res.status(429).json({
        error: `Too many failed attempts. Account locked for ${remaining} more minute(s).`,
      });
      return;
    }
  } catch { /* non-critical — proceed */ }

  next();
};
