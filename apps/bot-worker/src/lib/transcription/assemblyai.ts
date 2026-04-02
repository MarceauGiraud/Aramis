/**
 * AssemblyAI Transcription Provider
 *
 * Supports both batch transcription (from URL) and live/streaming transcription.
 *
 * NOTE: Requires the `assemblyai` npm package to be installed:
 *   pnpm --filter @aramis/bot-worker add assemblyai
 *
 * Set ASSEMBLYAI_API_KEY environment variable.
 */

import { EventEmitter } from 'events';
import { logger } from '../logger';
import {
  TranscriptionProvider,
  TranscribeOptions,
  TranscriptionResult,
  TranscriptSegment,
  LiveTranscriptionSession,
  LiveTranscriptionOptions,
} from './provider-interface';

// AssemblyAI SDK types - imported dynamically to avoid errors if package not installed
type AssemblyAIClient = any;

export interface AssemblyAIConfig {
  apiKey: string;
  model?: string;
  language?: string;
}

export class AssemblyAITranscriptionProvider implements TranscriptionProvider {
  readonly name = 'assemblyai';
  private config: AssemblyAIConfig;
  private client: AssemblyAIClient | null = null;

  constructor(config?: Partial<AssemblyAIConfig>) {
    this.config = {
      apiKey: config?.apiKey || process.env.ASSEMBLYAI_API_KEY || '',
      model: config?.model,
      language: config?.language || 'en',
    };
  }

  /**
   * Lazily initialize the AssemblyAI client.
   * This avoids import errors if the package is not installed.
   */
  private async getClient(): Promise<AssemblyAIClient> {
    if (this.client) return this.client;

    try {
      // @ts-ignore - assemblyai is an optional dependency
      const assemblyai = await import('assemblyai');
      this.client = new assemblyai.AssemblyAI({ apiKey: this.config.apiKey });
      return this.client;
    } catch (error) {
      throw new Error(
        'AssemblyAI SDK is not installed. Install it with: pnpm --filter @aramis/bot-worker add assemblyai',
      );
    }
  }

  supportsLiveTranscription(): boolean {
    return true;
  }

  /**
   * Transcribe audio from a URL using AssemblyAI batch API.
   */
  async transcribeUrl(audioUrl: string, options?: TranscribeOptions): Promise<TranscriptionResult> {
    logger.info(`AssemblyAI transcription from URL: ${audioUrl}`);

    const client = await this.getClient();

    const params: Record<string, any> = {
      audio_url: audioUrl,
      speaker_labels: options?.diarize ?? true,
      language_code: options?.language || this.config.language || 'en',
    };

    if (options?.model) {
      params.speech_model = options.model;
    }

    const transcript = await client.transcripts.transcribe(params);

    if (transcript.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
    }

    return this.parseResult(transcript);
  }

  /**
   * Transcribe audio from a local file path.
   * Uploads the file to AssemblyAI first, then transcribes.
   */
  async transcribeFile(audioPath: string, options?: TranscribeOptions): Promise<TranscriptionResult> {
    logger.info(`AssemblyAI transcription from file: ${audioPath}`);

    const client = await this.getClient();

    const params: Record<string, any> = {
      audio: audioPath,
      speaker_labels: options?.diarize ?? true,
      language_code: options?.language || this.config.language || 'en',
    };

    if (options?.model) {
      params.speech_model = options.model;
    }

    const transcript = await client.transcripts.transcribe(params);

    if (transcript.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
    }

    return this.parseResult(transcript);
  }

