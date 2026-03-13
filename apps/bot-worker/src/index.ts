import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from monorepo root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES, JOB_TYPES } from '@aramis/shared';
import { MeetingBotFactory } from './bots/factory';
import { logger } from './lib/logger';
import { uploadRecording } from './lib/storage';
import { isS3Configured } from './lib/s3-config';

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// Transcription queue for queueing jobs after recording
const transcriptionQueue = new Queue(QUEUE_NAMES.TRANSCRIPTION, { connection: redis });

// Worker ID for tracking
const workerId = `worker-${process.pid}-${Date.now()}`;

// Log S3 configuration status at startup
if (isS3Configured()) {
  logger.info('S3 storage configured - recordings will be uploaded');
} else {
  logger.warn('S3 not configured - recordings will only be saved locally');
}

logger.info(`Starting bot worker: ${workerId}`);

// Meeting bot worker
const meetingWorker = new Worker(
  QUEUE_NAMES.MEETING_BOT,
  async (job) => {
    const { meetingId, meetingUrl, platform, botName } = job.data;

    // Validate required fields
    if (!meetingId || !meetingUrl || !platform) {
      throw new Error('Missing required job data: meetingId, meetingUrl, or platform');
    }

    logger.info(`Processing job ${job.id}: Join meeting ${meetingId}`);

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

    // Update or create bot session
    await prisma.botSession.upsert({
      where: { meetingId },
      create: {
        meetingId,
        workerId,
        status: 'RUNNING',
        lastPing: new Date(),
      },
      update: {
        workerId,
        status: 'RUNNING',
        lastPing: new Date(),
      },
    });

    // Create the appropriate bot for the platform
    const bot = MeetingBotFactory.create(platform, {
      meetingId,
      meetingUrl,
      botName: botName || process.env.BOT_NAME || 'Aramis Recorder',
    });

    try {
      // Initialize and join
      await bot.initialize();
      await bot.join();

      // Update meeting status
      await prisma.meeting.update({
        where: { id: meetingId },
        data: {
          status: 'RECORDING',
          actualStart: new Date(),
        },
      });

      // Wait for meeting to end or bot to be stopped
      await bot.waitForEnd();

      // Process recording
      const recordingPath = await bot.saveRecording();
      let videoUrl = recordingPath;
      let s3Uploaded = false;

      // Upload to S3 if configured
      if (isS3Configured()) {
        try {
          logger.info(`Uploading recording to S3...`);
          videoUrl = await uploadRecording(recordingPath, meetingId);
          s3Uploaded = true;
          logger.info(`Recording uploaded to S3: ${videoUrl}`);
        } catch (uploadError) {
          logger.error(`Failed to upload to S3: ${uploadError}`);
          // Continue with local path if S3 fails
        }
      }

      // Update meeting with recording info
      await prisma.meeting.update({
        where: { id: meetingId },
        data: {
          status: 'PROCESSING',
          actualEnd: new Date(),
        },
      });

      // Create recording record
      const recording = await prisma.recording.create({
        data: {
          meetingId,
          videoUrl,
          status: s3Uploaded ? 'COMPLETED' : 'PROCESSING',
        },
      });

      logger.info(`Meeting ${meetingId} recording saved: ${videoUrl}`);

      // Queue transcription job if S3 upload succeeded
      if (s3Uploaded && process.env.DEEPGRAM_API_KEY) {
        try {
          await transcriptionQueue.add('transcribe', {
            meetingId,
            recordingId: recording.id,
            audioUrl: videoUrl,
          }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
          });
          logger.info(`Queued transcription job for meeting ${meetingId}`);
        } catch (queueError) {
          logger.error(`Failed to queue transcription: ${queueError}`);
        }
      }

      return { success: true, recordingPath: videoUrl, s3Uploaded };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error in meeting bot for ${meetingId}: ${errorMessage}`);

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

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await meetingWorker.close();
  await transcriptionQueue.close();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await meetingWorker.close();
  await transcriptionQueue.close();
  await redis.quit();
  process.exit(0);
});

logger.info('Bot worker started and listening for jobs');
