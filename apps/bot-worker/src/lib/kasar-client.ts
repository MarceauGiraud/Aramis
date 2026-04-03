import crypto from 'crypto';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const KASAR_WEBHOOK_URL = process.env.KASAR_WEBHOOK_URL;
const MEETING_BOT_WEBHOOK_SECRET = process.env.MEETING_BOT_WEBHOOK_SECRET || '';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebhookEvent {
  event: string;
  meetingId: string;
  eventId: string;
  timestamp: string;
  [key: string]: unknown;
}

interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
  confidence?: number;
  words?: Array<{ text: string; start: number; end: number; confidence?: number }>;
}

interface TranscriptSpeaker {
  id: string;
  label: string;
  identifiedName?: string;
  totalDuration: number;
  segmentCount?: number;
}

interface TranscriptData {
  fullText: string;
  segments: TranscriptSegment[];
  speakers: TranscriptSpeaker[];
  provider: string;
  language?: string;
  wordCount?: number;
  confidence?: number;
}

interface RecordingCompleteData {
  storagePath: string;
  duration: number;
  fileSize: number;
  transcript?: TranscriptData;
  participants?: Array<{ name: string; email?: string; isHost?: boolean }>;
  chatMessages?: Array<{
    sender: string;
    message: string;
    timestamp: string;
    platform: string;
  }>;
}

interface MeetingStatusResponse {
  exists: boolean;
  status: string;
  hasRecording: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CRITICAL_EVENTS = new Set([
  'recording_complete',
  'bot_error',
  'transcription_complete',
  'recording_upload_failed',
]);

const PAYLOAD_DIR = '/tmp/kasar-payloads';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const BACKOFF_MULTIPLIER = 3;
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// KasarClient
// ---------------------------------------------------------------------------

export class KasarClient {
  // ------- HMAC signing -------

  private sign(timestamp: string, body: string): string {
    const message = `${timestamp}.${body}`;
    return crypto
      .createHmac('sha256', MEETING_BOT_WEBHOOK_SECRET)
      .update(message)
      .digest('hex');
  }

  // ------- Disk persistence for critical payloads -------

  private ensurePayloadDir(): void {
    if (!existsSync(PAYLOAD_DIR)) {
      mkdirSync(PAYLOAD_DIR, { recursive: true });
    }
  }

  private persistPayload(meetingId: string, event: string, payload: WebhookEvent): void {
    try {
      this.ensurePayloadDir();
      const filePath = `${PAYLOAD_DIR}/${meetingId}-${event}.json`;
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      logger.debug(`Persisted critical payload to ${filePath}`);
    } catch (err) {
      logger.error('Failed to persist critical payload to disk', {
        meetingId,
        event,
        error: String(err),
      });
    }
  }

  private removePersistedPayload(meetingId: string, event: string): void {
    try {
      const filePath = `${PAYLOAD_DIR}/${meetingId}-${event}.json`;
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        logger.debug(`Removed persisted payload ${filePath}`);
      }
    } catch (err) {
      logger.warn('Failed to remove persisted payload', {
        meetingId,
        event,
        error: String(err),
      });
    }
  }

  // ------- Core send with retry -------

