import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES } from '@aramis/shared';

// BullMQ prefix — matches Kasar conventions (dev: / prod:)
const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX || 'bull';

// Redis connection (singleton)
let redis: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!redis) {
    redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
  }
  return redis;
}

// Queue instances (singletons)
const queues: Record<string, Queue> = {};

export function getMeetingBotQueue(): Queue {
  if (!queues[QUEUE_NAMES.MEETING_BOT]) {
    queues[QUEUE_NAMES.MEETING_BOT] = new Queue(QUEUE_NAMES.MEETING_BOT, {
      connection: getRedisConnection(),
      prefix: BULLMQ_PREFIX,
    });
  }
  return queues[QUEUE_NAMES.MEETING_BOT];
}

export function getTranscriptionQueue(): Queue {
  if (!queues[QUEUE_NAMES.TRANSCRIPTION]) {
    queues[QUEUE_NAMES.TRANSCRIPTION] = new Queue(QUEUE_NAMES.TRANSCRIPTION, {
      connection: getRedisConnection(),
      prefix: BULLMQ_PREFIX,
    });
  }
  return queues[QUEUE_NAMES.TRANSCRIPTION];
}

// Add a meeting bot job
export async function addMeetingBotJob(data: {
  meetingId: string;
  meetingUrl: string;
  platform: string;
  botName?: string;
}) {
  const queue = getMeetingBotQueue();
  return queue.add('join_meeting', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  });
}

// Add a transcription job
export async function addTranscriptionJob(data: { meetingId: string; audioUrl: string; language?: string }) {
  const queue = getTranscriptionQueue();
  return queue.add('transcribe', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
  });
}
