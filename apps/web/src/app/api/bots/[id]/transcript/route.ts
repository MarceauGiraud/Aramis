import { NextRequest } from 'next/server';
import { prisma } from '@aramis/database';
import { apiError, parsePagination, paginatedResponse } from '@/lib/api-helpers';

// GET /api/bots/:id/transcript - paginated transcript segments
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

    const transcript = await prisma.transcript.findUnique({
      where: { meetingId: params.id },
      select: { id: true, status: true, fullText: true, wordCount: true, language: true },
    });

    if (!transcript) {
      return apiError('NOT_FOUND', 'Transcript not found', 404);
    }

    const searchParams = request.nextUrl.searchParams;
    const { page, limit, skip } = parsePagination(searchParams);

    const [segments, total] = await Promise.all([
      prisma.transcriptSegment.findMany({
        where: { transcriptId: transcript.id },
        include: {
          speaker: {
            select: {
              id: true,
              label: true,
              identifiedName: true,
            },
          },
        },
        orderBy: { order: 'asc' },
        skip,
        take: limit,
      }),
      prisma.transcriptSegment.count({
        where: { transcriptId: transcript.id },
      }),
    ]);

    return paginatedResponse(
      segments.map((seg) => ({
        id: seg.id,
        text: seg.text,
        startTime: seg.startTime,
        endTime: seg.endTime,
        confidence: seg.confidence,
        order: seg.order,
        speaker: seg.speaker
          ? {
              id: seg.speaker.id,
              label: seg.speaker.label,
              identifiedName: seg.speaker.identifiedName,
            }
          : null,
      })),
      total,
      page,
      limit
    );
  } catch (error) {
    console.error('Error fetching transcript:', error);
    return apiError('INTERNAL_ERROR', 'Failed to fetch transcript', 500);
  }
}
