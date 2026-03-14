/**
 * Webhooks API
 *
 * GET  /api/webhooks - List webhooks for the current user
 * POST /api/webhooks - Create a new webhook configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';
import { WEBHOOK_EVENT_TYPES } from '@aramis/shared';
import * as crypto from 'crypto';

// TODO: Replace with actual auth when implemented
async function getCurrentUserId(_request: NextRequest): Promise<string | null> {
  return 'demo-user';
}

// Valid event types
const VALID_EVENTS = new Set(Object.values(WEBHOOK_EVENT_TYPES));

// GET /api/webhooks - List webhooks
export async function GET(request: NextRequest) {
  try {
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Query webhooks using raw query since Webhook model may not be in Prisma yet
    try {
      const webhooks = await (prisma as any).webhook.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });

      // Mask secrets
      const sanitized = webhooks.map((wh: any) => ({
        id: wh.id,
        url: wh.url,
        events: wh.events,
        isActive: wh.isActive,
        secretMask: wh.secret ? `${wh.secret.substring(0, 4)}...${wh.secret.substring(wh.secret.length - 4)}` : null,
        createdAt: wh.createdAt,
      }));

      return NextResponse.json({ data: sanitized });
    } catch {
      // Webhook model may not exist yet
      return NextResponse.json({ data: [] });
    }
  } catch (error) {
    console.error('Error fetching webhooks:', error);
    return NextResponse.json(
      { error: 'Failed to fetch webhooks' },
      { status: 500 }
    );
  }
}

// POST /api/webhooks - Create webhook
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

    const { url, secret, events } = body;

    // Validate URL
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }

    // Validate events
    if (!events || !Array.isArray(events) || events.length === 0) {
      return NextResponse.json(
        { error: 'events must be a non-empty array of event types' },
        { status: 400 }
      );
    }

    for (const event of events) {
      if (event !== '*' && !VALID_EVENTS.has(event)) {
        return NextResponse.json(
          { error: `Invalid event type: ${event}. Valid types: ${Array.from(VALID_EVENTS).join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Generate secret if not provided
    const webhookSecret = secret || crypto.randomBytes(32).toString('hex');

    try {
      const webhook = await (prisma as any).webhook.create({
        data: {
          userId,
          url,
          secret: webhookSecret,
          events,
          isActive: true,
        },
      });

      return NextResponse.json({
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        secret: webhookSecret, // Only returned on creation
        isActive: webhook.isActive,
        createdAt: webhook.createdAt,
      }, { status: 201 });
    } catch {
      return NextResponse.json(
        { error: 'Webhook model is not available. Please ensure database schema is up to date.' },
        { status: 503 }
      );
    }
  } catch (error) {
    console.error('Error creating webhook:', error);
    return NextResponse.json(
      { error: 'Failed to create webhook' },
      { status: 500 }
    );
  }
}
