import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES } from '@aramis/shared';
import { logger } from './lib/logger';
import {
  DeepgramTranscriptionService,
  TranscriptionResult,
  TranscriptSegment as DeepgramSegment,
} from './lib/transcription/deepgram';
import { getPresignedUrl } from './lib/storage';

// -- Types ------------------------------------------------------------------

interface SpeakerTimelineEntry {
  speaker: string;
  email?: string;
  startTime: number; // seconds from recording start
  endTime: number;
}

interface TranscriptionJobData {
  meetingId: string;
  recordingId: string;
  audioUrl: string;
  speakerTimeline: SpeakerTimelineEntry[];
}

// -- Speaker correlation ----------------------------------------------------

/**
 * Build a mapping from Deepgram speaker labels ("Speaker 1", "Speaker 2", ...)
 * to real participant names using the speaker timeline from the bot.
 *
 * Algorithm:
 * For each Deepgram segment, find all timeline entries that overlap with it.
 * Weight each overlap by its duration. Then, for each Deepgram speaker label,
 * pick the real name that has the highest total overlap duration (majority vote).
 */
function buildSpeakerMapping(
  segments: DeepgramSegment[],
  timeline: SpeakerTimelineEntry[],
): Map<string, string> {
  if (timeline.length === 0) {
    return new Map();
  }

  // Accumulate overlap durations: dgSpeaker -> realName -> totalOverlap
  const votes = new Map<string, Map<string, number>>();

  for (const seg of segments) {
    if (!seg.speaker) continue;

    for (const entry of timeline) {
      // Calculate overlap between segment [seg.startTime, seg.endTime]
      // and timeline entry [entry.startTime, entry.endTime]
      const overlapStart = Math.max(seg.startTime, entry.startTime);
      const overlapEnd = Math.min(seg.endTime, entry.endTime);
      const overlap = overlapEnd - overlapStart;

      if (overlap <= 0) continue;

      if (!votes.has(seg.speaker)) {
        votes.set(seg.speaker, new Map());
      }
      const nameVotes = votes.get(seg.speaker)!;
      nameVotes.set(entry.speaker, (nameVotes.get(entry.speaker) || 0) + overlap);
    }
  }

  // For each Deepgram speaker, pick the real name with the most overlap
  const mapping = new Map<string, string>();
  for (const [dgSpeaker, nameVotes] of votes) {
    let bestName = dgSpeaker; // fallback to original label
    let bestScore = 0;

    for (const [name, score] of nameVotes) {
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }

    mapping.set(dgSpeaker, bestName);
  }

  return mapping;
}

// -- Audio URL resolution ---------------------------------------------------

/**
 * Resolve an audio URL so Deepgram can access it.
 * S3 URLs (s3://bucket/key) are converted to presigned HTTP URLs.
 */
async function resolveAudioUrl(audioUrl: string): Promise<string> {
  if (audioUrl.startsWith('s3://')) {
    // Extract key from s3://bucket/key
    const withoutProtocol = audioUrl.slice(5); // remove "s3://"
    const slashIndex = withoutProtocol.indexOf('/');
    const key = withoutProtocol.slice(slashIndex + 1);
    return getPresignedUrl(key);
  }
  return audioUrl;
}

// -- Main transcription logic -----------------------------------------------

