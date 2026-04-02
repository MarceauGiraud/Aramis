/**
 * Transcription Worker
 *
 * BullMQ worker that processes transcription jobs using configurable providers.
 * Accepts an optional `provider` field in job data; defaults to 'deepgram'.
 */

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES, TRANSCRIPTION_PROVIDERS } from '@aramis/shared';
import { createTranscriptionProvider } from './lib/transcription/provider-factory';
import { SpeakerReconciler, DomSpeakerEvent } from './lib/speaker-reconciler';
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
  /** DOM-detected speaker timeline for reconciliation with diarization labels */
  speakerHistory?: DomSpeakerEvent[];
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
        speakerHistory,
      } = job.data;

      logger.info(`Processing transcription job ${job.id} for meeting ${meetingId} using ${providerName}`);

      // Find any existing transcript for this meeting (live transcript to replace).
      // We do NOT delete it yet — the old transcript stays until the batch succeeds.
      const existingTranscriptIds: string[] = [];
      try {
        const existing = await prisma.transcript.findMany({
          where: { meetingId },
          select: { id: true },
        });
        existingTranscriptIds.push(...existing.map((t) => t.id));
      } catch (lookupErr) {
        logger.warn(`Lookup of existing transcripts failed (non-fatal): ${lookupErr}`);
      }

      // Create or update transcript record (live transcription may have already created one)
      const transcript = await prisma.transcript.upsert({
        where: {
          meetingId_provider: { meetingId, provider: providerName },
        },
        update: {
          status: 'PROCESSING',
        },
        create: {
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

        // Reconcile anonymous diarization labels with real names from DOM detection
        let speakerNameMapping: Map<string, string> | null = null;
        if (speakerHistory && speakerHistory.length > 0) {
          try {
            const reconciler = new SpeakerReconciler();
            const mapping = reconciler.reconcile(result.segments, speakerHistory);
            if (mapping.labelToName.size > 0) {
              speakerNameMapping = mapping.labelToName;
              logger.info(
                `Speaker reconciliation for meeting ${meetingId}: ` +
                  `mapped ${mapping.labelToName.size}/${result.speakers.length} labels`,
              );
            }
          } catch (error) {
            logger.warn(`Speaker reconciliation failed (non-fatal): ${error}`);
          }
        }

        // Create speakers
        const speakerMap = new Map<string, string>();
        for (const speakerLabel of result.speakers) {
          const identifiedName = speakerNameMapping?.get(speakerLabel) ?? null;
          const speaker = await prisma.transcriptSpeaker.create({
            data: {
              transcriptId: transcript.id,
              label: speakerLabel,
              identifiedName,
              segmentCount: result.segments.filter((s) => s.speaker === speakerLabel).length,
              totalDuration: result.segments
                .filter((s) => s.speaker === speakerLabel)
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

        // Batch transcript succeeded — now delete the old live transcript(s).
        // Guard: if batch produced 0 segments, keep old transcripts (they may
        // contain useful per-participant live data).
        if (result.segments.length === 0 && existingTranscriptIds.length > 0) {
          logger.warn(
            `Batch transcription for meeting ${meetingId} produced 0 segments — ` +
              `keeping ${existingTranscriptIds.length} existing transcript(s)`,
          );
        }

        for (const oldId of existingTranscriptIds) {
          if (result.segments.length === 0) break; // skip deletion when batch is empty
          if (oldId === transcript.id) continue; // skip the one we just created
          try {
            await prisma.$transaction([
              prisma.transcriptWord.deleteMany({
                where: { segment: { transcriptId: oldId } },
              }),
              prisma.transcriptSegment.deleteMany({ where: { transcriptId: oldId } }),
              prisma.transcriptSpeaker.deleteMany({ where: { transcriptId: oldId } }),
              prisma.transcript.delete({ where: { id: oldId } }),
            ]);
            logger.info(`Deleted old transcript ${oldId} after successful batch replacement`);
          } catch (deleteErr) {
            logger.warn(`Failed to delete old transcript ${oldId} (non-fatal): ${deleteErr}`);
          }
        }

        // Update recording status
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: 'COMPLETED' },
        });

        logger.info(
          `Transcription complete for meeting ${meetingId}: ${result.segments.length} segments, ` +
            `${result.speakers.length} speakers`,
        );

        // Queue summary generation only if there are segments to summarize
        if (result.segments.length === 0) {
          logger.warn(`Batch transcription produced 0 segments for ${meetingId} — skipping summary`);
        } else {
          const summaryQueue = new Queue(QUEUE_NAMES.SUMMARY, { connection: redis });
          await summaryQueue.add('generate-summary', {
            meetingId,
            transcriptId: transcript.id,
          });
          await summaryQueue.close();

          logger.info(`Summary job queued for meeting ${meetingId}`);
        }

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
    },
  );

  worker.on('completed', (job) => {
    logger.info(`Transcription job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Transcription job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
