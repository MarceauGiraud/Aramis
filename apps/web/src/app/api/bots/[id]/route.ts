import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { BOT_COMMANDS_CHANNEL, BOT_COMMAND_TYPES } from '@aramis/shared';
import { apiError, validateBody, parseJsonBody, getCurrentUserId } from '@/lib/api-helpers';
import { sanitizeString } from '@/lib/sanitize';

const updateBotSchema = z.object({
  bot_name: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
  recording_mode: z.enum(['speaker', 'gallery']).optional(),
});

async function getMeeting(id: string) {
  return prisma.meeting.findUnique({
    where: { id },
    include: {
      recording: true,
      botSession: true,
      _count: { select: { participants: true } },
    },
  });
}

// GET /api/bots/:id - get bot status
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const meeting = await getMeeting(params.id);
    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }
    return NextResponse.json(meeting);
  } catch (error) {
    console.error('Error fetching bot:', error);
    return apiError('INTERNAL_ERROR', 'Failed to fetch bot', 500);
  }
}

// PATCH /api/bots/:id - update a bot
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const meeting = await getMeeting(params.id);
    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    const bodyResult = await parseJsonBody(request);
    if ('error' in bodyResult) return bodyResult.error;

    const validation = await validateBody(updateBotSchema, bodyResult.data);
    if ('error' in validation) return validation.error;

    const { bot_name, metadata, recording_mode } = validation.data;

    const updateData: Record<string, unknown> = {};
    if (bot_name) {
      updateData.botName = sanitizeString(bot_name, 100);
    }

    const updated = await prisma.meeting.update({
      where: { id: params.id },
      data: updateData,
    });

    // If bot is running, publish update via Redis pub/sub
    if (meeting.botSession && (meeting.botSession.status === 'RUNNING' || meeting.botSession.status === 'STARTING')) {
      const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
      try {
        await redis.publish(
          `${BOT_COMMANDS_CHANNEL}:${params.id}`,
          JSON.stringify({
            type: BOT_COMMAND_TYPES.UPDATE_CONFIG,
            meetingId: params.id,
            data: { bot_name, metadata, recording_mode },
          }),
        );
      } finally {
        await redis.quit();
      }
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Error updating bot:', error);
    return apiError('INTERNAL_ERROR', 'Failed to update bot', 500);
  }
}

// DELETE /api/bots/:id - stop bot and clean up
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const meeting = await getMeeting(params.id);
    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    // If bot is running, send leave command
    if (meeting.botSession && (meeting.botSession.status === 'RUNNING' || meeting.botSession.status === 'STARTING')) {
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

    // Update statuses
    await prisma.meeting.update({
      where: { id: params.id },
      data: { status: 'CANCELLED' },
    });

    if (meeting.botSession) {
      await prisma.botSession.update({
        where: { id: meeting.botSession.id },
        data: { status: 'STOPPED' },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting bot:', error);
    return apiError('INTERNAL_ERROR', 'Failed to stop bot', 500);
  }
}
