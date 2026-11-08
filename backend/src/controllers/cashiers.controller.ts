import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { AuthenticatedRequest } from '../types';
import prisma from '../utils/prisma';
import { z } from 'zod';

const createCashierSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters'),
  password: z.string().min(4, 'Password must be at least 4 characters'),
});

const updateCashierSchema = z.object({
  fullName: z.string().trim().min(2).optional(),
  password: z.string().min(4, 'Password must be at least 4 characters').optional(),
  active: z.boolean().optional(),
}).refine((d) => d.fullName !== undefined || d.password !== undefined || d.active !== undefined, {
  message: 'Provide at least fullName, password, or active status to update',
});

async function getEffectiveBranchId(organizationId: string, currentBranchId?: string | null): Promise<string> {
  if (currentBranchId) return currentBranchId;

  const branch = await prisma.branch.findFirst({
    where: { organizationId },
    select: { id: true },
  });

  if (branch) return branch.id;

  const created = await prisma.branch.create({
    data: {
      name: 'Main Branch',
      organizationId,
    },
    select: { id: true },
  });

  return created.id;
}

/**
 * GET /api/cashiers
 * Admin lists all cashiers in their business.
 */
export const listCashiers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      res.status(401).json({ error: 'Missing organization context.' });
      return;
    }

    const cashiers = await prisma.user.findMany({
      where: { organizationId, role: 'CASHIER' },
      select: {
        id: true,
        fullName: true,
        role: true,
        branchId: true,
        lockedUntil: true,
        createdAt: true,
        branch: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const now = new Date();
    const formatted = cashiers.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      role: c.role,
      branchId: c.branchId,
      branchName: c.branch?.name ?? null,
      isActive: c.lockedUntil === null || c.lockedUntil <= now,
      createdAt: c.createdAt,
    }));

    res.status(200).json({ cashiers: formatted });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch cashiers', details: err.message });
  }
};

/**
 * POST /api/cashiers
 * Admin creates a new cashier. Auto-assigned to business and branch.
 * Enforces branch-level password uniqueness.
 */
