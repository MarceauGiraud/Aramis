import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { BOT_COMMANDS_CHANNEL, BOT_COMMAND_TYPES } from '@aramis/shared';
import { apiError, validateBody, parseJsonBody } from '@/lib/api-helpers';
import { sanitizeString } from '@/lib/sanitize';

const sendChatSchema = z.object({
  message: z.string().min(1).max(5000),
});

// POST /api/bots/:id/send-chat-message - send chat message in meeting
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      include: { botSession: true },
    });

    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    if (
      !meeting.botSession ||
      meeting.botSession.status !== 'RUNNING'
    ) {
      return apiError('BAD_REQUEST', 'Bot is not currently active', 400);
    }

    const bodyResult = await parseJsonBody(request);
    if ('error' in bodyResult) return bodyResult.error;

    const validation = await validateBody(sendChatSchema, bodyResult.data);
    if ('error' in validation) return validation.error;

    const message = sanitizeString(validation.data.message, 5000);

    const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
    try {
      await redis.publish(
        `${BOT_COMMANDS_CHANNEL}:${params.id}`,
        JSON.stringify({
          type: BOT_COMMAND_TYPES.SEND_CHAT,
          meetingId: params.id,
          data: { message },
        })
      );
    } finally {
      await redis.quit();
    }

    return NextResponse.json({ success: true, message: 'Chat message sent' });
  } catch (error) {
    console.error('Error sending chat message:', error);
    return apiError('INTERNAL_ERROR', 'Failed to send chat message', 500);
  }
}
