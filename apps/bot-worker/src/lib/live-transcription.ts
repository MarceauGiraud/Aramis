/**
 * Live Transcription Manager
 *
 * Receives audio buffers from the RecordingOrchestrator's audio stream,
 * pipes them to a transcription provider's live session, and emits
 * real-time transcript events.
 *
 * Stores both interim and final results, and can flush the final
 * transcript to the database when the meeting ends.
 */

import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { logger } from './logger';
import {
  TranscriptionProvider,
  LiveTranscriptionSession,
  TranscriptSegment,
  LiveTranscriptionOptions,
} from './transcription/provider-interface';
import { createTranscriptionProvider } from './transcription/provider-factory';

export interface LiveTranscriptionConfig {
  /** Meeting ID for database storage */
  meetingId: string;
  /** Transcription provider name (default: 'deepgram') */
  providerName?: string;
  /** Audio sample rate (default: 16000) */
  sampleRate?: number;
  /** Audio encoding (default: 'linear16') */
  encoding?: 'linear16' | 'opus' | 'flac';
  /** Language code */
  language?: string;
  /** Whether to return interim results (default: true) */
  interimResults?: boolean;
}

export class LiveTranscriptionManager extends EventEmitter {
  private config: LiveTranscriptionConfig;
  private provider: TranscriptionProvider | null = null;
  private session: LiveTranscriptionSession | null = null;
  private finalSegments: TranscriptSegment[] = [];
  private isRunning = false;
  private audioStream: Readable | null = null;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly RECONNECT_BACKOFF_MS = [1000, 2000, 4000];
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private lastAudioSentAt = 0;

  constructor(config: LiveTranscriptionConfig) {
    super();
    this.config = {
      sampleRate: 16000,
      encoding: 'linear16',
      interimResults: true,
      ...config,
    };
  }

