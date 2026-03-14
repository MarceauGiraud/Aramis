import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';
import { apiError, parsePagination, paginatedResponse } from '@/lib/api-helpers';

// GET /api/bots/:id/chat - paginated chat messages
// Note: Requires ChatMessage model (added by Agent 1). Falls back gracefully.
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      select: { id: true },
    });

    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    const searchParams = request.nextUrl.searchParams;
    const { page, limit, skip } = parsePagination(searchParams);

    // Check if ChatMessage model exists on prisma client
    if (!('chatMessage' in prisma)) {
      // ChatMessage model not yet available - return empty list
      return paginatedResponse([], 0, page, limit);
    }

    const chatModel = (prisma as any).chatMessage;

    const [messages, total] = await Promise.all([
      chatModel.findMany({
        where: { meetingId: params.id },
        orderBy: { timestamp: 'asc' },
        skip,
        take: limit,
      }),
      chatModel.count({
        where: { meetingId: params.id },
      }),
    ]);

    return paginatedResponse(messages, total, page, limit);
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    return apiError('INTERNAL_ERROR', 'Failed to fetch chat messages', 500);
  }
}
