/**
 * Transcription Provider Interface
 *
 * Defines a common interface for all transcription providers (Deepgram, OpenAI, AssemblyAI, etc.)
 * Supports both batch transcription (from URL or file) and live/streaming transcription.
 */

export interface TranscriptionProvider {
  /** Provider name identifier */
  readonly name: string;

  /** Transcribe audio from a URL */
  transcribeUrl(audioUrl: string, options?: TranscribeOptions): Promise<TranscriptionResult>;

  /** Transcribe audio from a local file path (optional, not all providers support this) */
  transcribeFile?(audioPath: string, options?: TranscribeOptions): Promise<TranscriptionResult>;

  /** Whether this provider supports live/streaming transcription */
  supportsLiveTranscription(): boolean;

  /** Start a live transcription session (only available if supportsLiveTranscription() returns true) */
  startLiveTranscription?(options?: LiveTranscriptionOptions): Promise<LiveTranscriptionSession>;
}

export interface LiveTranscriptionSession {
  /** Send audio data to the transcription session */
  send(audioData: Buffer): void;

  /** Close the transcription session */
  close(): void;

  /** Register event handlers */
  on(event: 'transcript', cb: (segment: TranscriptSegment, isFinal: boolean) => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
  on(event: 'close', cb: () => void): void;
}

export interface TranscribeOptions {
  /** Language code (e.g., 'en', 'fr', 'es') */
  language?: string;
  /** Enable speaker diarization */
  diarize?: boolean;
  /** Model to use for transcription */
  model?: string;
}

export interface LiveTranscriptionOptions extends TranscribeOptions {
  /** Audio sample rate in Hz (default: 16000) */
  sampleRate?: number;
  /** Audio encoding format */
  encoding?: 'linear16' | 'opus' | 'flac';
  /** Number of audio channels (default: 1) */
  channels?: number;
  /** Whether to return interim (non-final) results */
  interimResults?: boolean;
}

export interface TranscriptSegment {
  /** Transcribed text for this segment */
  text: string;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Speaker label (e.g., "Speaker 1") */
  speaker?: string;
  /** Confidence score (0-1) */
  confidence?: number;
  /** Individual words with timing info */
  words?: TranscriptWord[];
}

export interface TranscriptWord {
  /** The word text */
  text: string;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Confidence score (0-1) */
  confidence?: number;
}

export interface TranscriptionResult {
  /** Ordered list of transcript segments */
  segments: TranscriptSegment[];
  /** List of unique speaker labels found */
  speakers: string[];
  /** Detected or specified language */
  language?: string;
  /** Total audio duration in seconds */
  duration?: number;
  /** Full concatenated transcript text */
  fullText: string;
}