async function processTranscriptionJob(data: TranscriptionJobData): Promise<void> {
  const { meetingId, recordingId, audioUrl, speakerTimeline } = data;

  logger.info(`Starting transcription for meeting ${meetingId}`);

  // Create transcript record in PROCESSING state
  const transcript = await prisma.transcript.create({
    data: {
      meetingId,
      status: 'PROCESSING',
      provider: 'deepgram',
    },
  });

  try {
    // Transcribe with Deepgram
    // Use multi-language model to auto-detect French, English, etc.
    const deepgram = new DeepgramTranscriptionService({ language: 'multi' });
    // TODO: When per-track audio is available, pass individual speaker audio files
    // for better speaker identification and diarization accuracy.
    const resolvedUrl = await resolveAudioUrl(audioUrl);
    const result: TranscriptionResult = await deepgram.transcribeUrl(resolvedUrl);

    logger.info(
      `Transcription complete: ${result.segments.length} segments, ` +
      `${result.speakers.length} speakers, confidence=${result.confidence.toFixed(2)}`,
    );

    // Build speaker name mapping
    const speakerMapping = buildSpeakerMapping(result.segments, speakerTimeline || []);
    if (speakerMapping.size > 0) {
      logger.info(
        `Speaker mapping: ${Array.from(speakerMapping.entries())
          .map(([dg, real]) => `${dg} -> ${real}`)
          .join(', ')}`,
      );
    }

    // Create TranscriptSpeaker records
    const speakerRecords = new Map<string, string>(); // label -> record id
    for (const dgLabel of result.speakers) {
      const identifiedName = speakerMapping.get(dgLabel) || null;
      // Compute per-speaker stats
      const speakerSegments = result.segments.filter((s) => s.speaker === dgLabel);
      const totalDuration = speakerSegments.reduce(
        (sum, s) => sum + (s.endTime - s.startTime),
        0,
      );

      const record = await prisma.transcriptSpeaker.create({
        data: {
          transcriptId: transcript.id,
          label: dgLabel,
          identifiedName,
          totalDuration,
          segmentCount: speakerSegments.length,
        },
      });
      speakerRecords.set(dgLabel, record.id);
    }

    // Create TranscriptSegment and TranscriptWord records
    for (let i = 0; i < result.segments.length; i++) {
      const seg = result.segments[i];
      const speakerId = seg.speaker ? speakerRecords.get(seg.speaker) || null : null;

      const segmentRecord = await prisma.transcriptSegment.create({
        data: {
          transcriptId: transcript.id,
          speakerId,
          text: seg.text,
          startTime: seg.startTime,
          endTime: seg.endTime,
          confidence: seg.confidence,
          order: i,
        },
      });

      // Batch-create words for this segment
      if (seg.words.length > 0) {
        await prisma.transcriptWord.createMany({
          data: seg.words.map((w, wi) => ({
            segmentId: segmentRecord.id,
            text: w.text,
            startTime: w.startTime,
            endTime: w.endTime,
            confidence: w.confidence,
            order: wi,
          })),
        });
      }
    }

    // Build full text with speaker names
    const fullText = result.segments
      .map((seg) => {
        const name = seg.speaker
          ? speakerMapping.get(seg.speaker) || seg.speaker
          : 'Unknown';
        return `${name}: ${seg.text}`;
      })
      .join('\n');

    // Update transcript with final data
    await prisma.transcript.update({
      where: { id: transcript.id },
      data: {
        status: 'COMPLETED',
        fullText,
        wordCount: result.segments.reduce((sum, s) => sum + s.words.length, 0),
        language: result.language,
        confidence: result.confidence,
        processedAt: new Date(),
      },
    });

    // Keep meeting in PROCESSING state (summary generation pending)
    logger.info(`Transcription saved for meeting ${meetingId} (transcript ${transcript.id})`);

    // Queue summary generation job if we have transcript content
    if (result.segments.length > 0) {
      try {
        await summaryQueue.add('generate_summary', {
          meetingId,
          transcriptId: transcript.id,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
        });
        logger.info(`Queued summary generation job for meeting ${meetingId}`);
      } catch (queueError) {
        logger.error(`Failed to queue summary: ${queueError}`);
        // Still mark meeting as COMPLETED if summary queueing fails
        await prisma.meeting.update({
          where: { id: meetingId },
          data: { status: 'COMPLETED' },
        });
      }
    } else {
      // No segments - nothing to summarize, mark as completed
      await prisma.meeting.update({
        where: { id: meetingId },
        data: { status: 'COMPLETED' },
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Transcription failed for meeting ${meetingId}: ${errorMessage}`);

    // Mark transcript as failed
    await prisma.transcript.update({
      where: { id: transcript.id },
      data: {
        status: 'FAILED',
        errorMessage: errorMessage.substring(0, 500),
      },
    });

    throw error;
  }
}

// -- Worker setup -----------------------------------------------------------

// Summary queue - created lazily and shared across calls
let summaryQueue: Queue;

export function createTranscriptionWorker(redis: IORedis): Worker {
  summaryQueue = new Queue(QUEUE_NAMES.SUMMARY, { connection: redis });

  const worker = new Worker(
    QUEUE_NAMES.TRANSCRIPTION,
    async (job) => {
      await processTranscriptionJob(job.data as TranscriptionJobData);
    },
    {
      connection: redis,
      concurrency: parseInt(process.env.TRANSCRIPTION_CONCURRENCY || '1', 10),
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