  /**
   * Start live transcription with the configured provider.
   * Optionally pipe from a Readable audio stream.
   */
  async start(audioStream?: Readable): Promise<void> {
    if (this.isRunning) {
      logger.warn('Live transcription already running');
      return;
    }

    const providerName = this.config.providerName || 'deepgram';
    logger.info(`Starting live transcription with provider: ${providerName}`);

    try {
      this.provider = createTranscriptionProvider(providerName);

      if (!this.provider.supportsLiveTranscription()) {
        throw new Error(`Provider ${providerName} does not support live transcription`);
      }

      const options: LiveTranscriptionOptions = {
        sampleRate: this.config.sampleRate,
        encoding: this.config.encoding,
        language: this.config.language,
        channels: 1,
        interimResults: this.config.interimResults,
      };

      this.session = await this.provider.startLiveTranscription!(options);
      this.isRunning = true;

      // Handle transcript events
      this.session.on('transcript', (segment: TranscriptSegment, isFinal: boolean) => {
        if (isFinal) {
          this.finalSegments.push(segment);
        }

        // Emit for external consumers (WebSocket, webhook dispatcher, etc.)
        this.emit('transcript', segment, isFinal);
      });

      this.session.on('error', (error: Error) => {
        logger.error(`Live transcription error: ${error.message}`);
        this.emit('error', error);
      });

      this.session.on('close', () => {
        if (this.isRunning) {
          // Unexpected close — attempt reconnection
          logger.warn('Live transcription session closed unexpectedly, attempting reconnect');
          this.attemptReconnect();
        } else {
          logger.info('Live transcription session closed');
          this.emit('close');
        }
      });

      // If an audio stream is provided, pipe it to the session
      if (audioStream) {
        this.pipeAudioStream(audioStream);
      }

      // Start keep-alive interval to prevent Deepgram from closing the
      // connection during silence. Every 8 seconds, if no audio has been
      // sent recently, send a small silent PCM buffer to keep the WebSocket alive.
      this.startKeepAlive();

      logger.info('Live transcription started');
    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Send raw audio data to the transcription session.
   */
  sendAudio(audioData: Buffer): void {
    if (!this.session || !this.isRunning) {
      return;
    }
    this.lastAudioSentAt = Date.now();
    this.session.send(audioData);
  }

  /**
   * Pipe a Readable stream of PCM audio data to the transcription session.
   */
  pipeAudioStream(stream: Readable): void {
    this.audioStream = stream;
    let chunksReceived = 0;

    stream.on('data', (chunk: Buffer) => {
      chunksReceived++;
      if (chunksReceived === 1) {
        logger.info(`Live transcription: first audio chunk received from stream (${chunk.byteLength} bytes)`);
      }
      this.sendAudio(chunk);
    });

    stream.on('end', () => {
      logger.info(`Audio stream ended after ${chunksReceived} chunks`);
    });

    stream.on('error', (error) => {
      logger.error(`Audio stream error: ${error.message}`);
      this.emit('error', error);
    });
  }

  /**
   * Start a keep-alive interval that sends silent PCM data when no audio
   * has been sent for 8 seconds. This prevents Deepgram from closing the
   * WebSocket connection during periods of silence.
   */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    const KEEP_ALIVE_INTERVAL_MS = 8000;
    const SILENCE_BUFFER = Buffer.alloc(256, 0); // 256 bytes of silent PCM

    this.keepAliveInterval = setInterval(() => {
      if (!this.session || !this.isRunning) return;

      const elapsed = Date.now() - this.lastAudioSentAt;
      if (elapsed >= KEEP_ALIVE_INTERVAL_MS) {
        logger.debug('Sending keep-alive silence to Deepgram');
        this.session.send(SILENCE_BUFFER);
      }
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  /**
   * Stop the keep-alive interval.
   */
  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  /**
   * Stop live transcription and close the session.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.session) {
      return;
    }

    logger.info('Stopping live transcription');
    this.stopKeepAlive();
    this.session.close();
    this.isRunning = false;
  }

  /**
   * Attempt to reconnect the live transcription session after an unexpected close.
   * Uses exponential backoff: 1s, 2s, 4s. Max 3 attempts.
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= LiveTranscriptionManager.MAX_RECONNECT_ATTEMPTS) {
      logger.error(`Live transcription reconnect failed after ${this.reconnectAttempts} attempts, giving up`);
      this.isRunning = false;
      this.emit('close');
      return;
    }

    const backoffMs = LiveTranscriptionManager.RECONNECT_BACKOFF_MS[this.reconnectAttempts] ?? 4000;
    this.reconnectAttempts++;

    logger.info(
      `Live transcription reconnect attempt ${this.reconnectAttempts}/${LiveTranscriptionManager.MAX_RECONNECT_ATTEMPTS} in ${backoffMs}ms`,
    );

    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    // Guard: stop() may have been called during the backoff wait
    if (!this.isRunning) return;

    try {
      const providerName = this.config.providerName || 'deepgram';
      this.provider = createTranscriptionProvider(providerName);

      const options: LiveTranscriptionOptions = {
        sampleRate: this.config.sampleRate,
        encoding: this.config.encoding,
        language: this.config.language,
        channels: 1,
        interimResults: this.config.interimResults,
      };

      this.session = await this.provider.startLiveTranscription!(options);

      // Re-attach event handlers
      this.session.on('transcript', (segment: TranscriptSegment, isFinal: boolean) => {
        if (isFinal) {
          this.finalSegments.push(segment);
        }
        this.emit('transcript', segment, isFinal);
      });

      this.session.on('error', (error: Error) => {
        logger.error(`Live transcription error: ${error.message}`);
        this.emit('error', error);
      });

      this.session.on('close', () => {
        if (this.isRunning) {
          logger.warn('Live transcription session closed unexpectedly, attempting reconnect');
          this.attemptReconnect();
        } else {
          logger.info('Live transcription session closed');
          this.emit('close');
        }
      });

      // Re-pipe the audio stream if we had one (the stream is still emitting data)
      // Note: we don't call pipeAudioStream again because the existing 'data'
      // listeners on the stream already call sendAudio(), which uses this.session.
      this.reconnectAttempts = 0;
      logger.info('Live transcription reconnected successfully');
    } catch (error) {
      logger.error(`Live transcription reconnect attempt failed: ${error}`);
      this.attemptReconnect();
    }
  }

  /**
   * Get all final segments collected so far.
   */
  getFinalSegments(): TranscriptSegment[] {
    return [...this.finalSegments];
  }

  /**
   * Get unique speakers with aggregated stats derived from final segments.
   */
  getSpeakers(): Array<{ id: string; label: string; totalDuration: number; segmentCount: number }> {
    const speakerMap = new Map<string, { totalDuration: number; segmentCount: number }>();
    for (const seg of this.finalSegments) {
      const label = seg.speaker || 'Unknown';
      const existing = speakerMap.get(label) || { totalDuration: 0, segmentCount: 0 };
      existing.totalDuration += seg.endTime - seg.startTime;
      existing.segmentCount++;
      speakerMap.set(label, existing);
    }
    return Array.from(speakerMap.entries()).map(([label, stats]) => ({
      id: label,
      label,
      totalDuration: stats.totalDuration,
      segmentCount: stats.segmentCount,
    }));
  }

  /**
   * Whether the manager is currently running.
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }
}
