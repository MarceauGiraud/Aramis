/**
 * OpenAI Transcription Provider
 *
 * Uses OpenAI's transcription API (gpt-4o-transcribe or whisper-1) for batch transcription.
 * Does NOT support live/streaming transcription.
 *
 * Requires the `openai` npm package (already in package.json).
 * Set OPENAI_API_KEY environment variable.
 */

import OpenAI from 'openai';
import * as fs from 'fs';
import { logger } from '../logger';
import { TranscriptionProvider, TranscribeOptions, TranscriptionResult, TranscriptSegment } from './provider-interface';

export interface OpenAITranscriptionConfig {
  apiKey: string;
  model?: 'whisper-1' | 'gpt-4o-transcribe';
  language?: string;
}

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openai_whisper';
  private client: OpenAI;
  private config: OpenAITranscriptionConfig;

  constructor(config?: Partial<OpenAITranscriptionConfig>) {
    this.config = {
      apiKey: config?.apiKey || process.env.OPENAI_API_KEY || '',
      model: config?.model || 'whisper-1',
      language: config?.language,
    };

    this.client = new OpenAI({ apiKey: this.config.apiKey });
  }

  supportsLiveTranscription(): boolean {
    return false;
  }

  /**
   * Transcribe audio from a URL.
   *
   * OpenAI's API requires file upload, so we download the file first,
   * then transcribe it.
   */
  async transcribeUrl(audioUrl: string, options?: TranscribeOptions): Promise<TranscriptionResult> {
    logger.info(`OpenAI transcription from URL: ${audioUrl}`);

    // Download the file to a temporary location
    const tempPath = `/tmp/openai-transcribe-${Date.now()}.wav`;
    try {
      const response = await fetch(audioUrl);
      if (!response.ok) {
        throw new Error(`Failed to download audio: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tempPath, buffer);

      return await this.transcribeFile(tempPath, options);
    } finally {
      // Cleanup temp file
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Transcribe audio from a local file path.
   */
  async transcribeFile(audioPath: string, options?: TranscribeOptions): Promise<TranscriptionResult> {
    logger.info(`OpenAI transcription from file: ${audioPath}`);

    const model = (options?.model as OpenAITranscriptionConfig['model']) || this.config.model || 'whisper-1';
    const language = options?.language || this.config.language;

    // Use verbose_json to get word-level timestamps
    const transcription = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model,
      language,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment', 'word'],
    } as any);

    return this.parseResult(transcription, language);
  }

  /**
   * Parse OpenAI transcription response into our TranscriptionResult format.
   */
  private parseResult(response: any, language?: string): TranscriptionResult {
    const segments: TranscriptSegment[] = [];
    const speakerSet = new Set<string>();

    // OpenAI returns segments in verbose_json mode
    if (response.segments && Array.isArray(response.segments)) {
      for (const seg of response.segments) {
        const segment: TranscriptSegment = {
          text: seg.text?.trim() || '',
          startTime: seg.start || 0,
          endTime: seg.end || 0,
          confidence:
            seg.avg_logprob != null
              ? Math.exp(seg.avg_logprob) // Convert log probability to probability
              : undefined,
          words: [],
        };

        segments.push(segment);
      }
    }

    // If word-level timestamps are available, attach them to segments
    if (response.words && Array.isArray(response.words)) {
      let segmentIndex = 0;
      for (const word of response.words) {
        // Find the appropriate segment for this word
        while (segmentIndex < segments.length - 1 && word.start >= segments[segmentIndex + 1].startTime) {
          segmentIndex++;
        }

        if (segmentIndex < segments.length) {
          if (!segments[segmentIndex].words) {
            segments[segmentIndex].words = [];
          }
          segments[segmentIndex].words!.push({
            text: word.word?.trim() || '',
            startTime: word.start || 0,
            endTime: word.end || 0,
          });
        }
      }
    }

    const fullText = response.text || segments.map((s) => s.text).join(' ');
    const detectedLanguage = response.language || language;
    const duration = response.duration || (segments.length > 0 ? segments[segments.length - 1].endTime : 0);

    return {
      segments,
      speakers: Array.from(speakerSet),
      language: detectedLanguage,
      duration,
      fullText,
    };
  }
}

export function createOpenAITranscriptionProvider(
  config?: Partial<OpenAITranscriptionConfig>,
): OpenAITranscriptionProvider {
  return new OpenAITranscriptionProvider(config);
}
