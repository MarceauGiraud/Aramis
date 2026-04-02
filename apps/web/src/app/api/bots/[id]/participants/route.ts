import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';
import { apiError } from '@/lib/api-helpers';

// GET /api/bots/:id/participants - list participants
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      select: { id: true },
    });

    if (!meeting) {
      return apiError('NOT_FOUND', 'Bot not found', 404);
    }

    const searchParams = request.nextUrl.searchParams;
    const isHostFilter = searchParams.get('isHost');

    const where: Record<string, unknown> = { meetingId: params.id };
    if (isHostFilter === 'true') {
      where.isHost = true;
    } else if (isHostFilter === 'false') {
      where.isHost = false;
    }

    const participants = await prisma.participant.findMany({
      where,
      orderBy: { joinedAt: 'asc' },
    });

    // Compute speaking stats from transcript speakers if available
    const transcript = await prisma.transcript.findUnique({
      where: { meetingId: params.id },
      include: {
        speakers: true,
      },
    });

    const speakerMap = new Map<string, { totalDuration: number | null; segmentCount: number }>();
    if (transcript?.speakers) {
      for (const speaker of transcript.speakers) {
        if (speaker.identifiedName) {
          speakerMap.set(speaker.identifiedName, {
            totalDuration: speaker.totalDuration,
            segmentCount: speaker.segmentCount,
          });
        }
      }
    }

    const result = participants.map((p) => ({
      ...p,
      speakingStats: speakerMap.get(p.name) || null,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching participants:', error);
    return apiError('INTERNAL_ERROR', 'Failed to fetch participants', 500);
  }
}
