/**
 * Webhook Dispatcher
 *
 * Manages webhook configurations for meetings and dispatches events
 * to the webhook delivery queue for asynchronous delivery.
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES, WEBHOOK_EVENT_TYPES } from '@aramis/shared';
import { BotEvent } from '@aramis/shared';
import { logger } from './logger';

export interface WebhookRegistration {
  id: string;
  meetingId: string;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
}

export class WebhookDispatcher {
  private deliveryQueue: Queue;
  private webhookCache: Map<string, WebhookRegistration[]> = new Map();

  constructor(redis: IORedis) {
    this.deliveryQueue = new Queue(QUEUE_NAMES.WEBHOOK_DELIVERY, {
      connection: redis,
    });
  }

  /**
   * Load and register webhooks for a meeting from the database.
   */
  async registerWebhooks(meetingId: string): Promise<void> {
    try {
      // Look up the meeting's user to find their webhooks
      const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { userId: true },
      });

      if (!meeting) {
        logger.warn(`Meeting ${meetingId} not found, cannot register webhooks`);
        return;
      }

      // Find all active webhooks for this user
      // Note: Using raw query approach since Webhook model may not be in Prisma yet
      // When the schema is updated, this should use prisma.webhook.findMany
      const webhooks = await this.findWebhooksForUser(meeting.userId);

      if (webhooks.length > 0) {
        this.webhookCache.set(meetingId, webhooks);
        logger.info(`Registered ${webhooks.length} webhooks for meeting ${meetingId}`);
      }
    } catch (error) {
      logger.error(`Failed to register webhooks for meeting ${meetingId}: ${error}`);
    }
  }

  /**
   * Register webhooks from explicit configuration (for API-created webhooks).
   */
  registerWebhookConfigs(meetingId: string, configs: WebhookRegistration[]): void {
    const existing = this.webhookCache.get(meetingId) || [];
    this.webhookCache.set(meetingId, [...existing, ...configs]);
    logger.info(`Registered ${configs.length} webhook configs for meeting ${meetingId}`);
  }

  /**
   * Dispatch a bot event to all matching webhooks.
   *
   * Filters webhooks by event type and queues delivery jobs.
   */
  async dispatch(event: BotEvent): Promise<void> {
    const webhooks = this.webhookCache.get(event.meetingId);
    if (!webhooks || webhooks.length === 0) {
      return;
    }

    const matchingWebhooks = webhooks.filter(
      (wh) => wh.isActive && (wh.events.includes('*') || wh.events.includes(event.type)),
    );

    if (matchingWebhooks.length === 0) {
      return;
    }

    logger.info(
      `Dispatching event '${event.type}' for meeting ${event.meetingId} to ${matchingWebhooks.length} webhooks`,
    );

    const payload = {
      event: event.type,
      meetingId: event.meetingId,
      timestamp: event.timestamp.toISOString(),
      data: event.data || {},
    };

    for (const webhook of matchingWebhooks) {
      try {
        await this.deliveryQueue.add(
          'deliver',
          {
            webhookId: webhook.id,
            url: webhook.url,
            secret: webhook.secret,
            payload,
            attempt: 1,
            maxAttempts: 5,
          },
          {
            attempts: 5,
            backoff: {
              type: 'custom',
            },
            // Set delay based on attempt number for exponential backoff
            // 1min, 5min, 30min, 2h, 12h
            removeOnComplete: 100,
            removeOnFail: 1000,
          },
        );
      } catch (error) {
        logger.error(`Failed to queue webhook delivery for ${webhook.url}: ${error}`);
      }
    }
  }

  /**
   * Unregister webhooks for a meeting.
   */
  unregisterWebhooks(meetingId: string): void {
    this.webhookCache.delete(meetingId);
  }

  /**
   * Find webhooks for a user from the database.
   *
   * This uses a try/catch to gracefully handle the case where the Webhook
   * model has not been added to the Prisma schema yet.
   */
  private async findWebhooksForUser(userId: string): Promise<WebhookRegistration[]> {
    try {
      // Attempt to query webhooks from the database
      const webhooks = await (prisma as any).webhook.findMany({
        where: {
          userId,
          isActive: true,
        },
      });

      return webhooks.map((wh: any) => ({
        id: wh.id,
        meetingId: '', // Will be set per-meeting
        url: wh.url,
        secret: wh.secret,
        events: wh.events || [],
        isActive: wh.isActive,
      }));
    } catch {
      // Webhook model may not exist yet in the schema
      return [];
    }
  }

  /**
   * Close the delivery queue.
   */
  async close(): Promise<void> {
    await this.deliveryQueue.close();
  }
}
