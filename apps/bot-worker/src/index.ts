import * as dotenv from 'dotenv';
import * as path from 'path';
import * as http from 'http';

// Load .env from monorepo root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import {
  QUEUE_NAMES,
  JOB_TYPES,
  BOT_CONFIG,
  BOT_COMMANDS_CHANNEL,
} from '@aramis/shared';
import type { BotCommand, RecordingConfig } from '@aramis/shared';
import { MeetingBotFactory } from './bots/factory';
import { BaseMeetingBot } from './bots/base';
import { logger } from './lib/logger';
import { isS3Configured } from './lib/s3-config';
import { AudioWebSocketServer } from './lib/websocket-server';
import { WebhookDispatcher } from './lib/webhook-dispatcher';
import { createTranscriptionWorker } from './transcription-worker';
import { createWebhookDeliveryWorker } from './webhook-delivery-worker';
import { createCalendarSyncWorker, setupCalendarSyncRepeatable } from './calendar-sync-worker';
import { createSummaryWorker } from './summary-worker';

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// Separate Redis connection for pub/sub (pub/sub requires dedicated connection)
const redisSub = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// Transcription queue for queueing jobs after recording
const transcriptionQueue = new Queue(QUEUE_NAMES.TRANSCRIPTION, { connection: redis });

// Worker ID for tracking
const workerId = `worker-${process.pid}-${Date.now()}`;

// HTTP server for WebSocket
const httpServer = http.createServer((req, res) => {
  // Basic health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', workerId }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// WebSocket audio server
const wsServer = new AudioWebSocketServer();

// Webhook dispatcher
const webhookDispatcher = new WebhookDispatcher(redis);

// Log S3 configuration status at startup
if (isS3Configured()) {
  logger.info('S3 storage configured - recordings will be uploaded');
} else {
  logger.warn('S3 not configured - recordings will only be saved locally');
}

logger.info(`Starting bot worker: ${workerId}`);

/**
 * Check deduplication key to prevent duplicate bots
 */
async function checkDeduplication(deduplicationKey: string | undefined, meetingId: string): Promise<boolean> {
  if (!deduplicationKey) return false;

  try {
    const existing = await prisma.botSession.findFirst({
      where: {
        meetingId,
        status: { in: ['RUNNING', 'STARTING'] },
      },
    });

    if (existing) {
      logger.info(`Deduplication: bot already running for meeting ${meetingId} (session: ${existing.id})`);
      return true;
    }
  } catch (error) {
    logger.warn(`Deduplication check failed: ${error}`);
  }

  return false;
}

/**
 * Start heartbeat interval for a bot session
 */
function startHeartbeat(meetingId: string): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await prisma.botSession.update({
        where: { meetingId },
        data: {
          lastPing: new Date(),
        },
      });
    } catch (error) {
      logger.debug(`Heartbeat update failed for ${meetingId}: ${error}`);
    }
  }, BOT_CONFIG.HEARTBEAT_INTERVAL_MS);
}

/**
 * Set up Redis pub/sub command channel for a meeting.
 * Returns a cleanup function to unsubscribe.
 */
function setupCommandChannel(meetingId: string, bot: BaseMeetingBot): () => void {
  const channel = `${BOT_COMMANDS_CHANNEL}:${meetingId}`;

  const messageHandler = (_channel: string, message: string): void => {
    try {
      const command: BotCommand = JSON.parse(message);
      logger.info(`Received command for ${meetingId}: ${command.type}`);

      switch (command.type) {
        case 'pause':
          bot.pauseRecording();
          break;
        case 'resume':
          bot.resumeRecording();
          break;
        case 'leave':
          bot.leave().catch((err) => logger.error(`Leave command failed: ${err}`));
          break;
        case 'send-chat':
          // Chat sending is platform-specific; log for now
          logger.info(`Send-chat command received: ${JSON.stringify(command.data)}`);
          break;
        default:
          logger.warn(`Unknown command type: ${(command as any).type}`);
      }
    } catch (error) {
      logger.error(`Failed to process command: ${error}`);
    }
  };

  redisSub.subscribe(channel).catch((err: Error) => {
    logger.error(`Failed to subscribe to ${channel}: ${err}`);
  });
  redisSub.on('message', messageHandler);

  logger.info(`Subscribed to command channel: ${channel}`);

  // Return cleanup function
  return () => {
    redisSub.unsubscribe(channel).catch(() => {});
    redisSub.removeListener('message', messageHandler);
    logger.info(`Unsubscribed from command channel: ${channel}`);
  };
}

