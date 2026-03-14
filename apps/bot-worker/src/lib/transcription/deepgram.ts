import { createClient, DeepgramClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { logger } from '../logger';
import {
  TranscriptionProvider,
  TranscribeOptions,
  TranscriptionResult,
  TranscriptSegment,
  TranscriptWord,
  LiveTranscriptionSession,
  LiveTranscriptionOptions,
} from './provider-interface';

// Re-export shared types for backward compatibility
export type { TranscriptSegment, TranscriptWord, TranscriptionResult };

export interface DeepgramConfig {
  apiKey: string;
  model?: 'nova-2' | 'nova' | 'enhanced' | 'base';
  language?: string;
  diarize?: boolean;
  punctuate?: boolean;
  utterances?: boolean;
}

/**
 * Deepgram transcription provider.
 *
 * Supports both batch transcription (from URL or file) and live streaming transcription.
 * Implements the TranscriptionProvider interface for use with the provider factory.
 *
 * Also extends EventEmitter for backward compatibility with existing code that
 * listens to events directly on the service instance.
 */
export class DeepgramTranscriptionService extends EventEmitter implements TranscriptionProvider {
  readonly name = 'deepgram';
  private client: DeepgramClient;
  private config: DeepgramConfig;

  constructor(config?: Partial<DeepgramConfig>) {
    super();
    this.config = {
      apiKey: config?.apiKey || process.env.DEEPGRAM_API_KEY || '',
      model: config?.model || 'nova-2',
      language: config?.language || 'en',
      diarize: config?.diarize ?? true,
      punctuate: config?.punctuate ?? true,
      utterances: config?.utterances ?? true,
    };

    this.client = createClient(this.config.apiKey);
  }

  /**
   * Whether this provider supports live transcription
   */
  supportsLiveTranscription(): boolean {
    return true;
  }

  /**
   * Transcribe an audio file
   */
  async transcribeFile(audioPath: string, options?: TranscribeOptions): Promise<TranscriptionResult> {
    logger.info(`Transcribing file: ${audioPath}`);

    const audioBuffer = fs.readFileSync(audioPath);

    const { result, error } = await this.client.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: (options?.model as DeepgramConfig['model']) || this.config.model,
        language: options?.language || this.config.language,
        diarize: options?.diarize ?? this.config.diarize,
        punctuate: this.config.punctuate,
        utterances: this.config.utterances,
        smart_format: true,
      }
    );

    if (error) {
      throw new Error(`Transcription failed: ${error.message}`);
    }

    return this.parseResult(result);
  }

  /**
   * Transcribe from URL
   */
  async transcribeUrl(audioUrl: string, options?: TranscribeOptions): Promise<TranscriptionResult> {
    logger.info(`Transcribing URL: ${audioUrl}`);

    const { result, error } = await this.client.listen.prerecorded.transcribeUrl(
      { url: audioUrl },
      {
        model: (options?.model as DeepgramConfig['model']) || this.config.model,
        language: options?.language || this.config.language,
        diarize: options?.diarize ?? this.config.diarize,
        punctuate: this.config.punctuate,
        utterances: this.config.utterances,
        smart_format: true,
      }
    );

    if (error) {
      throw new Error(`Transcription failed: ${error.message}`);
    }

    return this.parseResult(result);
  }

  /**
   * Start live transcription session implementing LiveTranscriptionSession interface
   */
  async startLiveTranscription(options?: LiveTranscriptionOptions): Promise<LiveTranscriptionSession> {
    const connection = this.client.listen.live({
      model: (options?.model as DeepgramConfig['model']) || this.config.model,
      language: options?.language || this.config.language,
      diarize: options?.diarize ?? this.config.diarize,
      punctuate: this.config.punctuate,
      interim_results: options?.interimResults ?? true,
      utterance_end_ms: 1000,
      vad_events: true,
      encoding: options?.encoding || 'linear16',
      sample_rate: options?.sampleRate || 16000,
      channels: options?.channels || 1,
    });

    const session = new EventEmitter() as EventEmitter & LiveTranscriptionSession;

    // Implement send and close
    session.send = (audioData: Buffer) => {
      connection.send(audioData);
    };

    session.close = () => {
      connection.finish();
    };

    connection.on(LiveTranscriptionEvents.Open, () => {
      logger.info('Deepgram live connection opened');
      this.emit('open');
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0];
      if (transcript && transcript.transcript) {
        const segment: TranscriptSegment = {
          text: transcript.transcript,
          startTime: data.start || 0,
          endTime: (data.start || 0) + (data.duration || 0),
          confidence: transcript.confidence || 0,
          speaker: data.channel?.alternatives?.[0]?.words?.[0]?.speaker?.toString(),
          words: (transcript.words || []).map((w: any) => ({
            text: w.word,
            startTime: w.start,
            endTime: w.end,
            confidence: w.confidence,
          })),
        };

        session.emit('transcript', segment, data.is_final);
        // Also emit on the service for backward compatibility
        this.emit('transcript', segment, data.is_final);
      }
    });

    connection.on(LiveTranscriptionEvents.Error, (error) => {
      logger.error('Deepgram error:', error);
      session.emit('error', error instanceof Error ? error : new Error(String(error)));
      this.emit('error', error);
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      logger.info('Deepgram connection closed');
      session.emit('close');
      this.emit('close');
    });

    return session;
  }

  /**
   * Parse Deepgram result into our format
   */
  private parseResult(result: any): TranscriptionResult {
    const channel = result.results?.channels?.[0];
    const alternatives = channel?.alternatives || [];
    const firstAlt = alternatives[0] || {};

    const segments: TranscriptSegment[] = [];
    const speakerSet = new Set<string>();
    let totalConfidence = 0;
    let segmentCount = 0;

    // If utterances are available, use them
    if (result.results?.utterances) {
      for (const utterance of result.results.utterances) {
        const speaker = utterance.speaker !== undefined
          ? `Speaker ${utterance.speaker + 1}`
          : undefined;

        if (speaker) speakerSet.add(speaker);

        segments.push({
          text: utterance.transcript,
          startTime: utterance.start,
          endTime: utterance.end,
          confidence: utterance.confidence,
          speaker,
          words: (utterance.words || []).map((w: any) => ({
            text: w.word || w.punctuated_word,
            startTime: w.start,
            endTime: w.end,
            confidence: w.confidence,
          })),
        });

        totalConfidence += utterance.confidence;
        segmentCount++;
      }
    } else {
      // Fall back to words
      const words = firstAlt.words || [];
      let currentSegment: TranscriptSegment | null = null;

      for (const word of words) {
        const speaker = word.speaker !== undefined
          ? `Speaker ${word.speaker + 1}`
          : undefined;

        if (speaker) speakerSet.add(speaker);

        if (!currentSegment || currentSegment.speaker !== speaker) {
          if (currentSegment) {
            segments.push(currentSegment);
            totalConfidence += currentSegment.confidence || 0;
            segmentCount++;
          }

          currentSegment = {
            text: word.word || word.punctuated_word,
            startTime: word.start,
            endTime: word.end,
            confidence: word.confidence,
            speaker,
            words: [{
              text: word.word || word.punctuated_word,
              startTime: word.start,
              endTime: word.end,
              confidence: word.confidence,
            }],
          };
        } else {
          currentSegment.text += ' ' + (word.word || word.punctuated_word);
          currentSegment.endTime = word.end;
          currentSegment.words!.push({
            text: word.word || word.punctuated_word,
            startTime: word.start,
            endTime: word.end,
            confidence: word.confidence,
          });
        }
      }

      if (currentSegment) {
        segments.push(currentSegment);
        totalConfidence += currentSegment.confidence || 0;
        segmentCount++;
      }
    }

    const duration = result.metadata?.duration || 0;
    const language = result.results?.channels?.[0]?.detected_language || this.config.language || 'en';

    return {
      segments,
      fullText: firstAlt.transcript || segments.map(s => s.text).join(' '),
      duration,
      language,
      speakers: Array.from(speakerSet),
    };
  }
}

// Export singleton factory
export function createDeepgramService(config?: Partial<DeepgramConfig>): DeepgramTranscriptionService {
  return new DeepgramTranscriptionService(config);
}
