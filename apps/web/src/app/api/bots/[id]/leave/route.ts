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

    const activeStatuses = ['RUNNING', 'STARTING'];
    const activeMeetingStatuses = ['JOINING', 'WAITING', 'RECORDING', 'PROCESSING'];

    // Try to send leave command via Redis if bot session is active
    if (meeting.botSession && activeStatuses.includes(meeting.botSession.status)) {
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
    }

    // Force-update meeting status to CANCELLED if it's stuck in an active state.
    // This ensures the UI reflects the kill even if the bot worker doesn't
    // receive the command (crash, network issue, already dead).
    if (activeMeetingStatuses.includes(meeting.status)) {
      await prisma.meeting.update({
        where: { id: params.id },
        data: {
          status: 'CANCELLED',
          errorMessage: 'Meeting forcefully stopped by user',
        },
      });
    }

    // Also update bot session status if stuck
    if (meeting.botSession && activeStatuses.includes(meeting.botSession.status)) {
      await prisma.botSession.update({
        where: { id: meeting.botSession.id },
        data: { status: 'STOPPED' },
      });
    }

    return NextResponse.json({ success: true, message: 'Bot killed and meeting cancelled' });
  } catch (error) {
    console.error('Error killing bot:', error);
    return apiError('INTERNAL_ERROR', 'Failed to kill bot', 500);
  }
}
