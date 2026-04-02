import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from monorepo root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES } from '@aramis/shared';
import { logger } from './lib/logger';
import { isS3Configured } from './lib/s3-config';
import { AudioWebSocketServer } from './lib/websocket-server';
import { WebhookDispatcher } from './lib/webhook-dispatcher';
import { displayAllocator } from './lib/display-allocator';
import * as promMetrics from './lib/prometheus-metrics';
import { createTranscriptionWorker } from './transcription-worker';
import { createWebhookDeliveryWorker } from './webhook-delivery-worker';
import { createCalendarSyncWorker, setupCalendarSyncRepeatable } from './calendar-sync-worker';
import { createSummaryWorker } from './summary-worker';
import { createHttpServer } from './http-server';
import { processMeetingJob } from './job-handler';

// --- Redis connections ---

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// Separate Redis connection for pub/sub (pub/sub requires dedicated connection)
const redisSub = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// --- Shared resources ---

const transcriptionQueue = new Queue(QUEUE_NAMES.TRANSCRIPTION, { connection: redis });
const workerId = `worker-${process.pid}-${Date.now()}`;
const httpServer = createHttpServer(workerId);
const wsServer = new AudioWebSocketServer();
const webhookDispatcher = new WebhookDispatcher(redis);

// --- Startup log ---

if (isS3Configured()) {
  logger.info('S3 storage configured - recordings will be uploaded');
} else {
  logger.warn('S3 not configured - recordings will only be saved locally');
}

logger.info(`Starting bot worker: ${workerId}`);

// --- Workers ---

const jobHandlerDeps = { redis, redisSub, transcriptionQueue, wsServer, webhookDispatcher, workerId };

const meetingWorker = new Worker(QUEUE_NAMES.MEETING_BOT, (job) => processMeetingJob(job, jobHandlerDeps), {
  connection: redis,
  concurrency: parseInt(process.env.BOT_CONCURRENCY || '2'),
});

meetingWorker.on('completed', (job) => {
  logger.info(`Job ${job.id} completed`);
});

meetingWorker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed: ${err.message}`);
});

const transcriptionWorker = createTranscriptionWorker(redis);
logger.info('Transcription worker started and listening for jobs');

const summaryWorker = createSummaryWorker(redis);
logger.info('Summary worker started and listening for jobs');

const webhookDeliveryWorker = createWebhookDeliveryWorker(redis);
const calendarSyncWorker = createCalendarSyncWorker(redis);

// --- Initialize services ---

async function initialize() {
  // Attach WebSocket server to HTTP server
  try {
    await wsServer.attach(httpServer);
    logger.info('WebSocket audio server initialized');
  } catch (error) {
    logger.warn(`WebSocket server not available (ws package may not be installed): ${error}`);
  }

  // Start HTTP server
  const port = parseInt(process.env.WS_PORT || '8765');
  httpServer.listen(port, () => {
    logger.info(`HTTP/WebSocket server listening on port ${port}`);
  });

  // Set up calendar sync repeatable job
  try {
    await setupCalendarSyncRepeatable(redis);
  } catch (error) {
    logger.warn(`Failed to set up calendar sync: ${error}`);
  }

  // Poll queue depths every 30 seconds for Prometheus
  setInterval(async () => {
    try {
      for (const [, queueName] of Object.entries(QUEUE_NAMES)) {
        const queue = new Queue(queueName, { connection: redis });
        const waiting = await queue.getWaitingCount();
        promMetrics.queueDepth.set({ queue: queueName }, waiting);
        await queue.close();
      }
    } catch {
      // Ignore polling errors
    }
  }, 30000);
}

initialize().catch((error) => {
  logger.error(`Failed to initialize: ${error}`);
});

// --- Graceful shutdown ---

async function shutdown() {
  logger.info('Shutting down...');

  await meetingWorker.close();
  await transcriptionWorker.close();
  await summaryWorker.close();
  await webhookDeliveryWorker.close();
  await calendarSyncWorker.close();

  await transcriptionQueue.close();
  await webhookDispatcher.close();
  await wsServer.close();
  httpServer.close();

  await displayAllocator.releaseAll();

  await redisSub.quit();
  await redis.quit();

  process.exit(0);
}

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM');
  await shutdown();
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT');
  await shutdown();
});

logger.info('Bot worker started and listening for jobs');

// Clean up stuck meetings/sessions from previous crashes on startup
import { cleanupStaleBots } from './commands/cleanup-stale-bots';
cleanupStaleBots().catch((err) => logger.error(`Startup cleanup failed: ${err}`));

// Run cleanup periodically (every 5 minutes)
setInterval(
  () => {
    cleanupStaleBots().catch((err) => logger.error(`Periodic cleanup failed: ${err}`));
  },
  5 * 60 * 1000,
);