  private async sendWithRetry(payload: WebhookEvent): Promise<Response> {
    const body = JSON.stringify(payload);
    const isCritical = CRITICAL_EVENTS.has(payload.event);

    if (isCritical) {
      this.persistPayload(payload.meetingId, payload.event, payload);
    }

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const timestamp = new Date().toISOString();
        const hmac = this.sign(timestamp, body);

        const response = await fetch(KASAR_WEBHOOK_URL!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Hmac': hmac,
            'X-Webhook-Timestamp': timestamp,
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        // No retry on 4xx (client error)
        if (response.status >= 400 && response.status < 500) {
          const text = await response.text().catch(() => '');
          const err = new Error(
            `Webhook returned ${response.status}: ${text}`,
          );
          if (isCritical) {
            throw err;
          }
          logger.warn('Non-critical webhook 4xx, not retrying', {
            event: payload.event,
            meetingId: payload.meetingId,
            status: response.status,
          });
          return response;
        }

        // Retry on 5xx
        if (response.status >= 500) {
          lastError = new Error(`Webhook returned ${response.status}`);
          if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
            logger.warn(`Webhook 5xx, retrying in ${delay}ms`, {
              attempt,
              event: payload.event,
              meetingId: payload.meetingId,
              status: response.status,
            });
            await this.sleep(delay);
            continue;
          }
          break;
        }

        // Success
        if (isCritical) {
          this.removePersistedPayload(payload.meetingId, payload.event);
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry 4xx errors re-thrown above
        if (lastError.message.startsWith('Webhook returned 4')) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
          logger.warn(`Webhook request failed, retrying in ${delay}ms`, {
            attempt,
            event: payload.event,
            meetingId: payload.meetingId,
            error: lastError.message,
          });
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    const finalError = lastError ?? new Error('All retries exhausted');
    logger.error('Webhook delivery failed after all retries', {
      event: payload.event,
      meetingId: payload.meetingId,
      error: finalError.message,
    });

    if (isCritical) {
      throw finalError;
    }

    // Return a synthetic failed response for non-critical
    return new Response(null, { status: 0 });
  }

  // ------- Public: send event -------

  async sendEvent(
    event: string,
    meetingId: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    if (!KASAR_WEBHOOK_URL) {
      logger.warn('KASAR_WEBHOOK_URL not configured, skipping event', { event, meetingId });
      return;
    }

    const payload: WebhookEvent = {
      event,
      meetingId,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...data,
    };

    const isCritical = CRITICAL_EVENTS.has(event);

    if (isCritical) {
      // Await response and throw on failure
      await this.sendWithRetry(payload);
      logger.info(`Critical event '${event}' delivered`, { meetingId });
    } else {
      // Fire-and-forget
      this.sendWithRetry(payload).catch((err) => {
        logger.error(`Non-critical event '${event}' failed`, {
          meetingId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // ------- Typed helpers -------

  async notifyBotJoined(meetingId: string): Promise<void> {
    await this.sendEvent('bot_joined', meetingId);
  }

  async notifyBotWaiting(meetingId: string, reason: string): Promise<void> {
    await this.sendEvent('bot_waiting', meetingId, { reason });
  }

  async sendTranscriptChunk(
    meetingId: string,
    segments: TranscriptSegment[],
  ): Promise<void> {
    await this.sendEvent('transcript_chunk', meetingId, { segments });
  }

  async sendRecordingProgress(
    meetingId: string,
    duration: number,
    fileSize: number,
  ): Promise<void> {
    await this.sendEvent('recording_progress', meetingId, { duration, fileSize });
  }

  async notifyRecordingComplete(
    meetingId: string,
    data: RecordingCompleteData,
  ): Promise<void> {
    await this.sendEvent('recording_complete', meetingId, { ...data });
  }

  async notifyTranscriptionComplete(
    meetingId: string,
    transcript: TranscriptData,
  ): Promise<void> {
    await this.sendEvent('transcription_complete', meetingId, { transcript });
  }

  async notifyRecordingUploadFailed(
    meetingId: string,
    error: string,
  ): Promise<void> {
    await this.sendEvent('recording_upload_failed', meetingId, { error });
  }

  async notifyError(
    meetingId: string,
    error: string,
    phase: string,
  ): Promise<void> {
    await this.sendEvent('bot_error', meetingId, { error, phase });
  }

  async notifyBotLeft(meetingId: string, reason: string): Promise<void> {
    await this.sendEvent('bot_left', meetingId, { reason });
  }

  // ------- Status check (GET) -------

  async checkMeetingStatus(meetingId: string): Promise<MeetingStatusResponse> {
    if (!KASAR_WEBHOOK_URL) {
      throw new Error('KASAR_WEBHOOK_URL not configured');
    }

    const url = `${KASAR_WEBHOOK_URL}/status?meetingId=${encodeURIComponent(meetingId)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-API-Key': INTERNAL_API_KEY,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`checkMeetingStatus failed with status ${response.status}`);
    }

    return (await response.json()) as MeetingStatusResponse;
  }

  // ------- Utilities -------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const kasarClient = new KasarClient();

// Re-export types for consumers
export type {
  WebhookEvent,
  TranscriptSegment,
  TranscriptSpeaker,
  TranscriptData,
  RecordingCompleteData,
  MeetingStatusResponse,
};
