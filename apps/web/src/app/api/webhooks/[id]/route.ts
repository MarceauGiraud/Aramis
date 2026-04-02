/**
 * Webhook Detail API
 *
 * GET    /api/webhooks/:id - Get webhook details with recent deliveries
 * DELETE /api/webhooks/:id - Remove webhook
 * PATCH  /api/webhooks/:id - Update webhook (url, events, isActive)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@aramis/database';
import { WEBHOOK_EVENT_TYPES } from '@aramis/shared';

// TODO: Replace with actual auth when implemented
async function getCurrentUserId(_request: NextRequest): Promise<string | null> {
  return 'demo-user';
}

const VALID_EVENTS = new Set(Object.values(WEBHOOK_EVENT_TYPES));

// GET /api/webhooks/:id - Get webhook details
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      const webhook = await (prisma as any).webhook.findUnique({
        where: { id: params.id },
        include: {
          deliveries: {
            orderBy: { createdAt: 'desc' },
            take: 20,
          },
        },
      });

      if (!webhook || webhook.userId !== userId) {
        return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
      }

      return NextResponse.json({
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        isActive: webhook.isActive,
        secretMask: webhook.secret
          ? `${webhook.secret.substring(0, 4)}...${webhook.secret.substring(webhook.secret.length - 4)}`
          : null,
        createdAt: webhook.createdAt,
        recentDeliveries: (webhook.deliveries || []).map((d: any) => ({
          id: d.id,
          event: d.event,
          statusCode: d.statusCode,
          attempt: d.attempt,
          deliveredAt: d.deliveredAt,
          error: d.error,
          createdAt: d.createdAt,
        })),
      });
    } catch {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }
  } catch (error) {
    console.error('Error fetching webhook:', error);
    return NextResponse.json({ error: 'Failed to fetch webhook' }, { status: 500 });
  }
}

// DELETE /api/webhooks/:id - Remove webhook
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await getCurrentUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      const webhook = await (prisma as any).webhook.findUnique({
        where: { id: params.id },
        select: { userId: true },
      });

      if (!webhook || webhook.userId !== userId) {
        return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
      }

      await (prisma as any).webhook.delete({
        where: { id: params.id },
      });

      return NextResponse.json({ success: true });
    } catch {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }
  } catch (error) {
    console.error('Error deleting webhook:', error);
    return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 });
  }
}

// PATCH /api/webhooks/:id - Update webhook
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
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

    const { url, events, isActive } = body;

    // Validate URL if provided
    if (url !== undefined) {
      if (typeof url !== 'string' || url.length === 0) {
        return NextResponse.json({ error: 'url must be a non-empty string' }, { status: 400 });
      }
      try {
        new URL(url);
      } catch {
        return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
      }
    }

    // Validate events if provided
    if (events !== undefined) {
      if (!Array.isArray(events) || events.length === 0) {
        return NextResponse.json({ error: 'events must be a non-empty array' }, { status: 400 });
      }
      for (const event of events) {
        if (event !== '*' && !VALID_EVENTS.has(event)) {
          return NextResponse.json({ error: `Invalid event type: ${event}` }, { status: 400 });
        }
      }
    }

    try {
      const webhook = await (prisma as any).webhook.findUnique({
        where: { id: params.id },
        select: { userId: true },
      });

      if (!webhook || webhook.userId !== userId) {
        return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
      }

      const updated = await (prisma as any).webhook.update({
        where: { id: params.id },
        data: {
          ...(url !== undefined && { url }),
          ...(events !== undefined && { events }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      return NextResponse.json({
        id: updated.id,
        url: updated.url,
        events: updated.events,
        isActive: updated.isActive,
        createdAt: updated.createdAt,
      });
    } catch {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }
  } catch (error) {
    console.error('Error updating webhook:', error);
    return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 });
  }
}
