import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from monorepo root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES, JOB_TYPES } from '@aramis/shared';
import { MeetingBotFactory } from './bots/factory';
import { createTranscriptionWorker } from './transcription-worker';
import { logger } from './lib/logger';
import { isS3Configured } from './lib/s3-config';
import * as fs from 'fs';
import { uploadRecording, uploadAudio } from './lib/storage';
import { createSummaryWorker } from './summary-worker';

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

    // Skip if meeting is in a terminal state (don't retry completed/failed meetings)
    const terminalStatuses = ['CANCELLED', 'COMPLETED', 'FAILED', 'PROCESSING'];
    if (terminalStatuses.includes(meeting.status)) {
      logger.info(`Meeting ${meetingId} is in terminal state '${meeting.status}', skipping retry`);
      return { success: false, reason: meeting.status.toLowerCase() };
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

      // Get participants — prefer cached (extracted during meeting) over live extraction
      // The page may already be closed by the time we get here
      let extractedParticipants = bot.getCachedParticipants();
      if (extractedParticipants.length === 0) {
        try {
          extractedParticipants = await bot.extractParticipants();
        } catch (extractError) {
          logger.warn(`Failed to extract participants: ${extractError}`);
        }
      }
      logger.info(`Participants: ${extractedParticipants.length} found`);

      // Leave the meeting gracefully before saving recording
      try {
        await bot.leave();
      } catch (leaveError) {
        logger.warn(`Error leaving meeting: ${leaveError}`);
      }

      // Save extracted participants to DB
      if (extractedParticipants.length > 0) {
        try {
          for (const p of extractedParticipants) {
            await prisma.participant.create({
              data: {
                meetingId,
                name: p.name,
                email: p.email,
                isHost: p.isHost || false,
              },
            });
          }
          logger.info(`Saved ${extractedParticipants.length} participants to DB`);
        } catch (participantError) {
          logger.warn(`Failed to save participants: ${participantError}`);
        }
      }

      // Process recording (orchestrator handles S3 upload internally)
      let recordingPath: string | null = null;
      let recordingInfo: ReturnType<typeof bot.getRecordingInfo> = null;
      try {
        recordingPath = await bot.saveRecording();
        recordingInfo = bot.getRecordingInfo();
      } catch (recordingError) {
        logger.warn(`Recording save failed (meeting still completed): ${recordingError}`);
      }

      // Upload local recording to S3 if not already uploaded (Playwright mode)
      let s3Uploaded = !!(recordingInfo?.s3MergedUrl || recordingInfo?.s3VideoUrl);
      let s3VideoUrl: string | null = recordingInfo?.s3MergedUrl ?? recordingInfo?.s3VideoUrl ?? null;

      if (!s3Uploaded && recordingPath && isS3Configured()) {
        try {
          s3VideoUrl = await uploadRecording(recordingPath, meetingId);
          s3Uploaded = true;
          logger.info(`Recording uploaded to S3: ${s3VideoUrl}`);
        } catch (uploadError) {
          logger.error(`Failed to upload recording to S3: ${uploadError}`);
        }
      }

      // Upload separate audio file to S3 for transcription (Playwright mode)
      // In FFmpeg mode, recordingInfo.s3AudioUrl is already set by the orchestrator.
      // In Playwright mode, audio is captured to a local .webm file that needs separate upload.
      let s3AudioUrl: string | null = recordingInfo?.s3AudioUrl ?? null;
      if (!s3AudioUrl && isS3Configured()) {
        const audioFilePath = bot.getAudioFilePath();
        if (audioFilePath && fs.existsSync(audioFilePath) && fs.statSync(audioFilePath).size > 0) {
          try {
            s3AudioUrl = await uploadAudio(audioFilePath, meetingId);
            logger.info(`Audio uploaded to S3: ${s3AudioUrl}`);
          } catch (audioUploadError) {
            logger.error(`Failed to upload audio to S3: ${audioUploadError}`);
          }
        }
      }

      // Best video URL: S3 > local path
      const videoUrl = s3VideoUrl ?? recordingPath;

      // Update meeting status
      await prisma.meeting.update({
        where: { id: meetingId },
        data: {
          status: videoUrl ? 'PROCESSING' : 'COMPLETED',
          actualEnd: new Date(),
        },
      });

      // Create recording record if we have a recording
      if (videoUrl) {
        const recording = await prisma.recording.create({
          data: {
            meetingId,
            videoUrl,
            audioUrl: s3AudioUrl ?? undefined,
            status: s3Uploaded ? 'COMPLETED' : 'PROCESSING',
          },
        });

        logger.info(`Meeting ${meetingId} recording saved: ${videoUrl}`);
        if (s3AudioUrl) {
          logger.info(`Audio available at: ${s3AudioUrl}`);
        }

        // Queue transcription job with speaker timeline for name correlation
        // Use dedicated audio URL when available; fall back to video URL
        const audioUrl = s3AudioUrl ?? videoUrl;
        const speakerTimeline = bot.getSpeakerTimeline();
        if (speakerTimeline.length > 0) {
          logger.info(`Speaker timeline: ${speakerTimeline.length} segments detected`);
        }
        if (s3Uploaded && process.env.DEEPGRAM_API_KEY) {
          try {
            // Collect per-track audio paths if available (for future per-speaker transcription)
            const perTrackAudioPaths = typeof bot.getPerTrackAudioPaths === 'function'
              ? bot.getPerTrackAudioPaths()
              : undefined;
            await transcriptionQueue.add('transcribe', {
              meetingId,
              recordingId: recording.id,
              audioUrl,
              speakerTimeline, // For correlating Deepgram "Speaker 0" with real names
              ...(perTrackAudioPaths && perTrackAudioPaths.size > 0 && { perTrackAudioPaths: Object.fromEntries(perTrackAudioPaths) }),
            }, {
              attempts: 3,
              backoff: { type: 'exponential', delay: 10000 },
            });
            logger.info(`Queued transcription job for meeting ${meetingId}`);
          } catch (queueError) {
            logger.error(`Failed to queue transcription: ${queueError}`);
          }
        }
      } else {
        logger.warn(`Meeting ${meetingId} completed without recording`);
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

// Start transcription worker
const transcriptionWorker = createTranscriptionWorker(redis);
logger.info('Transcription worker started and listening for jobs');

// Start summary worker
const summaryWorker = createSummaryWorker(redis);
logger.info('Summary worker started and listening for jobs');

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await meetingWorker.close();
  await transcriptionWorker.close();
  await summaryWorker.close();
  await transcriptionQueue.close();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await meetingWorker.close();
  await transcriptionWorker.close();
  await summaryWorker.close();
  await transcriptionQueue.close();
  await redis.quit();
  process.exit(0);
});

logger.info('Bot worker started and listening for jobs');