  /**
   * Start a live transcription session using AssemblyAI's real-time API.
   */
  async startLiveTranscription(options?: LiveTranscriptionOptions): Promise<LiveTranscriptionSession> {
    logger.info('Starting AssemblyAI live transcription');

    const client = await this.getClient();

    const realtimeParams: Record<string, any> = {
      sample_rate: options?.sampleRate || 16000,
      encoding: this.mapEncoding(options?.encoding),
    };

    const rt = client.realtime.transcriber(realtimeParams);

    const session = new EventEmitter() as EventEmitter & LiveTranscriptionSession;

    // Implement send and close
    session.send = (audioData: Buffer) => {
      rt.sendAudio(audioData);
    };

    session.close = () => {
      rt.close();
    };

    // Handle real-time transcript events
    rt.on('transcript', (data: any) => {
      if (!data.text) return;

      const segment: TranscriptSegment = {
        text: data.text,
        startTime: (data.audio_start || 0) / 1000, // Convert ms to seconds
        endTime: (data.audio_end || 0) / 1000,
        confidence: data.confidence,
        words: (data.words || []).map((w: any) => ({
          text: w.text,
          startTime: (w.start || 0) / 1000,
          endTime: (w.end || 0) / 1000,
          confidence: w.confidence,
        })),
      };

      const isFinal = data.message_type === 'FinalTranscript';
      session.emit('transcript', segment, isFinal);
    });

    rt.on('error', (error: any) => {
      logger.error('AssemblyAI real-time error:', error);
      session.emit('error', error instanceof Error ? error : new Error(String(error)));
    });

    rt.on('close', () => {
      logger.info('AssemblyAI real-time connection closed');
      session.emit('close');
    });

    // Connect to AssemblyAI real-time service
    await rt.connect();

    return session;
  }

  /**
   * Map our encoding format to AssemblyAI's expected format.
   */
  private mapEncoding(encoding?: string): string {
    switch (encoding) {
      case 'linear16':
        return 'pcm_s16le';
      case 'opus':
        return 'opus';
      case 'flac':
        return 'flac';
      default:
        return 'pcm_s16le';
    }
  }

  /**
   * Parse AssemblyAI transcript result into our common format.
   */
  private parseResult(transcript: any): TranscriptionResult {
    const segments: TranscriptSegment[] = [];
    const speakerSet = new Set<string>();

    // Use utterances if available (with speaker labels)
    if (transcript.utterances && Array.isArray(transcript.utterances)) {
      for (const utterance of transcript.utterances) {
        const speaker = utterance.speaker ? `Speaker ${utterance.speaker}` : undefined;
        if (speaker) speakerSet.add(speaker);

        segments.push({
          text: utterance.text,
          startTime: (utterance.start || 0) / 1000,
          endTime: (utterance.end || 0) / 1000,
          confidence: utterance.confidence,
          speaker,
          words: (utterance.words || []).map((w: any) => ({
            text: w.text,
            startTime: (w.start || 0) / 1000,
            endTime: (w.end || 0) / 1000,
            confidence: w.confidence,
          })),
        });
      }
    } else if (transcript.words && Array.isArray(transcript.words)) {
      // Fall back to building segments from words
      let currentSegment: TranscriptSegment | null = null;

      for (const word of transcript.words) {
        const speaker = word.speaker ? `Speaker ${word.speaker}` : undefined;
        if (speaker) speakerSet.add(speaker);

        if (!currentSegment || currentSegment.speaker !== speaker) {
          if (currentSegment) {
            segments.push(currentSegment);
          }

          currentSegment = {
            text: word.text,
            startTime: (word.start || 0) / 1000,
            endTime: (word.end || 0) / 1000,
            confidence: word.confidence,
            speaker,
            words: [
              {
                text: word.text,
                startTime: (word.start || 0) / 1000,
                endTime: (word.end || 0) / 1000,
                confidence: word.confidence,
              },
            ],
          };
        } else {
          currentSegment.text += ' ' + word.text;
          currentSegment.endTime = (word.end || 0) / 1000;
          currentSegment.words!.push({
            text: word.text,
            startTime: (word.start || 0) / 1000,
            endTime: (word.end || 0) / 1000,
            confidence: word.confidence,
          });
        }
      }

      if (currentSegment) {
        segments.push(currentSegment);
      }
    }

    return {
      segments,
      speakers: Array.from(speakerSet),
      language: transcript.language_code,
      duration: transcript.audio_duration,
      fullText: transcript.text || segments.map((s) => s.text).join(' '),
    };
  }
}

export function createAssemblyAIProvider(config?: Partial<AssemblyAIConfig>): AssemblyAITranscriptionProvider {
  return new AssemblyAITranscriptionProvider(config);
}
