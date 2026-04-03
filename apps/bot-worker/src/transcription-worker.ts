/**
 * Transcription Worker
 *
 * BullMQ worker that processes transcription jobs using configurable providers.
 * Accepts an optional `provider` field in job data; defaults to 'deepgram'.
 */

import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES, TRANSCRIPTION_PROVIDERS } from '@aramis/shared';
import { createTranscriptionProvider } from './lib/transcription/provider-factory';
import { SpeakerReconciler, DomSpeakerEvent } from './lib/speaker-reconciler';
import { logger } from './lib/logger';
import { kasarClient } from './lib/kasar-client';

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
  /** Participants detected by ParticipantTracker (DOM / CSRC mapping) */
  participants?: Array<{ name: string; email?: string; isHost?: boolean }>;
}

export function createTranscriptionWorker(redis: IORedis, prefix = 'bull') {
  const worker = new Worker<TranscriptionJobData>(
    QUEUE_NAMES.TRANSCRIPTION,
    async (job) => {
      const {
        meetingId,
        audioUrl,
        provider: providerName = TRANSCRIPTION_PROVIDERS.DEEPGRAM,
        language,
        model,
        speakerHistory,
        participants,
      } = job.data;

      logger.info(`Processing transcription job ${job.id} for meeting ${meetingId} using ${providerName}`);

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

      // Fast path: single non-bot participant → map ALL speaker labels to that name
      const nonBotParticipants = participants?.filter((p) => !p.name.toLowerCase().includes('aramis')) ?? [];
      if (nonBotParticipants.length === 1 && result.speakers.length >= 1) {
        const singleName = nonBotParticipants[0].name;
        speakerNameMapping = new Map();
        for (const label of result.speakers) {
          speakerNameMapping.set(label, singleName);
        }
        logger.info(
          `Single-participant mapping for meeting ${meetingId}: all ${result.speakers.length} labels → "${singleName}"`,
        );
      } else if (speakerHistory && speakerHistory.length > 0) {
        // Multi-speaker: use temporal overlap reconciliation
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
      } else if (nonBotParticipants.length > 0 && result.speakers.length > 0) {
        // No speaker history but we have participants — try positional mapping
        // if same count of speakers and participants
        if (nonBotParticipants.length === result.speakers.length) {
          speakerNameMapping = new Map();
          for (let i = 0; i < result.speakers.length; i++) {
            speakerNameMapping.set(result.speakers[i], nonBotParticipants[i].name);
          }
          logger.info(
            `Positional speaker mapping for meeting ${meetingId}: ` +
              `${result.speakers.length} labels matched to ${nonBotParticipants.length} participants`,
          );
        }
      }

      // Build processed segments with reconciled speaker names
      const processedSegments = result.segments.map((seg) => ({
        start: seg.startTime,
        end: seg.endTime,
        speaker: speakerNameMapping?.get(seg.speaker || '') ?? seg.speaker ?? 'Unknown',
        text: seg.text,
        confidence: seg.confidence,
        words: seg.words?.map((w) => ({
          text: w.text,
          start: w.startTime,
          end: w.endTime,
          confidence: w.confidence,
        })),
      }));

      // Build processed speakers with reconciled names and stats
      const processedSpeakers = result.speakers.map((speakerLabel) => {
        const identifiedName = speakerNameMapping?.get(speakerLabel) ?? undefined;
        const speakerSegments = result.segments.filter((s) => s.speaker === speakerLabel);
        return {
          id: speakerLabel,
          label: identifiedName ?? speakerLabel,
          identifiedName,
          totalDuration: speakerSegments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0),
          segmentCount: speakerSegments.length,
        };
      });

      const fullText = result.fullText;
      const averageConfidence =
        result.segments.length > 0
          ? result.segments.reduce((sum, s) => sum + (s.confidence ?? 0), 0) / result.segments.length
          : undefined;

      logger.info(
        `Transcription complete for meeting ${meetingId}: ${result.segments.length} segments, ` +
          `${result.speakers.length} speakers`,
      );

      // Notify Kasar with the full transcript data (summary is handled by Kasar)
      await kasarClient.notifyTranscriptionComplete(meetingId, {
        fullText,
        segments: processedSegments,
        speakers: processedSpeakers,
        provider: providerName,
        language: result.language,
        wordCount: fullText.split(/\s+/).length,
        confidence: averageConfidence,
      });

      return {
        segments: result.segments.length,
        speakers: result.speakers.length,
        duration: result.duration,
      };
    },
    {
      connection: redis,
      concurrency: parseInt(process.env.TRANSCRIPTION_CONCURRENCY || '2'),
      prefix,
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
