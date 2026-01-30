import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@aramis/database';
import { detectPlatform, isValidMeetingUrl } from '@aramis/shared';
import { addMeetingBotJob } from '@/lib/queue';

// Validation schema
const createMeetingSchema = z.object({
  title: z.string().min(1).max(255),
  meetingUrl: z.string().url(),
  scheduledAt: z.string().datetime().optional(),
});

// GET /api/meetings - List all meetings
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const filter = searchParams.get('filter') || 'all'; // 'upcoming', 'past', 'all'
    const skip = (page - 1) * limit;

    // Build where clause based on filter
    const now = new Date();
    const whereClause: Record<string, unknown> = {};

    if (filter === 'upcoming') {
      whereClause.scheduledStart = { gte: now };
      whereClause.status = { in: ['SCHEDULED', 'JOINING', 'WAITING', 'RECORDING'] };
    } else if (filter === 'past') {
      whereClause.OR = [
        { scheduledStart: { lt: now } },
        { status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
      ];
    }

    const [meetings, total] = await Promise.all([
      prisma.meeting.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: filter === 'upcoming'
          ? { scheduledStart: 'asc' }
          : { scheduledStart: 'desc' },
        include: {
          recording: true,
          transcript: true,
          summary: true,
          calendarEvent: {
            include: {
              calendar: {
                select: {
                  name: true,
                  color: true,
                },
              },
            },
          },
        },
      }),
      prisma.meeting.count({ where: whereClause }),
    ]);

    // Add recordingEnabled field based on status
    const meetingsWithRecordingFlag = meetings.map(m => ({
      ...m,
      recordingEnabled: m.status !== 'CANCELLED' && m.status !== 'FAILED',
    }));

    return NextResponse.json({
      meetings: meetingsWithRecordingFlag,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching meetings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch meetings' },
      { status: 500 }
    );
  }
}

// POST /api/meetings - Create a new meeting and start recording
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validation = createMeetingSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: validation.error.errors },
        { status: 400 }
      );
    }

    const { title, meetingUrl, scheduledAt } = validation.data;

    // Validate meeting URL and detect platform
    if (!isValidMeetingUrl(meetingUrl)) {
      return NextResponse.json(
        { error: 'Invalid meeting URL. Supported: Zoom, Teams, Google Meet' },
        { status: 400 }
      );
    }

    const platform = detectPlatform(meetingUrl);
    if (!platform) {
      return NextResponse.json(
        { error: 'Could not detect meeting platform' },
        { status: 400 }
      );
    }

    // Create meeting record
    // TODO: Get userId from session when auth is implemented
    const meeting = await prisma.meeting.create({
      data: {
        title,
        meetingUrl,
        platform,
        scheduledStart: scheduledAt ? new Date(scheduledAt) : new Date(),
        status: scheduledAt ? 'SCHEDULED' : 'JOINING',
        userId: 'demo-user', // Placeholder until auth is implemented
      },
    });

    // Create bot session
    await prisma.botSession.create({
      data: {
        meetingId: meeting.id,
        status: 'STARTING',
      },
    });

    // If no scheduled time, start the bot immediately
    if (!scheduledAt) {
      await addMeetingBotJob({
        meetingId: meeting.id,
        meetingUrl,
        platform,
      });
    }

    return NextResponse.json(meeting, { status: 201 });
  } catch (error) {
    console.error('Error creating meeting:', error);
    return NextResponse.json(
      { error: 'Failed to create meeting' },
      { status: 500 }
    );
  }
}
