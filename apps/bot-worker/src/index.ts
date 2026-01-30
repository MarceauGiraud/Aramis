import 'dotenv/config';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES, JOB_TYPES } from '@aramis/shared';
import { MeetingBotFactory } from './bots/factory';
import { logger } from './lib/logger';

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// Worker ID for tracking
const workerId = `worker-${process.pid}-${Date.now()}`;

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

      // Update meeting with recording info
      await prisma.meeting.update({
        where: { id: meetingId },
        data: {
          status: 'PROCESSING',
          actualEnd: new Date(),
        },
      });

      // Create recording record
      await prisma.recording.create({
        data: {
          meetingId,
          videoUrl: recordingPath,
          status: 'PROCESSING',
        },
      });

      logger.info(`Meeting ${meetingId} recording saved: ${recordingPath}`);

      return { success: true, recordingPath };
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
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await meetingWorker.close();
  await redis.quit();
  process.exit(0);
});

logger.info('Bot worker started and listening for jobs');