// Meeting bot worker
const meetingWorker = new Worker(
  QUEUE_NAMES.MEETING_BOT,
  async (job) => {
    const {
      meetingId,
      meetingUrl,
      platform,
      botName,
      recordingConfig,
      deduplicationKey,
      metadata,
    } = job.data;

    // Validate required fields
    if (!meetingId || !meetingUrl || !platform) {
      throw new Error('Missing required job data: meetingId, meetingUrl, or platform');
    }

    logger.info(`Processing job ${job.id}: Join meeting ${meetingId}`);

    // Deduplication check
    if (await checkDeduplication(deduplicationKey, meetingId)) {
      logger.info(`Skipping duplicate bot for meeting ${meetingId}`);
      return { success: false, reason: 'duplicate' };
    }

    // Verify meeting exists before processing
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { id: true, status: true },
    });

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    // Skip if meeting was cancelled
    if (meeting.status === 'CANCELLED') {
      logger.info(`Meeting ${meetingId} was cancelled, skipping`);
      return { success: false, reason: 'cancelled' };
    }

    // State transition: JOINING
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { status: 'JOINING' },
    });

    // Update or create bot session
    await prisma.botSession.upsert({
      where: { meetingId },
      create: {
        meetingId,
        workerId,
        status: 'STARTING',
        lastPing: new Date(),
      },
      update: {
        workerId,
        status: 'STARTING',
        lastPing: new Date(),
      },
    });

    // Register webhooks for this meeting
    await webhookDispatcher.registerWebhooks(meetingId);

    // Dispatch bot joining event
    await webhookDispatcher.dispatch({
      type: 'bot_joining',
      meetingId,
      timestamp: new Date(),
      data: { platform, meetingUrl },
    });

    // Create the appropriate bot for the platform
    const bot = MeetingBotFactory.create(platform, {
      meetingId,
      meetingUrl,
      botName: botName || process.env.BOT_NAME || 'Aramis Recorder',
      platform,
      recordingConfig: recordingConfig as RecordingConfig | undefined,
    });

    // Start heartbeat
    const heartbeatInterval = startHeartbeat(meetingId);

    // Set up command channel
    const cleanupCommandChannel = setupCommandChannel(meetingId, bot);

    try {
      // Initialize and join
      await bot.initialize();

      // Update bot session to RUNNING
      await prisma.botSession.update({
        where: { meetingId },
        data: { status: 'RUNNING', lastPing: new Date() },
      });

      await bot.join();

      // Dispatch bot joined event
      await webhookDispatcher.dispatch({
        type: 'bot_joined',
        meetingId,
        timestamp: new Date(),
      });

      // State transition: RECORDING
      await prisma.meeting.update({
        where: { id: meetingId },
        data: {
          status: 'RECORDING',
          actualStart: new Date(),
        },
      });

      // Dispatch recording started event
      await webhookDispatcher.dispatch({
        type: 'recording_started',
        meetingId,
        timestamp: new Date(),
      });

      // Register audio stream for WebSocket if available
      const orchestrator = (bot as any).recordingOrchestrator;
      if (orchestrator && typeof orchestrator.getAudioStream === 'function') {
        const audioStream = orchestrator.getAudioStream();
        if (audioStream) {
          wsServer.registerBot(meetingId, audioStream);
        }
      }

      // Wait for meeting to end or bot to be stopped
      await bot.waitForEnd();

      // Unregister WebSocket audio stream
      wsServer.unregisterBot(meetingId);

      // State transition: POST_PROCESSING (using PROCESSING status)
      await prisma.meeting.update({
        where: { id: meetingId },
        data: { status: 'PROCESSING' },
      });

      // Process recording (orchestrator handles S3 upload internally)
      let recordingPath: string | null = null;
      let recordingInfo: ReturnType<typeof bot.getRecordingInfo> = null;
      const noRecording = recordingConfig?.noRecording === true;

      if (!noRecording) {
        recordingPath = await bot.saveRecording();
        recordingInfo = bot.getRecordingInfo();
      }

      // Save chat messages to DB
      const chatMessages = bot.getChatMessages();
      if (chatMessages.length > 0) {
        logger.info(`Saving ${chatMessages.length} chat messages for meeting ${meetingId}`);
        try {
          for (const msg of chatMessages) {
            await prisma.chatMessage.create({
              data: {
                meetingId,
                sender: msg.sender,
                message: msg.message,
                timestamp: msg.timestamp,
                platform: msg.platform,
              },
            });
          }
        } catch (chatError) {
          // ChatMessage model may not exist in schema yet
          logger.warn(`Failed to save chat messages (model may not exist): ${chatError}`);
        }
      }

      if (noRecording) {
        // No recording mode: just update meeting status
        await prisma.meeting.update({
          where: { id: meetingId },
          data: {
            status: 'COMPLETED',
            actualEnd: new Date(),
          },
        });

        // Dispatch bot left event
        await webhookDispatcher.dispatch({
          type: 'bot_left',
          meetingId,
          timestamp: new Date(),
        });

        return { success: true, noRecording: true, chatMessages: chatMessages.length };
      }

      // Determine the best video URL (S3 merged > S3 video > local path)
      const videoUrl = recordingInfo?.s3MergedUrl
        ?? recordingInfo?.s3VideoUrl
        ?? recordingPath;

      const s3Uploaded = !!(recordingInfo?.s3MergedUrl || recordingInfo?.s3VideoUrl);

      // Update meeting with recording info
      await prisma.meeting.update({
        where: { id: meetingId },
        data: {
          status: 'PROCESSING',
          actualEnd: new Date(),
        },
      });

      // Create recording record with both video and audio URLs
      const recording = await prisma.recording.create({
        data: {
          meetingId,
          videoUrl,
          audioUrl: recordingInfo?.s3AudioUrl ?? undefined,
          status: s3Uploaded ? 'COMPLETED' : 'PROCESSING',
        },
      });

      logger.info(`Meeting ${meetingId} recording saved: ${videoUrl}`);
      if (recordingInfo?.s3AudioUrl) {
        logger.info(`Audio available at: ${recordingInfo.s3AudioUrl}`);
      }

      // Dispatch recording stopped event
      await webhookDispatcher.dispatch({
        type: 'recording_stopped',
        meetingId,
        timestamp: new Date(),
        data: { videoUrl, s3Uploaded },
      });

      // Queue transcription job using the audio URL (better for transcription)
      const audioUrl = recordingInfo?.s3AudioUrl ?? videoUrl;
      if (s3Uploaded && process.env.DEEPGRAM_API_KEY) {
        try {
          await transcriptionQueue.add('transcribe', {
            meetingId,
            recordingId: recording.id,
            audioUrl, // Use dedicated audio URL for better transcription
          }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
          });
          logger.info(`Queued transcription job for meeting ${meetingId}`);
        } catch (queueError) {
          logger.error(`Failed to queue transcription: ${queueError}`);
        }
      }

      // State transition: COMPLETED
      await prisma.meeting.update({
        where: { id: meetingId },
        data: { status: 'COMPLETED' },
      });

      // Dispatch bot left event
      await webhookDispatcher.dispatch({
        type: 'bot_left',
        meetingId,
        timestamp: new Date(),
      });

      return { success: true, recordingPath: videoUrl, s3Uploaded };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error in meeting bot for ${meetingId}: ${errorMessage}`);

      // Dispatch error event
      await webhookDispatcher.dispatch({
        type: 'error',
        meetingId,
        timestamp: new Date(),
        data: { error: errorMessage },
      });

      // Unregister WebSocket audio stream on error
      wsServer.unregisterBot(meetingId);

      // Update meeting status with error message
      try {
        await prisma.meeting.update({
          where: { id: meetingId },
          data: {
            status: 'FAILED',
            errorMessage: errorMessage.substring(0, 500), // Limit error message length
          },
        });
      } catch (updateError) {
        logger.error(`Failed to update meeting status: ${updateError}`);
      }

      // Update bot session status
      try {
        await prisma.botSession.update({
          where: { meetingId },
          data: { status: 'ERROR' },
        });
      } catch (sessionError) {
        logger.error(`Failed to update bot session: ${sessionError}`);
      }

      throw error;
    } finally {
      // Clean up heartbeat
      clearInterval(heartbeatInterval);

      // Clean up command channel
      cleanupCommandChannel();

      // Unregister webhooks for this meeting
      webhookDispatcher.unregisterWebhooks(meetingId);

      // Update bot session to STOPPED
      try {
        await prisma.botSession.update({
          where: { meetingId },
          data: { status: 'STOPPED', lastPing: new Date() },
        });
      } catch {
        // Ignore - session may not exist
      }

      try {
        await bot.cleanup();
      } catch (cleanupError) {
        logger.error(`Error during bot cleanup: ${cleanupError}`);
      }
    }
  },
  {
    connection: redis,
    concurrency: parseInt(process.env.BOT_CONCURRENCY || '2'),
  }
);

meetingWorker.on('completed', (job) => {
  logger.info(`Job ${job.id} completed`);
});

meetingWorker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed: ${err.message}`);
});

// Start additional workers
const transcriptionWorker = createTranscriptionWorker(redis);
logger.info('Transcription worker started and listening for jobs');

const summaryWorker = createSummaryWorker(redis);
logger.info('Summary worker started and listening for jobs');

const webhookDeliveryWorker = createWebhookDeliveryWorker(redis);
const calendarSyncWorker = createCalendarSyncWorker(redis);

// Initialize services
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
}

initialize().catch((error) => {
  logger.error(`Failed to initialize: ${error}`);
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');

  // Close workers
  await meetingWorker.close();
  await transcriptionWorker.close();
  await summaryWorker.close();
  await webhookDeliveryWorker.close();
  await calendarSyncWorker.close();

  // Close queues
  await transcriptionQueue.close();

  // Close webhook dispatcher
  await webhookDispatcher.close();

  // Close WebSocket server
  await wsServer.close();

  // Close HTTP server
  httpServer.close();

  // Close Redis connections
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
