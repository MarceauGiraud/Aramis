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
  model?: 'nova-3' | 'nova-2' | 'nova' | 'enhanced' | 'base';
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
      model: config?.model || 'nova-3',
      language: config?.language || undefined,
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

    const { result, error } = await this.client.listen.prerecorded.transcribeFile(audioBuffer, {
      model: (options?.model as DeepgramConfig['model']) || this.config.model,
      language: options?.language || this.config.language,
      diarize: options?.diarize ?? this.config.diarize,
      punctuate: this.config.punctuate,
      utterances: this.config.utterances,
      smart_format: true,
    });

    if (error) {
      throw new Error(`Transcription failed: ${error.message}`);
    }

    return this.parseResult(result);
  }

  /**
   * Transcribe from URL
   */
  async transcribeUrl(audioUrl: string, options?: TranscribeOptions): Promise<TranscriptionResult> {
    // If the URL is an internal s3:// URL, convert to a presigned HTTP URL
    // so Deepgram can access it.
    let resolvedUrl = audioUrl;
    if (audioUrl.startsWith('s3://')) {
      try {
        const { getPresignedUrl } = await import('../storage');
        const key = audioUrl.slice(5); // remove "s3://"
        const slashIndex = key.indexOf('/');
        const objectKey = slashIndex !== -1 ? key.slice(slashIndex + 1) : key;
        resolvedUrl = await getPresignedUrl(objectKey);
        logger.info(`Resolved s3:// URL to presigned URL for Deepgram`);
      } catch (err) {
        logger.warn(`Failed to resolve s3:// URL, using as-is: ${err}`);
      }
    }

    logger.info(`Transcribing URL: ${resolvedUrl.substring(0, 80)}...`);

    // Build batch options — for batch, use detect_language=true instead of language='multi'
    const batchOptions: Record<string, any> = {
      model: (options?.model as DeepgramConfig['model']) || this.config.model,
      diarize: options?.diarize ?? this.config.diarize,
      punctuate: this.config.punctuate,
      utterances: this.config.utterances,
      paragraphs: true,
      smart_format: true,
    };

    const lang = options?.language || this.config.language;
    if (!lang || lang === 'multi' || lang === 'detect') {
      batchOptions.detect_language = true;
    } else {
      batchOptions.language = lang;
    }

    const { result, error } = await this.client.listen.prerecorded.transcribeUrl({ url: resolvedUrl }, batchOptions);

    if (error) {
      throw new Error(`Transcription failed: ${error.message}`);
    }

    return this.parseResult(result);
  }

  /**
   * Start live transcription session implementing LiveTranscriptionSession interface
   */
  async startLiveTranscription(options?: LiveTranscriptionOptions): Promise<LiveTranscriptionSession> {
    const lang = options?.language || this.config.language;
    const model = (options?.model as DeepgramConfig['model']) || this.config.model || 'nova-3';

    // Build live transcription options. If no explicit language is provided,
    // use Deepgram's automatic language detection instead of hardcoding French.
    const liveOptions: Record<string, any> = {
      model,
      diarize: options?.diarize ?? this.config.diarize,
      punctuate: this.config.punctuate,
      interim_results: options?.interimResults ?? true,
      utterance_end_ms: 1000,
      vad_events: true,
      encoding: options?.encoding || 'linear16',
      sample_rate: options?.sampleRate || 16000,
      channels: options?.channels || 1,
    };

    if (lang && lang !== 'multi' && lang !== 'detect') {
      liveOptions.language = lang;
    } else {
      liveOptions.detect_language = true;
    }

    const connection = this.client.listen.live(liveOptions as any);

    const session = new EventEmitter() as EventEmitter & LiveTranscriptionSession;

    let connectionReady = false;
    let bytesSent = 0;
    let chunksSent = 0;

    // Implement send and close
    session.send = (audioData: Buffer) => {
      if (!connectionReady) {
        // Drop audio data until the WebSocket is open - the Deepgram SDK's
        // internal sendBuffer is never flushed, so buffering here is pointless
        return;
      }
      bytesSent += audioData.byteLength;
      chunksSent++;
      if (chunksSent === 1) {
        logger.info(`Deepgram: first audio chunk sent (${audioData.byteLength} bytes)`);
      } else if (chunksSent % 500 === 0) {
        logger.info(`Deepgram: sent ${chunksSent} chunks, ${(bytesSent / 1024).toFixed(0)} KB total`);
      }
      // Send as ArrayBuffer — copy into a correctly-sized ArrayBuffer to avoid
      // Node.js Buffer pool issues where .buffer is larger than the actual data
      const ab = audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength);
      connection.send(ab);
    };

    session.close = () => {
      logger.info(`Deepgram: closing connection after ${chunksSent} chunks, ${(bytesSent / 1024).toFixed(0)} KB total`);
      connection.requestClose();
    };

    // Set up all event handlers before waiting for the connection to open
    connection.on(LiveTranscriptionEvents.Open, () => {
      connectionReady = true;
      logger.info('Deepgram live connection opened and ready to receive audio');
      this.emit('open');
    });

    // Log ALL Deepgram events for diagnostics
    connection.on(LiveTranscriptionEvents.Metadata, (data) => {
      logger.info(`Deepgram metadata: requestId=${data.request_id}, model=${data.model_info?.name}`);
    });
    connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      logger.debug('Deepgram: speech detected');
    });
    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      logger.debug('Deepgram: utterance ended');
    });
    connection.on(LiveTranscriptionEvents.Unhandled, (data) => {
      logger.warn(`Deepgram unhandled event: ${JSON.stringify(data).substring(0, 200)}`);
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0];
      const text = transcript?.transcript || '';
      if (text) {
        logger.info(
          `Deepgram transcript: is_final=${data.is_final}, speech_final=${data.speech_final}, text="${text.substring(0, 100)}", confidence=${transcript?.confidence || 0}`,
        );
      } else {
        logger.debug(`Deepgram empty transcript event: is_final=${data.is_final}, speech_final=${data.speech_final}`);
      }
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
      // Do NOT emit 'error' on the session EventEmitter — if no listener is
      // attached, Node.js treats unhandled 'error' events as fatal exceptions
      // and crashes the entire process. We log the error above instead.
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      connectionReady = false;
      logger.info('Deepgram connection closed');
      session.emit('close');
      this.emit('close');
    });

    // Wait for the WebSocket connection to actually open before returning.
    // The Deepgram SDK's internal sendBuffer is never flushed, so data sent
    // before the connection opens is permanently lost. By awaiting here, we
    // ensure pipeAudioStream() is only called after the connection is ready.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Deepgram WebSocket connection timed out after 10s'));
      }, 10000);

      if (connectionReady) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      // The Open event was already registered above and sets connectionReady=true.
      // Listen for it again here just to resolve this promise.
      connection.once(LiveTranscriptionEvents.Open, () => {
        clearTimeout(timeout);
        resolve();
      });

      connection.once(LiveTranscriptionEvents.Error, (error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
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

    // Prefer paragraphs (grouped by speaker) over raw utterances
    const paragraphs = firstAlt.paragraphs?.paragraphs;
    if (paragraphs && paragraphs.length > 0) {
      for (const para of paragraphs) {
        const speaker = para.speaker !== undefined ? `Speaker ${para.speaker + 1}` : undefined;

        if (speaker) speakerSet.add(speaker);

        const text = (para.sentences || []).map((s: any) => s.text).join(' ');

        segments.push({
          text,
          startTime: para.start,
          endTime: para.end,
          confidence: firstAlt.confidence || 0,
          speaker,
        });

        totalConfidence += firstAlt.confidence || 0;
        segmentCount++;
      }
    } else if (result.results?.utterances) {
      // Fall back to utterances
      for (const utterance of result.results.utterances) {
        const speaker = utterance.speaker !== undefined ? `Speaker ${utterance.speaker + 1}` : undefined;

        if (speaker) speakerSet.add(speaker);

        segments.push({
          text: utterance.transcript,
          startTime: utterance.start,
          endTime: utterance.end,
          confidence: utterance.confidence,
          speaker,
        });

        totalConfidence += utterance.confidence;
        segmentCount++;
      }
    } else {
      // Fall back to words
      const words = firstAlt.words || [];
      let currentSegment: TranscriptSegment | null = null;

      for (const word of words) {
        const speaker = word.speaker !== undefined ? `Speaker ${word.speaker + 1}` : undefined;

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
            words: [
              {
                text: word.word || word.punctuated_word,
                startTime: word.start,
                endTime: word.end,
                confidence: word.confidence,
              },
            ],
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
      fullText: firstAlt.transcript || segments.map((s) => s.text).join(' '),
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
