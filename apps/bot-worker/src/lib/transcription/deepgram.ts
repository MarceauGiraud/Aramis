import { createClient, DeepgramClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { logger } from '../logger';

export interface TranscriptSegment {
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
  speaker?: string;
  words: TranscriptWord[];
}

export interface TranscriptWord {
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
}

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  fullText: string;
  duration: number;
  language: string;
  speakers: string[];
  confidence: number;
}

export interface DeepgramConfig {
  apiKey: string;
  model?: 'nova-2' | 'nova' | 'enhanced' | 'base';
  language?: string;
  diarize?: boolean;
  punctuate?: boolean;
  utterances?: boolean;
}

export class DeepgramTranscriptionService extends EventEmitter {
  private client: DeepgramClient;
  private config: DeepgramConfig;

  constructor(config?: Partial<DeepgramConfig>) {
    super();
    this.config = {
      apiKey: config?.apiKey || process.env.DEEPGRAM_API_KEY || '',
      model: config?.model || 'nova-2',
      language: config?.language || 'multi',
      diarize: config?.diarize ?? true,
      punctuate: config?.punctuate ?? true,
      utterances: config?.utterances ?? true,
    };

    this.client = createClient(this.config.apiKey);
  }

  /**
   * Transcribe an audio file
   */
  async transcribeFile(audioPath: string): Promise<TranscriptionResult> {
    logger.info(`Transcribing file: ${audioPath}`);

    const audioBuffer = fs.readFileSync(audioPath);

    const { result, error } = await this.client.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: this.config.model,
        language: this.config.language,
        detect_language: true,
        diarize: this.config.diarize,
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
  async transcribeUrl(audioUrl: string): Promise<TranscriptionResult> {
    logger.info(`Transcribing URL: ${audioUrl}`);

    const { result, error } = await this.client.listen.prerecorded.transcribeUrl(
      { url: audioUrl },
      {
        model: this.config.model,
        language: this.config.language,
        detect_language: true,
        diarize: this.config.diarize,
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
   * Start live transcription
   */
  async startLiveTranscription(): Promise<{
    send: (audioData: Buffer) => void;
    close: () => void;
  }> {
    const connection = this.client.listen.live({
      model: this.config.model,
      language: this.config.language,
      diarize: this.config.diarize,
      punctuate: this.config.punctuate,
      interim_results: true,
      utterance_end_ms: 1000,
      vad_events: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
    });

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

        this.emit('transcript', segment, data.is_final);
      }
    });

    connection.on(LiveTranscriptionEvents.Error, (error) => {
      logger.error('Deepgram error:', error);
      this.emit('error', error);
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      logger.info('Deepgram connection closed');
      this.emit('close');
    });

    return {
      send: (audioData: Buffer) => {
        connection.send(audioData as unknown as string);
      },
      close: () => {
        connection.finish();
      },
    };
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
            totalConfidence += currentSegment.confidence;
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
          currentSegment.words.push({
            text: word.word || word.punctuated_word,
            startTime: word.start,
            endTime: word.end,
            confidence: word.confidence,
          });
        }
      }

      if (currentSegment) {
        segments.push(currentSegment);
        totalConfidence += currentSegment.confidence;
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
      confidence: segmentCount > 0 ? totalConfidence / segmentCount : 0,
    };
  }
}

// Export singleton factory
export function createDeepgramService(config?: Partial<DeepgramConfig>): DeepgramTranscriptionService {
  return new DeepgramTranscriptionService(config);
}
