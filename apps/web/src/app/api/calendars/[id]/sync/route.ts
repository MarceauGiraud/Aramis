/**
 * Calendar Sync API
 *
 * POST /api/calendars/:id/sync - Trigger a manual sync for a calendar connection
 */

import { NextRequest, NextResponse } from 'next/server';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES } from '@aramis/shared';

// TODO: Replace with actual auth when implemented
async function getCurrentUserId(_request: NextRequest): Promise<string | null> {
  return 'demo-user';
}

// POST /api/calendars/:id/sync - Trigger manual sync
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const connection = await prisma.calendarConnection.findUnique({
      where: { id: params.id },
      select: { userId: true, isActive: true },
    });

    if (!connection || connection.userId !== userId) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    if (!connection.isActive) {
      return NextResponse.json({ error: 'Connection is not active' }, { status: 400 });
    }

    // Queue a calendar sync job
    const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });

    try {
      const queue = new Queue(QUEUE_NAMES.CALENDAR_SYNC, { connection: redis });

      await queue.add(
        'manual-sync',
        {
          connectionId: params.id,
        },
        {
          removeOnComplete: 10,
          removeOnFail: 50,
        },
      );

      await queue.close();
    } finally {
      await redis.quit();
    }

    return NextResponse.json({
      success: true,
      message: 'Calendar sync has been queued',
    });
  } catch (error) {
    console.error('Error triggering calendar sync:', error);
    return NextResponse.json({ error: 'Failed to trigger calendar sync' }, { status: 500 });
  }
}