export const createCashier = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = createCashierSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' });
      return;
    }

    const { fullName, password } = parsed.data;
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      res.status(401).json({ error: 'Missing organization context.' });
      return;
    }

    const branchId = await getEffectiveBranchId(organizationId, req.user?.branchId);

    // Password uniqueness: no two cashiers in the same branch may have the same password
    const existingCashiers = await prisma.user.findMany({
      where: {
        branchId,
        role: 'CASHIER',
        passwordHash: { not: '' },
      },
      select: { id: true, passwordHash: true },
    });

    for (const u of existingCashiers) {
      if (u.passwordHash && (await bcrypt.compare(password, u.passwordHash))) {
        res.status(409).json({
          error: 'That password is already in use by another cashier in this branch. Please choose a different one.',
        });
        return;
      }
    }

    const syntheticPhone = `CASHIER-${organizationId.slice(0, 8)}-${Date.now()}`;
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const cashier = await prisma.user.create({
      data: {
        fullName,
        phone: syntheticPhone,
        passwordHash: hash,
        pinCode: hash,
        role: 'CASHIER',
        organizationId,
        branchId,
      },
      select: {
        id: true,
        fullName: true,
        role: true,
        branchId: true,
        createdAt: true,
        branch: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      message: 'Cashier created successfully',
      cashier: {
        id: cashier.id,
        fullName: cashier.fullName,
        role: cashier.role,
        branchId: cashier.branchId,
        branchName: cashier.branch?.name ?? null,
        isActive: true,
        createdAt: cashier.createdAt,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create cashier', details: err.message });
  }
};

/**
 * PATCH /api/cashiers/:id
 * Admin edits cashier full name, resets password, and/or updates active state.
 */
export const updateCashier = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const cashierId = req.params.id as string;
    const parsed = updateCashierSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' });
      return;
    }

    const { fullName, password, active } = parsed.data;
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      res.status(401).json({ error: 'Missing organization context.' });
      return;
    }

    const target = await prisma.user.findUnique({
      where: { id: cashierId },
      select: { id: true, organizationId: true, role: true, branchId: true },
    });

    if (!target || target.organizationId !== organizationId) {
      res.status(404).json({ error: 'Cashier not found or access denied.' });
      return;
    }
    if (target.role !== 'CASHIER') {
      res.status(403).json({ error: 'Only cashier accounts can be edited here.' });
      return;
    }

    const updateData: Record<string, any> = {};

    if (fullName) {
      updateData.fullName = fullName;
    }

    if (password) {
      const branchId = target.branchId ?? (await getEffectiveBranchId(organizationId, null));
      const siblingCashiers = await prisma.user.findMany({
        where: {
          branchId,
          role: 'CASHIER',
          id: { not: cashierId },
          passwordHash: { not: '' },
        },
        select: { id: true, passwordHash: true },
      });

      for (const sibling of siblingCashiers) {
        if (sibling.passwordHash && (await bcrypt.compare(password, sibling.passwordHash))) {
          res.status(409).json({
            error: 'That password is already in use by another cashier in this branch. Please choose a different one.',
          });
          return;
        }
      }

      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(password, salt);
      updateData.passwordHash = hash;
      updateData.pinCode = hash;
    }

    if (typeof active === 'boolean') {
      updateData.lockedUntil = active ? null : new Date('2099-12-31T00:00:00Z');
    }

    const updated = await prisma.user.update({
      where: { id: cashierId },
      data: updateData,
      select: {
        id: true,
        fullName: true,
        role: true,
        branchId: true,
        lockedUntil: true,
        createdAt: true,
        branch: { select: { id: true, name: true } },
      },
    });

    const now = new Date();
    res.status(200).json({
      message: 'Cashier updated successfully',
      cashier: {
        id: updated.id,
        fullName: updated.fullName,
        role: updated.role,
        branchId: updated.branchId,
        branchName: updated.branch?.name ?? null,
        isActive: updated.lockedUntil === null || updated.lockedUntil <= now,
        createdAt: updated.createdAt,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update cashier', details: err.message });
  }
};

/**
 * PATCH /api/cashiers/:id/status
 * Admin enables or disables a cashier.
 */
export const setCashierStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const cashierId = req.params.id as string;
    const { active } = req.body as { active?: boolean };

    if (typeof active !== 'boolean') {
      res.status(400).json({ error: '`active` must be a boolean (true or false).' });
      return;
    }

    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      res.status(401).json({ error: 'Missing organization context.' });
      return;
    }

    const target = await prisma.user.findUnique({
      where: { id: cashierId },
      select: { organizationId: true, role: true },
    });

    if (!target || target.organizationId !== organizationId) {
      res.status(404).json({ error: 'Cashier not found or access denied.' });
      return;
    }
    if (target.role !== 'CASHIER') {
      res.status(403).json({ error: 'Only cashier accounts can be modified.' });
      return;
    }

    const lockedUntil = active ? null : new Date('2099-12-31T00:00:00Z');

    const updated = await prisma.user.update({
      where: { id: cashierId },
      data: { lockedUntil },
      select: { id: true, fullName: true, role: true, branchId: true, lockedUntil: true },
    });

    const now = new Date();
    const isActive = updated.lockedUntil === null || updated.lockedUntil <= now;
    const message = isActive ? 'Cashier enabled successfully' : 'Cashier disabled successfully';

    res.status(200).json({
      message,
      cashier: {
        id: updated.id,
        fullName: updated.fullName,
        role: updated.role,
        branchId: updated.branchId,
        isActive,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update cashier status', details: err.message });
  }
};

/**
 * DELETE /api/cashiers/:id
 * Admin permanently deletes a cashier.
 */
export const deleteCashier = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const cashierId = req.params.id as string;
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      res.status(401).json({ error: 'Missing organization context.' });
      return;
    }

    const target = await prisma.user.findUnique({
      where: { id: cashierId },
      select: { organizationId: true, role: true },
    });

    if (!target || target.organizationId !== organizationId) {
      res.status(404).json({ error: 'Cashier not found or access denied.' });
      return;
    }
    if (target.role !== 'CASHIER') {
      res.status(403).json({ error: 'Only cashier accounts can be deleted.' });
      return;
    }

    await prisma.user.delete({ where: { id: cashierId } });

    res.status(200).json({
      message: 'Cashier removed successfully',
      ok: true,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete cashier', details: err.message });
  }
};
