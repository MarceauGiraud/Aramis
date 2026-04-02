/**
 * Calendar Connection Detail API
 *
 * GET    /api/calendars/:id - Get connection details with calendars
 * DELETE /api/calendars/:id - Disconnect a calendar connection
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';

// TODO: Replace with actual auth when implemented
async function getCurrentUserId(_request: NextRequest): Promise<string | null> {
  return 'demo-user';
}

// GET /api/calendars/:id - Get connection details
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const connection = await prisma.calendarConnection.findUnique({
      where: { id: params.id },
      include: {
        calendars: {
          include: {
            _count: {
              select: { events: true },
            },
          },
          orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        },
      },
    });

    if (!connection || connection.userId !== userId) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    // Strip sensitive data
    return NextResponse.json({
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      isActive: connection.isActive,
      lastSyncAt: connection.lastSyncAt,
      syncError: connection.syncError,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      calendars: connection.calendars.map((cal) => ({
        id: cal.id,
        name: cal.name,
        color: cal.color,
        isPrimary: cal.isPrimary,
        isEnabled: cal.isEnabled,
        autoRecord: cal.autoRecord,
        eventCount: cal._count.events,
      })),
    });
  } catch (error) {
    console.error('Error fetching calendar connection:', error);
    return NextResponse.json({ error: 'Failed to fetch calendar connection' }, { status: 500 });
  }
}

// DELETE /api/calendars/:id - Disconnect
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const connection = await prisma.calendarConnection.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });

    if (!connection || connection.userId !== userId) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    // Delete the connection (cascades to calendars and events)
    await prisma.calendarConnection.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting calendar connection:', error);
    return NextResponse.json({ error: 'Failed to delete calendar connection' }, { status: 500 });
  }
}
