/**
 * Transcription Worker
 *
 * BullMQ worker that processes transcription jobs using configurable providers.
 * Accepts an optional `provider` field in job data; defaults to 'deepgram'.
 */

import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES, TRANSCRIPTION_PROVIDERS } from '@aramis/shared';
import { createTranscriptionProvider } from './lib/transcription/provider-factory';
import { logger } from './lib/logger';

export interface TranscriptionJobData {
  meetingId: string;
  recordingId: string;
  audioUrl: string;
  /** Transcription provider name (default: 'deepgram') */
  provider?: string;
  /** Language code (e.g., 'en') */
  language?: string;
  /** Provider-specific model name */
  model?: string;
}

export function createTranscriptionWorker(redis: IORedis) {
  const worker = new Worker<TranscriptionJobData>(
    QUEUE_NAMES.TRANSCRIPTION,
    async (job) => {
      const {
        meetingId,
        recordingId,
        audioUrl,
        provider: providerName = TRANSCRIPTION_PROVIDERS.DEEPGRAM,
        language,
        model,
      } = job.data;

      logger.info(`Processing transcription job ${job.id} for meeting ${meetingId} using ${providerName}`);

      // Create transcript record
      const transcript = await prisma.transcript.create({
        data: {
          meetingId,
          status: 'PROCESSING',
          provider: providerName,
        },
      });

      try {
        // Create the transcription provider
        const provider = createTranscriptionProvider(providerName, {
          language,
          model,
        });

        // Transcribe from URL
        const result = await provider.transcribeUrl(audioUrl, {
          language,
          model,
          diarize: true,
        });

        // Create speakers
        const speakerMap = new Map<string, string>();
        for (const speakerLabel of result.speakers) {
          const speaker = await prisma.transcriptSpeaker.create({
            data: {
              transcriptId: transcript.id,
              label: speakerLabel,
              segmentCount: result.segments.filter(s => s.speaker === speakerLabel).length,
              totalDuration: result.segments
                .filter(s => s.speaker === speakerLabel)
                .reduce((sum, s) => sum + (s.endTime - s.startTime), 0),
            },
          });
          speakerMap.set(speakerLabel, speaker.id);
        }

        // Create segments with words
        for (let i = 0; i < result.segments.length; i++) {
          const seg = result.segments[i];
          const speakerId = seg.speaker ? speakerMap.get(seg.speaker) : undefined;

          const segment = await prisma.transcriptSegment.create({
            data: {
              transcriptId: transcript.id,
              speakerId: speakerId || undefined,
              text: seg.text,
              startTime: seg.startTime,
              endTime: seg.endTime,
              confidence: seg.confidence,
              order: i,
            },
          });

          // Create words if available
          if (seg.words && seg.words.length > 0) {
            await prisma.transcriptWord.createMany({
              data: seg.words.map((word, wordIndex) => ({
                segmentId: segment.id,
                text: word.text,
                startTime: word.startTime,
                endTime: word.endTime,
                confidence: word.confidence,
                order: wordIndex,
              })),
            });
          }
        }

        // Update transcript as completed
        await prisma.transcript.update({
          where: { id: transcript.id },
          data: {
            status: 'COMPLETED',
            fullText: result.fullText,
            wordCount: result.fullText.split(/\s+/).length,
            language: result.language,
            processedAt: new Date(),
          },
        });

        // Update recording status
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: 'COMPLETED' },
        });

        logger.info(
          `Transcription complete for meeting ${meetingId}: ${result.segments.length} segments, ` +
          `${result.speakers.length} speakers`
        );

        return {
          transcriptId: transcript.id,
          segments: result.segments.length,
          speakers: result.speakers.length,
          duration: result.duration,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Transcription failed for meeting ${meetingId}: ${errorMessage}`);

        // Update transcript as failed
        await prisma.transcript.update({
          where: { id: transcript.id },
          data: {
            status: 'FAILED',
            errorMessage: errorMessage.substring(0, 500),
          },
        });

        throw error;
      }
    },
    {
      connection: redis,
      concurrency: parseInt(process.env.TRANSCRIPTION_CONCURRENCY || '2'),
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Transcription job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Transcription job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
