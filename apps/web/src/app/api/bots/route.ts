import { NextRequest } from 'next/server';
import { z } from 'zod';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES, detectPlatform } from '@aramis/shared';
import {
  apiError,
  parsePagination,
  paginatedResponse,
  validateBody,
  parseJsonBody,
  getCurrentUserId,
} from '@/lib/api-helpers';
import { sanitizeString } from '@/lib/sanitize';

const createBotSchema = z.object({
  meeting_url: z.string().url(),
  bot_name: z.string().max(100).optional(),
  recording_mode: z.enum(['speaker', 'gallery']).optional(),
  transcription: z
    .object({
      provider: z.string().optional(),
      language: z.string().optional(),
    })
    .optional(),
  webhooks: z
    .array(
      z.object({
        url: z.string().url(),
        secret: z.string().optional(),
        events: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

// GET /api/bots - list all bots/meetings with filters
export async function GET(request: NextRequest) {
  try {
    const userId = getCurrentUserId();
    const searchParams = request.nextUrl.searchParams;
    const { page, limit, skip } = parsePagination(searchParams);

    // Build filters
    const where: Record<string, unknown> = { userId };

    const status = searchParams.get('status');
    if (status) {
      where.status = status;
    }

    const platform = searchParams.get('platform');
    if (platform) {
      where.platform = platform;
    }

    const dateFrom = searchParams.get('date_from');
    const dateTo = searchParams.get('date_to');
    if (dateFrom || dateTo) {
      where.scheduledStart = {};
      if (dateFrom) {
        (where.scheduledStart as Record<string, unknown>).gte = new Date(dateFrom);
      }
      if (dateTo) {
        (where.scheduledStart as Record<string, unknown>).lte = new Date(dateTo);
      }
    }

    const [meetings, total] = await Promise.all([
      prisma.meeting.findMany({
        where,
        include: {
          recording: {
            select: { id: true, status: true, duration: true, fileSize: true },
          },
          transcripts: {
            select: { id: true, status: true, wordCount: true },
          },
          summary: {
            select: { id: true, status: true },
          },
          botSession: {
            select: { id: true, status: true, lastPing: true },
          },
          _count: {
            select: { participants: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.meeting.count({ where }),
    ]);

    return paginatedResponse(meetings, total, page, limit);
  } catch (error) {
    console.error('Error listing bots:', error);
    return apiError('INTERNAL_ERROR', 'Failed to list bots', 500);
  }
}

// POST /api/bots - create and deploy a bot
export async function POST(request: NextRequest) {
  try {
    const userId = getCurrentUserId();

    const bodyResult = await parseJsonBody(request);
    if ('error' in bodyResult) return bodyResult.error;

    const validation = await validateBody(createBotSchema, bodyResult.data);
    if ('error' in validation) return validation.error;

    const { meeting_url, bot_name, recording_mode, transcription, metadata } = validation.data;

    // Detect platform
    const platform = detectPlatform(meeting_url);
    if (!platform) {
      return apiError(
        'INVALID_PLATFORM',
        'Could not detect meeting platform from URL. Supported: Zoom, Google Meet, Microsoft Teams.',
        400,
      );
    }

    const sanitizedBotName = bot_name ? sanitizeString(bot_name, 100) : 'Aramis Recorder';

    // Create meeting
    const meeting = await prisma.meeting.create({
      data: {
        userId,
        title: `Meeting - ${new Date().toLocaleDateString()}`,
        meetingUrl: meeting_url,
        platform,
        scheduledStart: new Date(),
        botName: sanitizedBotName,
        status: 'JOINING',
      },
    });

    // Create bot session
    await prisma.botSession.create({
      data: {
        meetingId: meeting.id,
        status: 'STARTING',
      },
    });

    // Queue BullMQ job
    const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });

    try {
      const queue = new Queue(QUEUE_NAMES.MEETING_BOT, { connection: redis });
      await queue.add(
        'join_meeting',
        {
          meetingId: meeting.id,
          meetingUrl: meeting_url,
          platform,
          botName: sanitizedBotName,
          recordingMode: recording_mode,
          transcriptionConfig: transcription
            ? {
                provider: transcription.provider,
                language: transcription.language,
              }
            : undefined,
          metadata,
        },
        {
          attempts: 2,
          backoff: { type: 'exponential', delay: 30000 },
        },
      );
      await queue.close();
    } finally {
      await redis.quit();
    }

    const result = await prisma.meeting.findUnique({
      where: { id: meeting.id },
      include: {
        botSession: true,
      },
    });

    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error creating bot:', error);
    return apiError('INTERNAL_ERROR', 'Failed to create bot', 500);
  }
}
