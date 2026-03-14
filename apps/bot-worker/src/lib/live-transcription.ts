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
import { prisma } from '@aramis/database';
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
        logger.info('Live transcription session closed');
        this.isRunning = false;
        this.emit('close');
      });

      // If an audio stream is provided, pipe it to the session
      if (audioStream) {
        this.pipeAudioStream(audioStream);
      }

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
    this.session.send(audioData);
  }

  /**
   * Pipe a Readable stream of PCM audio data to the transcription session.
   */
  pipeAudioStream(stream: Readable): void {
    stream.on('data', (chunk: Buffer) => {
      this.sendAudio(chunk);
    });

    stream.on('end', () => {
      logger.info('Audio stream ended');
    });

    stream.on('error', (error) => {
      logger.error(`Audio stream error: ${error.message}`);
      this.emit('error', error);
    });
  }

  /**
   * Stop live transcription and close the session.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.session) {
      return;
    }

    logger.info('Stopping live transcription');
    this.session.close();
    this.isRunning = false;
  }

  /**
   * Flush all final transcript segments to the database.
   * Creates a Transcript record with all segments, speakers, and words.
   */
  async flushToDatabase(): Promise<string | null> {
    if (this.finalSegments.length === 0) {
      logger.info('No transcript segments to flush');
      return null;
    }

    logger.info(`Flushing ${this.finalSegments.length} segments to database`);

    try {
      const providerName = this.config.providerName || 'deepgram';

      // Collect unique speakers
      const speakerLabels = new Set<string>();
      for (const seg of this.finalSegments) {
        if (seg.speaker) speakerLabels.add(seg.speaker);
      }

      // Build full text
      const fullText = this.finalSegments.map(s => s.text).join(' ');

      // Create transcript
      const transcript = await prisma.transcript.create({
        data: {
          meetingId: this.config.meetingId,
          status: 'COMPLETED',
          provider: providerName,
          fullText,
          wordCount: fullText.split(/\s+/).length,
          language: this.config.language,
          processedAt: new Date(),
        },
      });

      // Create speakers
      const speakerMap = new Map<string, string>();
      for (const label of speakerLabels) {
        const speaker = await prisma.transcriptSpeaker.create({
          data: {
            transcriptId: transcript.id,
            label,
            segmentCount: this.finalSegments.filter(s => s.speaker === label).length,
            totalDuration: this.finalSegments
              .filter(s => s.speaker === label)
              .reduce((sum, s) => sum + (s.endTime - s.startTime), 0),
          },
        });
        speakerMap.set(label, speaker.id);
      }

      // Create segments
      for (let i = 0; i < this.finalSegments.length; i++) {
        const seg = this.finalSegments[i];
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

      logger.info(`Transcript flushed to database: ${transcript.id}`);
      return transcript.id;
    } catch (error) {
      logger.error(`Failed to flush transcript to database: ${error}`);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Get all final segments collected so far.
   */
  getFinalSegments(): TranscriptSegment[] {
    return [...this.finalSegments];
  }

  /**
   * Whether the manager is currently running.
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }
}
