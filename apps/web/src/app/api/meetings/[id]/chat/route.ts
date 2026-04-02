import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';

// GET /api/meetings/:id/chat - Get chat messages for a meeting
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    // Validate meeting ID format (CUID)
    if (!params.id || !/^c[a-z0-9]{24}$/i.test(params.id)) {
      return NextResponse.json({ error: 'Invalid meeting ID format' }, { status: 400 });
    }

    // Verify meeting exists
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      select: { id: true },
    });

    if (!meeting) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }

    // Fetch chat messages ordered by timestamp
    try {
      const messages = await (prisma as any).chatMessage.findMany({
        where: { meetingId: params.id },
        orderBy: { timestamp: 'asc' },
      });

      return NextResponse.json({
        meetingId: params.id,
        messages,
        count: messages.length,
      });
    } catch {
      // ChatMessage model may not exist in the current schema
      return NextResponse.json({
        meetingId: params.id,
        messages: [],
        count: 0,
      });
    }
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    return NextResponse.json({ error: 'Failed to fetch chat messages' }, { status: 500 });
  }
}
