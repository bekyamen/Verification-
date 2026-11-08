/**
 * auth.ts — Telegram user lookup & permissions
 *
 * Resolves registered users directly from the database by their Telegram ID.
 * Multi-tenant: Each user operates under their own organization and branch.
 */

import prisma from '../utils/prisma';

export interface TelegramUserContext {
  userId: string;
  fullName: string;
  phone: string;
  role: string;
  isAdmin: boolean;
  organizationId: string;
  organizationName: string;
  branchId: string;
  branchName: string;
  telegramId: bigint;
}

/**
 * Find registered user by their Telegram ID.
 * Returns their business, branch, and role context.
 */
export async function getRegisteredUser(fromId: number | bigint | undefined): Promise<TelegramUserContext | null> {
  if (!fromId) return null;
  try {
    const user = await prisma.user.findFirst({
      where: { telegramId: BigInt(fromId) },
      include: {
        organization: {
          include: {
            branches: { orderBy: { createdAt: 'asc' }, take: 1 },
          },
        },
        branch: true,
      },
    });

    if (!user) return null;

    let branchId = user.branchId;
    let branchName = user.branch?.name ?? '';

    // If user's branchId was not set, fallback to organization's first branch
    if (!branchId && user.organization?.branches?.[0]) {
      branchId = user.organization.branches[0].id;
      branchName = user.organization.branches[0].name;
      await prisma.user.update({
        where: { id: user.id },
        data: { branchId },
      }).catch(() => {});
    }

    if (!branchId) return null;

    const isAdmin = user.role === 'OWNER' || user.role === 'MANAGER';

    return {
      userId: user.id,
      fullName: user.fullName,
      phone: user.phone,
      role: user.role,
      isAdmin,
      organizationId: user.organizationId,
      organizationName: user.organization.name,
      branchId,
      branchName: branchName || 'Main Branch',
      telegramId: user.telegramId!,
    };
  } catch {
    return null;
  }
}
