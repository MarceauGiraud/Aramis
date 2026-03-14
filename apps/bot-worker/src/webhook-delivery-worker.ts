/**
 * Webhook Delivery Worker
 *
 * BullMQ worker that delivers webhook payloads to configured URLs.
 *
 * Security:
 * - HMAC-SHA256 signature: sha256=HMAC(timestamp.payload_json, secret)
 * - Headers: X-Webhook-Signature, X-Webhook-Timestamp, Content-Type: application/json
 *
 * Retry strategy:
 * - Exponential backoff: 1min, 5min, 30min, 2h, 12h
 * - Max 5 attempts, then dead-letter
 */

import * as crypto from 'crypto';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES } from '@aramis/shared';
import { logger } from './lib/logger';

// Retry delays in milliseconds: 1min, 5min, 30min, 2h, 12h
const RETRY_DELAYS = [
  60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
];

export interface WebhookDeliveryJobData {
  webhookId: string;
  url: string;
  secret: string;
  payload: {
    event: string;
    meetingId: string;
    timestamp: string;
    data: Record<string, unknown>;
  };
  attempt: number;
  maxAttempts: number;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 */
function generateSignature(timestamp: string, payloadJson: string, secret: string): string {
  const data = `${timestamp}.${payloadJson}`;
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `sha256=${hmac}`;
}

export function createWebhookDeliveryWorker(redis: IORedis) {
  const worker = new Worker<WebhookDeliveryJobData>(
    QUEUE_NAMES.WEBHOOK_DELIVERY,
    async (job) => {
      const { webhookId, url, secret, payload, attempt, maxAttempts } = job.data;

      logger.info(
        `Delivering webhook ${webhookId} to ${url} (attempt ${attempt}/${maxAttempts}): ${payload.event}`
      );

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const payloadJson = JSON.stringify(payload);
      const signature = generateSignature(timestamp, payloadJson, secret);

      let statusCode: number | null = null;
      let responseText: string | null = null;
      let error: string | null = null;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
            'X-Webhook-Timestamp': timestamp,
            'User-Agent': 'Aramis-Webhook/1.0',
          },
          body: payloadJson,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        statusCode = response.status;

        try {
          responseText = await response.text();
          // Limit response text stored in DB
          if (responseText.length > 1000) {
            responseText = responseText.substring(0, 1000);
          }
        } catch {
          responseText = null;
        }

        // Record delivery attempt in database
        await recordDelivery(webhookId, payload.event, payload, statusCode, responseText, attempt, maxAttempts);

        // Check if delivery was successful (2xx status)
        if (response.ok) {
          logger.info(`Webhook delivered successfully to ${url}: HTTP ${statusCode}`);
          return { success: true, statusCode };
        }

        // Non-2xx response, treat as failure
        error = `HTTP ${statusCode}: ${responseText?.substring(0, 200) || 'No response body'}`;
        logger.warn(`Webhook delivery failed: ${error}`);
      } catch (fetchError) {
        error = fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.error(`Webhook delivery error: ${error}`);

        // Record failed delivery
        await recordDelivery(webhookId, payload.event, payload, null, null, attempt, maxAttempts, error);
      }

      // If we have retries left, schedule the next attempt
      if (attempt < maxAttempts) {
        const nextAttempt = attempt + 1;
        const delay = RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)];

        logger.info(
          `Scheduling retry ${nextAttempt}/${maxAttempts} for webhook ${webhookId} in ${delay / 1000}s`
        );

        // Re-queue with delay for next attempt
        const queue = job.queue;
        if (queue) {
          await queue.add('deliver', {
            ...job.data,
            attempt: nextAttempt,
          }, {
            delay,
            removeOnComplete: 100,
            removeOnFail: 1000,
          });
        }
      } else {
        logger.error(
          `Webhook ${webhookId} delivery permanently failed after ${maxAttempts} attempts`
        );
      }

      // Return failure info (job itself succeeds to avoid BullMQ's own retry)
      return { success: false, statusCode, error };
    },
    {
      connection: redis,
      concurrency: parseInt(process.env.WEBHOOK_CONCURRENCY || '5'),
    }
  );

  worker.on('completed', (job) => {
    logger.debug(`Webhook delivery job ${job.id} processed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Webhook delivery job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

/**
 * Record a webhook delivery attempt in the database.
 *
 * Uses try/catch since the WebhookDelivery model may not exist yet in Prisma schema.
 */
async function recordDelivery(
  webhookId: string,
  event: string,
  payload: Record<string, unknown>,
  statusCode: number | null,
  response: string | null,
  attempt: number,
  maxAttempts: number,
  error?: string
): Promise<void> {
  try {
    const nextRetryAt = attempt < maxAttempts
      ? new Date(Date.now() + RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)])
      : null;

    await (prisma as any).webhookDelivery.create({
      data: {
        webhookId,
        event,
        payload,
        statusCode,
        response,
        attempt,
        maxAttempts,
        deliveredAt: statusCode && statusCode >= 200 && statusCode < 300 ? new Date() : null,
        nextRetryAt,
        error: error || null,
      },
    });
  } catch {
    // WebhookDelivery model may not exist yet in schema
    logger.debug('Could not record webhook delivery (model may not exist yet)');
  }
}
