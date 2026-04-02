import { NextRequest, NextResponse } from 'next/server';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { BOT_COMMANDS_CHANNEL, BOT_COMMAND_TYPES } from '@aramis/shared';
import { apiError } from '@/lib/api-helpers';

// POST /api/bots/:id/leave - force the bot to leave
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      include: { botSession: true },
    });

    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    if (!meeting.botSession || (meeting.botSession.status !== 'RUNNING' && meeting.botSession.status !== 'STARTING')) {
      return apiError('BAD_REQUEST', 'Bot is not currently active', 400);
    }

    const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
    try {
      await redis.publish(
        `${BOT_COMMANDS_CHANNEL}:${params.id}`,
        JSON.stringify({
          type: BOT_COMMAND_TYPES.LEAVE,
          meetingId: params.id,
        }),
      );
    } finally {
      await redis.quit();
    }

    return NextResponse.json({ success: true, message: 'Leave command sent' });
  } catch (error) {
    console.error('Error sending leave command:', error);
    return apiError('INTERNAL_ERROR', 'Failed to send leave command', 500);
  }
}
