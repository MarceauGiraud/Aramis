import { NextRequest } from 'next/server';
import { prisma } from '@aramis/database';
import { apiError, parsePagination, paginatedResponse } from '@/lib/api-helpers';

// GET /api/bots/:id/events - paginated BotLog entries
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      include: { botSession: { select: { id: true } } },
    });

    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    if (!meeting.botSession) {
      return apiError('NOT_FOUND', 'No bot session found', 404);
    }

    const searchParams = request.nextUrl.searchParams;
    const { page, limit, skip } = parsePagination(searchParams);

    const level = searchParams.get('level');

    const where: Record<string, unknown> = {
      botSessionId: meeting.botSession.id,
    };

    if (level) {
      where.level = level.toUpperCase();
    }

    const [logs, total] = await Promise.all([
      prisma.botLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.botLog.count({ where }),
    ]);

    return paginatedResponse(logs, total, page, limit);
  } catch (error) {
    console.error('Error fetching bot events:', error);
    return apiError('INTERNAL_ERROR', 'Failed to fetch bot events', 500);
  }
}
