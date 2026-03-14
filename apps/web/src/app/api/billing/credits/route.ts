import { NextResponse } from 'next/server';
import { prisma } from '@aramis/database';
import { apiError, getCurrentUserId } from '@/lib/api-helpers';
import { getBalance } from '@/lib/billing/credits';

// GET /api/billing/credits - return balance and recent transactions
export async function GET() {
  try {
    const userId = getCurrentUserId();

    const balance = await getBalance(userId);

    // Fetch recent transactions if model exists
    let transactions: unknown[] = [];
    if ('creditTransaction' in prisma) {
      try {
        transactions = await (prisma as any).creditTransaction.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
      } catch {
        // Model may not exist yet
      }
    }

    return NextResponse.json({
      balance,
      transactions,
    });
  } catch (error) {
    console.error('Error fetching credits:', error);
    return apiError('INTERNAL_ERROR', 'Failed to fetch credits', 500);
  }
}
