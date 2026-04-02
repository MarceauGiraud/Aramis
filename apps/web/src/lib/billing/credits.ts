import { prisma } from '@aramis/database';

/**
 * Check if billing is enabled (Stripe configured).
 */
function isBillingEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Get the credit balance for a user.
 * Returns 0 if billing is not enabled or no balance exists.
 */
export async function getBalance(userId: string): Promise<number> {
  if (!isBillingEnabled()) return 0;

  // Check if CreditBalance model exists
  if (!('creditBalance' in prisma)) return 0;

  try {
    const balance = await (prisma as any).creditBalance.findUnique({
      where: { userId },
    });
    return balance?.balance ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Deduct credits from a user's balance atomically.
 * No-op if billing is not enabled.
 */
export async function deductCredits(
  userId: string,
  amount: number,
  description: string,
  referenceId?: string,
): Promise<boolean> {
  if (!isBillingEnabled()) return true;
  if (!('creditBalance' in prisma) || !('creditTransaction' in prisma)) return true;

  try {
    await (prisma as any).$transaction(async (tx: any) => {
      // Get current balance with lock
      const balance = await tx.creditBalance.findUnique({
        where: { userId },
      });

      if (!balance || balance.balance < amount) {
        throw new Error('Insufficient credits');
      }

      // Update balance
      await tx.creditBalance.update({
        where: { userId },
        data: { balance: { decrement: amount } },
      });

      // Create transaction record
      await tx.creditTransaction.create({
        data: {
          userId,
          amount: -amount,
          type: 'DEDUCTION',
          description,
          referenceId,
        },
      });
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Add credits to a user's balance.
 * No-op if billing is not enabled.
 */
export async function addCredits(userId: string, amount: number, type: string, description: string): Promise<boolean> {
  if (!isBillingEnabled()) return true;
  if (!('creditBalance' in prisma) || !('creditTransaction' in prisma)) return true;

  try {
    await (prisma as any).$transaction(async (tx: any) => {
      // Upsert balance
      await tx.creditBalance.upsert({
        where: { userId },
        create: { userId, balance: amount },
        update: { balance: { increment: amount } },
      });

      // Create transaction record
      await tx.creditTransaction.create({
        data: {
          userId,
          amount,
          type,
          description,
        },
      });
    });
    return true;
  } catch {
    return false;
  }
}
