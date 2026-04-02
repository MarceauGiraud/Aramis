import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { BOT_COMMANDS_CHANNEL, BOT_COMMAND_TYPES } from '@aramis/shared';
import { apiError, validateBody, parseJsonBody } from '@/lib/api-helpers';

const outputAudioSchema = z
  .object({
    audioUrl: z.string().url().optional(),
    text: z.string().max(10000).optional(),
  })
  .refine((data) => data.audioUrl || data.text, {
    message: 'Either audioUrl or text must be provided',
  });

// POST /api/bots/:id/output-audio - play audio in meeting
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      include: { botSession: true },
    });

    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    if (!meeting.botSession || meeting.botSession.status !== 'RUNNING') {
      return apiError('BAD_REQUEST', 'Bot is not currently active', 400);
    }

    const bodyResult = await parseJsonBody(request);
    if ('error' in bodyResult) return bodyResult.error;

    const validation = await validateBody(outputAudioSchema, bodyResult.data);
    if ('error' in validation) return validation.error;

    const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
    try {
      await redis.publish(
        `${BOT_COMMANDS_CHANNEL}:${params.id}`,
        JSON.stringify({
          type: BOT_COMMAND_TYPES.OUTPUT_AUDIO,
          meetingId: params.id,
          data: validation.data,
        }),
      );
    } finally {
      await redis.quit();
    }

    return NextResponse.json({ success: true, message: 'Audio output command sent' });
  } catch (error) {
    console.error('Error sending audio output command:', error);
    return apiError('INTERNAL_ERROR', 'Failed to send audio output command', 500);
  }
}
