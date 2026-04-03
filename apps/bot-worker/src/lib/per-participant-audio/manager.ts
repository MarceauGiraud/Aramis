/**
 * Per-Participant Audio Manager
 *
 * Receives per-participant audio chunks (identified by streamId) from the
 * browser-side audio interceptor and routes them to individual Deepgram live
 * transcription sessions. Each unique speaker gets their own session so that
 * transcripts are attributed to the correct participant.
 */

import { EventEmitter } from 'events';
import type { Page } from 'playwright';
import { logger } from '../logger';
import { createTranscriptionProvider } from '../transcription/provider-factory';
import type { LiveTranscriptionSession, TranscriptSegment } from '../transcription/provider-interface';
import { ParticipantResolver } from './participant-resolver';

const TRANSCRIPTION_PROVIDER = 'deepgram';
const DEFAULT_MAX_CONCURRENT_SESSIONS = 10;
const DEFAULT_SILENCE_TIMEOUT_MS = 30_000;
const LANG_DETECT_SAMPLE_COUNT = 3; // Final transcripts needed per candidate
const LANG_DETECT_TIMEOUT_MS = 15_000; // Max time for detection phase

// ---------------------------------------------------------------------------
// LanguageDetector — races N candidate languages on the same audio
// ---------------------------------------------------------------------------

interface LangCandidate {
  language: string;
  session: LiveTranscriptionSession;
  confidences: number[];
  avgConfidence: number;
}

class LanguageDetector {
  private candidates: LangCandidate[] = [];
  private resolved = false;
  private resolvePromise: ((lang: string) => void) | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly languages: string[],
    private readonly samplesNeeded: number = LANG_DETECT_SAMPLE_COUNT,
  ) {}

  async start(): Promise<void> {
    for (const lang of this.languages) {
      const provider = createTranscriptionProvider(TRANSCRIPTION_PROVIDER);
      if (!provider.supportsLiveTranscription() || !provider.startLiveTranscription) continue;

      const session = await provider.startLiveTranscription({
        model: 'nova-3',
        language: lang,
        diarize: false,
        channels: 1,
        encoding: 'linear16',
        sampleRate: 16000,
      });

      const candidate: LangCandidate = {
        language: lang,
        session,
        confidences: [],
        avgConfidence: 0,
      };

      session.on('transcript', (_segment: TranscriptSegment, isFinal: boolean) => {
        if (!isFinal || this.resolved) return;
        const conf = _segment.confidence ?? 0;
        if (conf > 0) {
          candidate.confidences.push(conf);
          candidate.avgConfidence = candidate.confidences.reduce((a, b) => a + b, 0) / candidate.confidences.length;
          this.checkResolution();
        }
      });

      session.on('error', () => {
        /* ignore detection errors */
      });
      session.on('close', () => {
        /* ignore */
      });

      this.candidates.push(candidate);
    }

    logger.info('Language detection started', {
      candidates: this.languages,
      samplesNeeded: this.samplesNeeded,
    });
  }

  /** Send audio to all candidate sessions. */
  send(pcmBuffer: Buffer): void {
    if (this.resolved) return;
    for (const c of this.candidates) {
      try {
        c.session.send(pcmBuffer);
      } catch {}
    }
  }

  /** Wait for a winner or timeout. Returns the best language. */
  async waitForResult(defaultLang: string): Promise<string> {
    if (this.resolved) return defaultLang;

    return new Promise<string>((resolve) => {
      this.resolvePromise = resolve;

      this.timeoutHandle = setTimeout(() => {
        if (!this.resolved) {
          this.resolved = true;
          const best = this.pickBest() ?? defaultLang;
          logger.info(`Language detection timed out — using "${best}"`);
          this.cleanup();
          resolve(best);
        }
      }, LANG_DETECT_TIMEOUT_MS);
    });
  }

  private checkResolution(): void {
    if (this.resolved) return;

    // Check if all candidates have enough samples
    const ready = this.candidates.every((c) => c.confidences.length >= this.samplesNeeded);
    if (!ready) return;

    this.resolved = true;
    const best = this.pickBest()!;
    logger.info('Language detected', {
      results: this.candidates.map((c) => ({
        language: c.language,
        avgConfidence: c.avgConfidence.toFixed(3),
        samples: c.confidences.length,
      })),
      winner: best,
    });
    this.cleanup();
    this.resolvePromise?.(best);
  }

  private pickBest(): string | null {
    if (this.candidates.length === 0) return null;
    const sorted = [...this.candidates].sort((a, b) => b.avgConfidence - a.avgConfidence);
    return sorted[0].avgConfidence > 0 ? sorted[0].language : null;
  }

  private cleanup(): void {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    for (const c of this.candidates) {
      try {
        c.session.close();
      } catch {}
    }
    this.candidates = [];
  }
}
const MONITOR_INTERVAL_MS = 5_000;
const SILENCE_RMS_THRESHOLD = 0.0025;

