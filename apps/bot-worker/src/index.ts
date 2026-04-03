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
import { displayAllocator } from './lib/display-allocator';
import * as promMetrics from './lib/prometheus-metrics';
import { createTranscriptionWorker } from './transcription-worker';
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

// BullMQ prefix — matches Kasar conventions (dev: / prod:)
const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX || 'bull';

const transcriptionQueue = new Queue(QUEUE_NAMES.TRANSCRIPTION, { connection: redis, prefix: BULLMQ_PREFIX });
const workerId = `worker-${process.pid}-${Date.now()}`;
const httpServer = createHttpServer(workerId);
const wsServer = new AudioWebSocketServer();

// --- Startup log ---

if (isS3Configured()) {
  logger.info('S3 storage configured - recordings will be uploaded');
} else {
  logger.warn('S3 not configured - recordings will only be saved locally');
}

logger.info(`Starting bot worker: ${workerId}`);

// --- Workers ---

const jobHandlerDeps = { redis, redisSub, transcriptionQueue, wsServer, workerId };

const meetingWorker = new Worker(QUEUE_NAMES.MEETING_BOT, (job) => processMeetingJob(job, jobHandlerDeps), {
  connection: redis,
  concurrency: parseInt(process.env.BOT_CONCURRENCY || '2'),
  prefix: BULLMQ_PREFIX,
});

meetingWorker.on('completed', (job) => {
  logger.info(`Job ${job.id} completed`);
});

meetingWorker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed: ${err.message}`);
});

const transcriptionWorker = createTranscriptionWorker(redis, BULLMQ_PREFIX);
logger.info('Transcription worker started and listening for jobs');

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

  await transcriptionQueue.close();
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

// Stale bot cleanup is handled by Kasar (cron checks meetings stuck in active status).
