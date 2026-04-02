import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES } from '@aramis/shared';
import { logger } from './lib/logger';
import { stateMachine } from './lib/bot-state-machine';
import {
  SummaryGenerator,
  createSummaryGenerator,
  MeetingSummary,
  TranscriptInput,
  MeetingContext,
  SummaryGeneratorConfig,
} from './lib/summary/generator';

// -- Types ------------------------------------------------------------------

interface SummaryJobData {
  meetingId: string;
  transcriptId: string;
}

// -- Summary generation logic -----------------------------------------------

/**
 * Determine which LLM provider to use based on available API keys.
 */
function getSummaryConfig(): Partial<SummaryGeneratorConfig> {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic' };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: 'openai' };
  }
  throw new Error('No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
}

async function processSummaryJob(data: SummaryJobData): Promise<void> {
  const { meetingId, transcriptId } = data;

  logger.info(`Starting summary generation for meeting ${meetingId}`);

  // Fetch the meeting with related data
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    include: {
      participants: true,
    },
  });

  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  // Fetch the transcript
  const transcript = await prisma.transcript.findUnique({
    where: { id: transcriptId },
    include: {
      speakers: true,
      segments: {
        orderBy: { order: 'asc' },
      },
    },
  });

  if (!transcript) {
    throw new Error(`Transcript not found: ${transcriptId}`);
  }

  if (transcript.status !== 'COMPLETED') {
    throw new Error(`Transcript ${transcriptId} is not ready (status: ${transcript.status})`);
  }

  if (!transcript.fullText || transcript.fullText.trim().length === 0) {
    logger.warn(`Transcript ${transcriptId} has no content — skipping summary generation`);
    // Still mark meeting as COMPLETED (summary is optional)
    await stateMachine.transition(meetingId, 'COMPLETED', {
      reason: 'Transcript has no content, skipping summary',
    });
    return;
  }

  // Create or update summary record in PROCESSING state
  let summaryRecord = await prisma.meetingSummary.findUnique({
    where: { meetingId },
  });

  if (summaryRecord) {
    summaryRecord = await prisma.meetingSummary.update({
      where: { meetingId },
      data: {
        status: 'PROCESSING',
        errorMessage: null,
        version: { increment: 1 },
      },
    });
  } else {
    summaryRecord = await prisma.meetingSummary.create({
      data: {
        meetingId,
        status: 'PROCESSING',
      },
    });
  }

  try {
    // Build transcript input for the generator
    const totalDuration =
      transcript.segments.length > 0
        ? transcript.segments[transcript.segments.length - 1].endTime - transcript.segments[0].startTime
        : (meeting.duration ?? 0);

    const speakerNames = transcript.speakers.map((s) => s.identifiedName || s.label);

    const transcriptInput: TranscriptInput = {
      fullText: transcript.fullText,
      duration: totalDuration,
      speakers: speakerNames,
    };

    // Build meeting context
    const meetingContext: MeetingContext = {
      title: meeting.title,
      date: meeting.scheduledStart.toISOString().split('T')[0],
      time: meeting.scheduledStart.toISOString().split('T')[1]?.substring(0, 5),
      participants: meeting.participants.map((p) => p.name),
      platform: meeting.platform,
    };

    // Generate summary
    const config = getSummaryConfig();
    const generator = createSummaryGenerator(config);
    const summary: MeetingSummary = await generator.generateSummary(transcriptInput, meetingContext);

    logger.info(
      `Summary generated: ${summary.keyPoints.length} key points, ` +
        `${summary.decisions.length} decisions, ${summary.actionItems.length} action items`,
    );

    // Save summary to database
    await prisma.meetingSummary.update({
      where: { id: summaryRecord.id },
      data: {
        status: 'COMPLETED',
        overview: summary.overview,
        keyPoints: summary.keyPoints as any,
        decisions: summary.decisions as any,
        actionItems: summary.actionItems as any,
        nextSteps: summary.nextSteps,
        rawResponse: summary as any,
        modelUsed:
          config.model ?? (config.provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-5.4-2026-03-05'),
        generatedAt: new Date(),
      },
    });

    // Update meeting status to COMPLETED now that everything is done
    await stateMachine.transition(meetingId, 'COMPLETED', {
      reason: 'Summary generation completed',
    });

    logger.info(`Summary saved for meeting ${meetingId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Summary generation failed for meeting ${meetingId}: ${errorMessage}`);

    // Mark summary as failed
    await prisma.meetingSummary.update({
      where: { id: summaryRecord.id },
      data: {
        status: 'FAILED',
        errorMessage: errorMessage.substring(0, 500),
      },
    });

    // Still mark meeting as COMPLETED (transcription succeeded, summary is optional)
    await stateMachine.transition(meetingId, 'COMPLETED', {
      reason: 'Summary failed but transcription succeeded',
    });

    throw error;
  }
}

// -- Worker setup -----------------------------------------------------------

export function createSummaryWorker(redis: IORedis, prefix = 'bull'): Worker {
  const worker = new Worker(
    QUEUE_NAMES.SUMMARY,
    async (job) => {
      await processSummaryJob(job.data as SummaryJobData);
    },
    {
      connection: redis,
      prefix,
      concurrency: parseInt(process.env.SUMMARY_CONCURRENCY || '1', 10),
    },
  );

  worker.on('completed', (job) => {
    logger.info(`Summary job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Summary job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