export interface ParticipantSession {
  csrcId: string;
  displayName: string;
  deepgramSession: LiveTranscriptionSession | null;
  lastNonSilentTime: number;
  lastNameResolveTime?: number;
  segments: TranscriptSegment[];
  isActive: boolean;
}

export interface PerParticipantAudioManagerConfig {
  meetingId: string;
  language?: string;
  maxConcurrentSessions?: number;
  silenceTimeoutMs?: number;
}

export class PerParticipantAudioManager extends EventEmitter {
  private sessions: Map<string, ParticipantSession> = new Map();
  private resolver: ParticipantResolver;
  private monitorInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  private readonly meetingId: string;
  private readonly language: string;
  private readonly maxConcurrentSessions: number;
  private readonly silenceTimeoutMs: number;

  constructor(config: PerParticipantAudioManagerConfig) {
    super();
    this.meetingId = config.meetingId;
    this.language = config.language ?? 'fr';
    this.maxConcurrentSessions = config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    this.silenceTimeoutMs = config.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
    this.resolver = new ParticipantResolver();
  }

  /**
   * Initialize the manager: set up participant resolution and start monitoring.
   */
  async start(page: Page): Promise<void> {
    this.isRunning = true;
    this.resolver.start(page);

    this.monitorInterval = setInterval(() => {
      this.monitorSessions();
    }, MONITOR_INTERVAL_MS);

    logger.info('PerParticipantAudioManager started', {
      meetingId: this.meetingId,
      language: this.language,
      maxConcurrentSessions: this.maxConcurrentSessions,
    });
  }

  /**
   * Handle an incoming audio chunk from the browser.
   *
   * Called by the `page.exposeFunction` callback. The chunk is base64-encoded
   * linear PCM (Int16LE, mono, 16 kHz).
   */
  handleAudioChunk(csrcId: string | number, pcmBase64: string): void {
    if (!this.isRunning) return;

    // CSRC source ID arrives from the browser — coerce to string
    const id = String(csrcId);

    // Filter out CSRC 0 (the bot's own audio source)
    if (id === '0') return;

    try {
      const pcmBuffer = Buffer.from(pcmBase64, 'base64');
      // Validate buffer has at least 1 sample (2 bytes for Int16)
      if (pcmBuffer.length < 2) return;
      const silent = this.isSilent(pcmBuffer);

      let session = this.sessions.get(id);

      if (!session) {
        // Enforce concurrency before creating a new session.
        this.enforceConcurrencyLimit();
        // Create synchronously with a null deepgram session; the async
        // initialisation is kicked off in the background.
        session = this.createSessionSync(id);
        this.sessions.set(id, session);
        this.initSessionAsync(session).catch((err) => {
          logger.warn('Failed to initialize transcription session, removing zombie session', {
            streamId: id,
            error: String(err),
          });
          // Remove the session so the next audio chunk triggers a fresh attempt
          this.sessions.delete(id);
          // Do NOT emit 'error' here — unhandled 'error' events crash the process
        });
      }

      if (!silent) {
        session.lastNonSilentTime = Date.now();
      }

      // Only re-resolve name every 1 second to pick up names shortly after poll
      const now = Date.now();
      if (!session.lastNameResolveTime || now - session.lastNameResolveTime > 1000) {
        session.lastNameResolveTime = now;
        const resolvedName = this.resolver.getName(id);
        if (resolvedName !== session.displayName) {
          session.displayName = resolvedName;
        }
      }

      // Forward audio to Deepgram if the session is ready.
      if (session.deepgramSession) {
        session.deepgramSession.send(pcmBuffer);
      }
    } catch (err) {
      logger.error('Error handling audio chunk', { streamId: id, error: String(err) });
    }
  }

