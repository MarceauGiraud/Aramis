/**
 * Calendar Connections API
 *
 * GET  /api/calendars - List calendar connections for the current user
 * POST /api/calendars - Initiate OAuth flow (returns redirect URL)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';

// TODO: Replace with actual auth when implemented
async function getCurrentUserId(_request: NextRequest): Promise<string | null> {
  return 'demo-user';
}

// GET /api/calendars - List calendar connections
export async function GET(request: NextRequest) {
  try {
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const connections = await prisma.calendarConnection.findMany({
      where: { userId },
      include: {
        calendars: {
          select: {
            id: true,
            name: true,
            color: true,
            isPrimary: true,
            isEnabled: true,
            autoRecord: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Strip sensitive token data
    const sanitized = connections.map(conn => ({
      id: conn.id,
      provider: conn.provider,
      email: conn.email,
      isActive: conn.isActive,
      lastSyncAt: conn.lastSyncAt,
      syncError: conn.syncError,
      createdAt: conn.createdAt,
      calendars: conn.calendars,
    }));

    return NextResponse.json({ data: sanitized });
  } catch (error) {
    console.error('Error fetching calendar connections:', error);
    return NextResponse.json(
      { error: 'Failed to fetch calendar connections' },
      { status: 500 }
    );
  }
}

// POST /api/calendars - Initiate OAuth flow
export async function POST(request: NextRequest) {
  try {
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { provider } = body;

    if (!provider || !['GOOGLE', 'MICROSOFT'].includes(provider)) {
      return NextResponse.json(
        { error: 'Invalid provider. Must be GOOGLE or MICROSOFT.' },
        { status: 400 }
      );
    }

    if (provider === 'GOOGLE') {
      // Build Google OAuth URL
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return NextResponse.json(
          { error: 'Google OAuth is not configured' },
          { status: 503 }
        );
      }

      const redirectUri = `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/calendars/callback/google`;
      const scope = encodeURIComponent(
        'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.readonly openid email profile'
      );
      const state = encodeURIComponent(JSON.stringify({ userId, provider }));

      const authUrl =
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code&scope=${scope}&access_type=offline&prompt=consent` +
        `&state=${state}`;

      return NextResponse.json({ redirectUrl: authUrl });
    }

    // Microsoft OAuth (placeholder)
    return NextResponse.json(
      { error: 'Microsoft OAuth is not yet implemented' },
      { status: 501 }
    );
  } catch (error) {
    console.error('Error initiating OAuth flow:', error);
    return NextResponse.json(
      { error: 'Failed to initiate OAuth flow' },
      { status: 500 }
    );
  }
}
