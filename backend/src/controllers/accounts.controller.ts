import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import prisma from '../utils/prisma';
import { registerAccountSchema } from '../validators/accounts.validator';
import { accountsCache } from '../utils/verifyCache';

// ── Telebirr phone validation ─────────────────────────────────────────────────

function isValidTelebirrNumber(accountNumber: string): boolean {
  // Must be an Ethiopian mobile number: 09/07 (10 digits) or +2519/+2517 (13 digits)
  return /^(09|07)\d{8}$/.test(accountNumber) || /^\+251(9|7)\d{8}$/.test(accountNumber);
}

function isDigitsOnly(s: string): boolean {
  return /^\d+$/.test(s);
}

function validateAccountNumber(bankName: string, accountNumber: string): string | null {
  if (bankName === 'TELEBIRR') {
    if (!isValidTelebirrNumber(accountNumber)) {
      return 'Telebirr account number must be a valid Ethiopian mobile number (e.g. 0912345678 or +251912345678).';
    }
  } else {
    if (!isDigitsOnly(accountNumber)) {
      return 'Account number must contain digits only.';
    }
    if (accountNumber.length < 8) {
      return 'Account number must be at least 8 digits.';
    }
  }
  return null;
}

// ── invalidate branch cache for org ──────────────────────────────────────────
async function invalidateOrgCache(organizationId: string): Promise<void> {
  const branches = await prisma.branch.findMany({ where: { organizationId }, select: { id: true } });
  for (const b of branches) accountsCache.delete(`branch:${b.id}`);
}

// ── GET /api/settings/accounts ────────────────────────────────────────────────
export const getOrganizationAccounts = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) { res.status(401).json({ error: 'Missing organization context.' }); return; }

    const accounts = await prisma.bankSettlementAccount.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { fullName: true, id: true } },
        updatedBy: { select: { fullName: true, id: true } },
      },
    });

    res.status(200).json({ accounts });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch accounts', details: error.message });
  }
};

// ── POST /api/settings/accounts ───────────────────────────────────────────────
export const registerAccount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsedParams = registerAccountSchema.parse(req.body);
    const userId         = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) { res.status(401).json({ error: 'Missing context.' }); return; }

    // Validate account number format per bank
    const validationError = validateAccountNumber(parsedParams.bankName, parsedParams.accountNumber);
    if (validationError) { res.status(400).json({ error: validationError }); return; }

    // Check for duplicates (same bank + account number within org)
    const existing = await prisma.bankSettlementAccount.findFirst({
      where: { organizationId, bankName: parsedParams.bankName, accountNumber: parsedParams.accountNumber },
    });
    if (existing) {
      res.status(409).json({ error: 'An account with this number is already registered for your organization.' });
      return;
    }

    const account = await prisma.bankSettlementAccount.create({
      data: {
        organizationId,
        bankName:          parsedParams.bankName,
        accountNumber:     parsedParams.accountNumber,
        accountHolderName: parsedParams.accountHolderName,
        isActive:          true,
        createdById:       userId,
        updatedById:       userId,
      },
    });

    await invalidateOrgCache(organizationId);
    res.status(201).json({ account });
  } catch (error: any) {
    res.status(400).json({ error: 'Validation failed', details: error.errors || error.message });
  }
};

// ── PATCH /api/settings/accounts/:id ─────────────────────────────────────────
export const updateAccount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accountId      = req.params.id as string;
    const userId         = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) { res.status(401).json({ error: 'Missing context.' }); return; }

    const account = await prisma.bankSettlementAccount.findUnique({ where: { id: accountId } });
    if (!account || account.organizationId !== organizationId) {
      res.status(404).json({ error: 'Account not found or access denied.' });
      return;
    }

    // Only allow updating accountHolderName and isActive
    const { accountHolderName, isActive } = req.body as { accountHolderName?: string; isActive?: boolean };
    const updateData: Record<string, any> = { updatedById: userId };

    if (typeof accountHolderName === 'string' && accountHolderName.trim().length > 0) {
      updateData.accountHolderName = accountHolderName.trim();
    }
    if (typeof isActive === 'boolean') {
      updateData.isActive = isActive;
    }

    const updated = await prisma.bankSettlementAccount.update({
      where: { id: accountId },
      data:  updateData,
    });

    await invalidateOrgCache(organizationId);
    res.status(200).json({ account: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update account', details: error.message });
  }
};

// ── DELETE /api/settings/accounts/:id ────────────────────────────────────────
export const deleteAccount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accountId      = req.params.id as string;
    const organizationId = req.user?.organizationId;

    if (!organizationId) { res.status(401).json({ error: 'Missing context.' }); return; }

    const account = await prisma.bankSettlementAccount.findUnique({ where: { id: accountId } });
    if (!account || account.organizationId !== organizationId) {
      res.status(404).json({ error: 'Account not found or access denied.' });
      return;
    }

    await prisma.bankSettlementAccount.delete({ where: { id: accountId } });
    await invalidateOrgCache(organizationId);

    res.status(200).json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete account', details: error.message });
  }
};

// ── PATCH /api/settings/accounts/:id/toggle ───────────────────────────────────
export const toggleAccountStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accountId      = req.params.id as string;
    const { isActive }   = req.body;
    const userId         = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) { res.status(401).json({ error: 'Missing context.' }); return; }
    if (typeof isActive !== 'boolean') { res.status(400).json({ error: 'isActive must be a boolean.' }); return; }

    const account = await prisma.bankSettlementAccount.findUnique({ where: { id: accountId } });
    if (!account || account.organizationId !== organizationId) {
      res.status(404).json({ error: 'Account not found or access denied.' });
      return;
    }

    const updated = await prisma.bankSettlementAccount.update({
      where: { id: accountId },
      data:  { isActive, updatedById: userId },
    });

    await invalidateOrgCache(organizationId);
    res.status(200).json({ account: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update account status', details: error.message });
  }
};
