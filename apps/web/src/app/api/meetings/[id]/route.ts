import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';

// GET /api/meetings/:id - Get a single meeting
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
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
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
    });

    if (!meeting) {
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
    const body = await request.json();
    const { status, title, recordingEnabled } = body;

    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      include: { botSession: true },
    });

    if (!meeting) {
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
