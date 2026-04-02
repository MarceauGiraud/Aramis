/**
 * Transcription Provider Factory
 *
 * Creates transcription provider instances based on provider name.
 * Maps TRANSCRIPTION_PROVIDERS constants to concrete implementations.
 */

import { TRANSCRIPTION_PROVIDERS } from '@aramis/shared';
import { TranscriptionProvider } from './provider-interface';
import { DeepgramTranscriptionService } from './deepgram';
import { OpenAITranscriptionProvider } from './openai';
import { AssemblyAITranscriptionProvider } from './assemblyai';
import { logger } from '../logger';

export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  language?: string;
  [key: string]: any;
}

/**
 * Create a transcription provider by name.
 *
 * @param name - Provider name (from TRANSCRIPTION_PROVIDERS constants)
 * @param config - Optional provider-specific configuration
 * @returns A TranscriptionProvider instance
 * @throws Error if the provider is unknown or required API key is missing
 */
export function createTranscriptionProvider(name: string, config?: ProviderConfig): TranscriptionProvider {
  switch (name) {
    case TRANSCRIPTION_PROVIDERS.DEEPGRAM: {
      const apiKey = config?.apiKey || process.env.DEEPGRAM_API_KEY;
      if (!apiKey) {
        throw new Error('DEEPGRAM_API_KEY is required for Deepgram provider');
      }
      return new DeepgramTranscriptionService({
        apiKey,
        model: config?.model as any,
        language: config?.language,
      });
    }

    case TRANSCRIPTION_PROVIDERS.OPENAI_WHISPER: {
      const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is required for OpenAI provider');
      }
      return new OpenAITranscriptionProvider({
        apiKey,
        model: config?.model as any,
        language: config?.language,
      });
    }

    case TRANSCRIPTION_PROVIDERS.ASSEMBLYAI: {
      const apiKey = config?.apiKey || process.env.ASSEMBLYAI_API_KEY;
      if (!apiKey) {
        throw new Error('ASSEMBLYAI_API_KEY is required for AssemblyAI provider');
      }
      return new AssemblyAITranscriptionProvider({
        apiKey,
        model: config?.model,
        language: config?.language,
      });
    }

    default:
      throw new Error(`Unknown transcription provider: ${name}`);
  }
}

/**
 * Get the default transcription provider based on available API keys.
 * Preference order: Deepgram > AssemblyAI > OpenAI
 */
export function getDefaultProvider(): TranscriptionProvider {
  if (process.env.DEEPGRAM_API_KEY) {
    logger.info('Using Deepgram as default transcription provider');
    return createTranscriptionProvider(TRANSCRIPTION_PROVIDERS.DEEPGRAM);
  }

  if (process.env.ASSEMBLYAI_API_KEY) {
    logger.info('Using AssemblyAI as default transcription provider');
    return createTranscriptionProvider(TRANSCRIPTION_PROVIDERS.ASSEMBLYAI);
  }

  if (process.env.OPENAI_API_KEY) {
    logger.info('Using OpenAI as default transcription provider');
    return createTranscriptionProvider(TRANSCRIPTION_PROVIDERS.OPENAI_WHISPER);
  }

  throw new Error(
    'No transcription provider API key found. Set one of: DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY, OPENAI_API_KEY',
  );
}
