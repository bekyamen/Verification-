import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import prisma from '../utils/prisma';
import { registerAccountSchema, updateAccountSchema } from '../validators/accounts.validator';
import { accountsCache } from '../utils/verifyCache';

// ── Invalidate branch cache for org ──────────────────────────────────────────
async function invalidateOrgCache(organizationId: string): Promise<void> {
  try {
    const branches = await prisma.branch.findMany({
      where: { organizationId },
      select: { id: true },
    });
    for (const b of branches) {
      accountsCache.delete(`branch:${b.id}`);
    }
  } catch {
    // Non-critical cache purge
  }
}

/**
 * GET /api/settings/accounts
 * Admin lists all receiving accounts, grouped by bank (CBE, Telebirr, etc.)
 */
export const getOrganizationAccounts = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      res.status(401).json({ error: 'Missing organization context.' });
      return;
    }

    const accounts = await prisma.bankSettlementAccount.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { fullName: true, id: true } },
        updatedBy: { select: { fullName: true, id: true } },
      },
    });

    // Group accounts by bank for easy display in UI
    const grouped: Record<string, typeof accounts> = {
      CBE: [],
      TELEBIRR: [],
    };

    for (const acc of accounts) {
      const bank = acc.bankName;
      if (!grouped[bank]) {
        grouped[bank] = [];
      }
      grouped[bank].push(acc);
    }

    res.status(200).json({ accounts, grouped });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch receiving accounts', details: error.message });
  }
};

/**
 * POST /api/settings/accounts
 * Admin adds a new receiving account.
 */
export const registerAccount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = registerAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid account details' });
      return;
    }

    const { bankName, accountNumber, accountHolderName } = parsed.data;
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) {
      res.status(401).json({ error: 'Missing user context.' });
      return;
    }

    // Check for duplicates within the same organization and bank
    const existing = await prisma.bankSettlementAccount.findFirst({
      where: {
        organizationId,
        bankName,
        accountNumber,
      },
    });

    if (existing) {
      res.status(409).json({
        error: 'An account with this number is already registered for your business.',
      });
      return;
    }

    const account = await prisma.bankSettlementAccount.create({
      data: {
        organizationId,
        bankName,
        accountNumber,
        accountHolderName,
        isActive: true,
        createdById: userId,
        updatedById: userId,
      },
    });

    await invalidateOrgCache(organizationId);

    res.status(201).json({
      message: 'Receiving account added successfully',
      account,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to add receiving account' });
  }
};

/**
 * PATCH /api/settings/accounts/:id
 * Admin edits account holder name or active status.
 */
export const updateAccount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accountId = req.params.id as string;
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) {
      res.status(401).json({ error: 'Missing user context.' });
      return;
    }

    const parsed = updateAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Validation failed' });
      return;
    }

    const account = await prisma.bankSettlementAccount.findUnique({
      where: { id: accountId },
    });

    if (!account || account.organizationId !== organizationId) {
      res.status(404).json({ error: 'Account not found or access denied.' });
      return;
    }

    const updateData: Record<string, any> = { updatedById: userId };
    if (parsed.data.accountHolderName !== undefined) {
      updateData.accountHolderName = parsed.data.accountHolderName;
    }
    if (parsed.data.isActive !== undefined) {
      updateData.isActive = parsed.data.isActive;
    }

    const updated = await prisma.bankSettlementAccount.update({
      where: { id: accountId },
      data: updateData,
    });

    await invalidateOrgCache(organizationId);

    res.status(200).json({
      message: 'Account updated successfully',
      account: updated,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update account', details: error.message });
  }
};

/**
 * PATCH /api/settings/accounts/:id/toggle
 * Admin turns receiving account on or off.
 */
export const toggleAccountStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accountId = req.params.id as string;
    const { isActive } = req.body as { isActive?: boolean };
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) {
      res.status(401).json({ error: 'Missing user context.' });
      return;
    }

    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive must be a boolean (true or false).' });
      return;
    }

    const account = await prisma.bankSettlementAccount.findUnique({
      where: { id: accountId },
    });

    if (!account || account.organizationId !== organizationId) {
      res.status(404).json({ error: 'Account not found or access denied.' });
      return;
    }

    const updated = await prisma.bankSettlementAccount.update({
      where: { id: accountId },
      data: {
        isActive,
        updatedById: userId,
      },
    });

    await invalidateOrgCache(organizationId);

    const message = updated.isActive
      ? 'Account enabled successfully'
      : 'Account disabled successfully';

    res.status(200).json({
      message,
      account: updated,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update account status', details: error.message });
  }
};

/**
 * DELETE /api/settings/accounts/:id
 * Admin permanently deletes a receiving account.
 */
export const deleteAccount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accountId = req.params.id as string;
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      res.status(401).json({ error: 'Missing organization context.' });
      return;
    }

    const account = await prisma.bankSettlementAccount.findUnique({
      where: { id: accountId },
    });

    if (!account || account.organizationId !== organizationId) {
      res.status(404).json({ error: 'Account not found or access denied.' });
      return;
    }

    await prisma.bankSettlementAccount.delete({
      where: { id: accountId },
    });

    await invalidateOrgCache(organizationId);

    res.status(200).json({
      message: 'Account deleted successfully',
      ok: true,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete receiving account', details: error.message });
  }
};