  /**
   * Handle a binary audio chunk received via WebSocket.
   * Same as handleAudioChunk but skips base64 decoding (already binary).
   */
  handleBinaryAudioChunk(speakerId: string | number, pcmBuffer: Buffer): void {
    if (!this.isRunning) return;

    const id = String(speakerId);
    if (id === '0') return;

    try {
      // Validate buffer has at least 1 sample (2 bytes for Int16)
      if (pcmBuffer.length < 2) return;
      const silent = this.isSilent(pcmBuffer);

      let session = this.sessions.get(id);
      if (!session) {
        this.enforceConcurrencyLimit();
        session = this.createSessionSync(id);
        this.sessions.set(id, session);
        this.initSessionAsync(session).catch((err) => {
          logger.warn('Failed to initialize transcription session, removing zombie session', {
            streamId: id,
            error: String(err),
          });
          // Remove the session so the next audio chunk triggers a fresh attempt
          this.sessions.delete(id);
          // Do NOT emit 'error' here — unhandled 'error' events crash the process
        });
      }

      if (!silent) {
        session.lastNonSilentTime = Date.now();
      }

      // Only re-resolve name every 1 second to pick up names shortly after poll
      const now = Date.now();
      if (!session.lastNameResolveTime || now - session.lastNameResolveTime > 1000) {
        session.lastNameResolveTime = now;
        const resolvedName = this.resolver.getName(id);
        if (resolvedName !== session.displayName) {
          session.displayName = resolvedName;
        }
      }

      if (session.deepgramSession) {
        session.deepgramSession.send(pcmBuffer);
      }
    } catch (err) {
      logger.error('Error handling binary audio chunk', { streamId: id, error: String(err) });
    }
  }

  /**
   * Create a ParticipantSession object synchronously (without the Deepgram
   * connection, which requires async setup).
   */
  private createSessionSync(csrcId: string): ParticipantSession {
    const displayName = this.resolver.getName(csrcId);

    logger.info('Creating new participant session', { streamId: csrcId, displayName });

    return {
      csrcId,
      displayName,
      deepgramSession: null,
      lastNonSilentTime: Date.now(),
      segments: [],
      isActive: true,
    };
  }

  /**
   * Asynchronously initialize the Deepgram live transcription session for a
   * given participant session.
   */
  private async initSessionAsync(session: ParticipantSession): Promise<void> {
    const provider = createTranscriptionProvider(TRANSCRIPTION_PROVIDER);

    if (!provider.supportsLiveTranscription() || !provider.startLiveTranscription) {
      throw new Error('Transcription provider does not support live transcription');
    }

    const liveSession = await provider.startLiveTranscription({
      model: 'nova-3',
      language: this.language,
      diarize: false,
      channels: 1,
      encoding: 'linear16',
      sampleRate: 16000,
    });

    liveSession.on('transcript', (segment: TranscriptSegment, isFinal: boolean) => {
      const taggedSegment: TranscriptSegment = {
        ...segment,
        speaker: session.displayName,
      };

      // Only persist final segments — interim results are partial and will
      // be superseded by the final result, causing duplicate text if kept.
      if (isFinal) {
        session.segments.push(taggedSegment);
      }
      this.emit('transcript', taggedSegment, isFinal);
    });

    liveSession.on('error', (error: Error) => {
      logger.warn('Deepgram session error (non-fatal)', {
        streamId: session.csrcId,
        error: String(error),
      });
      // Do NOT re-emit — unhandled 'error' events on EventEmitter crash the process.
      // Instead, mark the session as inactive so it can be re-created on the next chunk.
      session.isActive = false;
      session.deepgramSession = null;
      this.sessions.delete(session.csrcId);
    });

    liveSession.on('close', () => {
      logger.info('Deepgram session closed', { csrcId: session.csrcId });
      session.isActive = false;
      session.deepgramSession = null;
    });

    session.deepgramSession = liveSession;

    logger.info('Deepgram live session initialised', {
      streamId: session.csrcId,
      displayName: session.displayName,
    });
  }

