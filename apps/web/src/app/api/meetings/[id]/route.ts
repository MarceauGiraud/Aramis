import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';

// TODO: Replace with actual auth when implemented
async function getCurrentUserId(_request: NextRequest): Promise<string | null> {
  // Placeholder: will be replaced with session/token auth
  return 'demo-user';
}

// Verify user owns the meeting
async function verifyMeetingOwnership(meetingId: string, userId: string): Promise<boolean> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { userId: true },
  });
  return meeting?.userId === userId;
}

// GET /api/meetings/:id - Get a single meeting
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Validate meeting ID format (CUID)
    if (!params.id || !/^c[a-z0-9]{24}$/i.test(params.id)) {
      return NextResponse.json(
        { error: 'Invalid meeting ID format' },
        { status: 400 }
      );
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      include: {
        recording: true,
        transcript: {
          include: {
            segments: {
              orderBy: { startTime: 'asc' },
            },
          },
        },
        botSession: {
          include: {
            logs: {
              orderBy: { createdAt: 'desc' },
              take: 50,
            },
          },
        },
        participants: true,
      },
    });

    if (!meeting) {
      return NextResponse.json(
        { error: 'Meeting not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(meeting);
  } catch (error) {
    console.error('Error fetching meeting:', error);
    return NextResponse.json(
      { error: 'Failed to fetch meeting' },
      { status: 500 }
    );
  }
}

// DELETE /api/meetings/:id - Delete a meeting
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Validate meeting ID format
    if (!params.id || !/^c[a-z0-9]{24}$/i.test(params.id)) {
      return NextResponse.json(
        { error: 'Invalid meeting ID format' },
        { status: 400 }
      );
    }

    // Get current user
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Verify ownership
    const isOwner = await verifyMeetingOwnership(params.id, userId);
    if (!isOwner) {
      return NextResponse.json(
        { error: 'Meeting not found' },
        { status: 404 }
      );
    }

    // Delete the meeting (cascades to related records)
    await prisma.meeting.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return NextResponse.json(
      { error: 'Failed to delete meeting' },
      { status: 500 }
    );
  }
}

// PATCH /api/meetings/:id - Update a meeting (e.g., cancel, toggle recording)
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Validate meeting ID format
    if (!params.id || !/^c[a-z0-9]{24}$/i.test(params.id)) {
      return NextResponse.json(
        { error: 'Invalid meeting ID format' },
        { status: 400 }
      );
    }

    // Get current user
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Parse and validate body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    const { status, title, recordingEnabled } = body;

    // Validate title if provided
    if (title !== undefined && (typeof title !== 'string' || title.length > 255)) {
      return NextResponse.json(
        { error: 'Title must be a string with max 255 characters' },
        { status: 400 }
      );
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      include: { botSession: true },
    });

    if (!meeting || meeting.userId !== userId) {
      return NextResponse.json(
        { error: 'Meeting not found' },
        { status: 404 }
      );
    }

    // Handle recording toggle
    if (recordingEnabled !== undefined) {
      if (recordingEnabled) {
        // Enable recording - set status back to SCHEDULED
        const updated = await prisma.meeting.update({
          where: { id: params.id },
          data: { status: 'SCHEDULED' },
        });

        // Create or update bot session
        await prisma.botSession.upsert({
          where: { meetingId: params.id },
          create: {
            meetingId: params.id,
            status: 'IDLE',
          },
          update: {
            status: 'IDLE',
          },
        });

        return NextResponse.json({ ...updated, recordingEnabled: true });
      } else {
        // Disable recording - cancel the bot
        const updated = await prisma.meeting.update({
          where: { id: params.id },
          data: { status: 'CANCELLED' },
        });

        // Update bot session if exists
        if (meeting.botSession) {
          await prisma.botSession.update({
            where: { meetingId: params.id },
            data: { status: 'STOPPED' },
          });
        }

        return NextResponse.json({ ...updated, recordingEnabled: false });
      }
    }

    // Handle other updates
    const updated = await prisma.meeting.update({
      where: { id: params.id },
      data: {
        ...(status && { status }),
        ...(title && { title }),
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Error updating meeting:', error);
    return NextResponse.json(
      { error: 'Failed to update meeting' },
      { status: 500 }
    );
  }
}
