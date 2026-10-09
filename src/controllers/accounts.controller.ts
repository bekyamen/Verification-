import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import prisma from '../utils/prisma';
import { registerAccountSchema } from '../validators/accounts.validator';

export const getOrganizationAccounts = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userRole = req.user?.role;
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
         updatedBy: { select: { fullName: true, id: true } }
      }
    });

    res.status(200).json({ accounts });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch accounts', details: error.message });
  }
};

export const registerAccount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsedParams = registerAccountSchema.parse(req.body);
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) {
      res.status(401).json({ error: 'Missing context.' });
      return;
    }

    // Verify if duplicates exist (same bank and account number)
    const existing = await prisma.bankSettlementAccount.findFirst({
        where: {
            organizationId,
            bankName: parsedParams.bankName,
            accountNumber: parsedParams.accountNumber
        }
    });

    if (existing) {
        res.status(409).json({ error: 'An account with this number is already registered for your organization.' });
        return;
    }

    const account = await prisma.bankSettlementAccount.create({
      data: {
        organizationId,
        bankName: parsedParams.bankName,
        accountNumber: parsedParams.accountNumber,
        accountHolderName: parsedParams.accountHolderName,
        isActive: true,
        createdById: userId,
        updatedById: userId
      }
    });

    res.status(201).json({ account });
  } catch (error: any) {
    res.status(400).json({ error: 'Validation failed', details: error.errors || error.message });
  }
};

export const toggleAccountStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accountId = req.params.id as string;
    const { isActive } = req.body;
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) {
      res.status(401).json({ error: 'Missing context.' });
      return;
    }

    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive must be a boolean.' });
      return;
    }

    const account = await prisma.bankSettlementAccount.findUnique({
        where: { id: accountId }
    });

    if (!account || account.organizationId !== organizationId) {
        res.status(404).json({ error: 'Account not found or access denied.' });
        return;
    }

    const updated = await prisma.bankSettlementAccount.update({
        where: { id: accountId },
        data: {
            isActive,
            updatedById: userId
        }
    });

    res.status(200).json({ account: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update account status', details: error.message });
  }
};