  /**
   * Determine whether a PCM buffer is effectively silent.
   *
   * Computes the RMS of Int16 samples and compares the normalised value
   * (divided by 32768) against the threshold.
   */
  private isSilent(pcmBuffer: Buffer): boolean {
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    if (sampleCount === 0) return true;

    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2);
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    const normalizedRms = rms / 32768;

    return normalizedRms < SILENCE_RMS_THRESHOLD;
  }

  /**
   * If we have exceeded the maximum number of concurrent sessions, close the
   * one that has been silent the longest.
   */
  private enforceConcurrencyLimit(): void {
    if (this.sessions.size < this.maxConcurrentSessions) return;

    let oldestStreamId: string | null = null;
    let oldestTime = Infinity;

    for (const [streamId, session] of this.sessions) {
      if (session.lastNonSilentTime < oldestTime) {
        oldestTime = session.lastNonSilentTime;
        oldestStreamId = streamId;
      }
    }

    if (oldestStreamId) {
      const session = this.sessions.get(oldestStreamId);
      if (session) {
        logger.info('Closing oldest session to enforce concurrency limit', {
          streamId: oldestStreamId,
          displayName: session.displayName,
        });
        if (session.deepgramSession) {
          session.deepgramSession.close();
        }
        session.isActive = false;
        this.sessions.delete(oldestStreamId);
      }
    }
  }

  /**
   * Periodically check all sessions and close any that have been silent for
   * longer than the configured timeout.
   */
  private monitorSessions(): void {
    const now = Date.now();

    for (const [streamId, session] of this.sessions) {
      if (now - session.lastNonSilentTime > this.silenceTimeoutMs) {
        logger.info('Closing silent session', {
          streamId,
          displayName: session.displayName,
          silentForMs: now - session.lastNonSilentTime,
        });
        if (session.deepgramSession) {
          session.deepgramSession.close();
        }
        session.isActive = false;
        this.sessions.delete(streamId);
      }
    }
  }

  /**
   * Stop all sessions and return the complete set of transcript segments,
   * sorted by start time.
   */
  async stop(): Promise<TranscriptSegment[]> {
    this.isRunning = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    // Final name resolution pass — force-resolve all session names
    // to pick up any UserManager data that arrived after the last debounce.
    // This MUST happen before resolver.stop() which clears the page reference.
    for (const [id, session] of this.sessions) {
      const finalName = this.resolver.getName(id);
      if (finalName !== session.displayName) {
        logger.info('Final name resolve updated', {
          streamId: id,
          oldName: session.displayName,
          newName: finalName,
        });
        session.displayName = finalName;
      }
    }

    this.resolver.stop();

    // Collect all segments before closing sessions.
    const rawSegments: TranscriptSegment[] = [];

    for (const [, session] of this.sessions) {
      // Update speaker name on all segments to the latest resolved name
      const finalName = session.displayName;
      for (const seg of session.segments) {
        seg.speaker = finalName;
      }
      rawSegments.push(...session.segments);
      if (session.deepgramSession) {
        session.deepgramSession.close();
      }
      session.isActive = false;
    }

    this.sessions.clear();

    // Sort by time
    rawSegments.sort((a, b) => a.startTime - b.startTime);

    // Merge consecutive segments from the same speaker into paragraphs.
    // This prevents saccaded transcripts ("mayonnaise", "c'est", "et" as separate segments).
    const merged: TranscriptSegment[] = [];
    for (const seg of rawSegments) {
      const last = merged[merged.length - 1];
      // Merge if same speaker and gap < 5 seconds
      if (last && last.speaker === seg.speaker && seg.startTime - last.endTime < 5) {
        last.text = last.text + ' ' + seg.text;
        last.endTime = seg.endTime;
        // Average confidence
        last.confidence = last.confidence ? (last.confidence + (seg.confidence || 0)) / 2 : seg.confidence;
      } else {
        merged.push({ ...seg });
      }
    }

    logger.info('PerParticipantAudioManager stopped', {
      meetingId: this.meetingId,
      totalSegments: merged.length,
      rawSegments: rawSegments.length,
    });

    return merged;
  }
}
