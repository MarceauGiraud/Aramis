// Queue names
export const QUEUE_NAMES = {
  MEETING_BOT: 'meeting-bot',
  RECORDING_PROCESSOR: 'recording-processor',
  TRANSCRIPTION: 'transcription',
  SUMMARY: 'summary',
} as const;

// Job types
export const JOB_TYPES = {
  JOIN_MEETING: 'join_meeting',
  LEAVE_MEETING: 'leave_meeting',
  PROCESS_RECORDING: 'process_recording',
  TRANSCRIBE: 'transcribe',
  GENERATE_SUMMARY: 'generate_summary',
} as const;

// Meeting URL patterns
export const MEETING_URL_PATTERNS = {
  ZOOM: /https?:\/\/([\w-]+\.)?zoom\.us\/(j|my)\/[\w-]+/i,
  TEAMS: /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/.+/i,
  GOOGLE_MEET: /https?:\/\/meet\.google\.com\/[\w-]+/i,
} as const;

// Bot configuration
export const BOT_CONFIG = {
  DEFAULT_NAME: 'Aramis Recorder',
  JOIN_TIMEOUT_MS: 60000, // 1 minute to join
  RECORDING_CHECK_INTERVAL_MS: 5000, // Check recording status every 5s
  MAX_RECORDING_DURATION_MS: 4 * 60 * 60 * 1000, // 4 hours max
  HEARTBEAT_INTERVAL_MS: 30000, // Heartbeat every 30s
} as const;

// Supported formats
export const SUPPORTED_FORMATS = {
  VIDEO: ['webm', 'mp4', 'mkv'],
  AUDIO: ['wav', 'mp3', 'ogg', 'm4a'],
} as const;

// Transcription providers
export const TRANSCRIPTION_PROVIDERS = {
  DEEPGRAM: 'deepgram',
  OPENAI_WHISPER: 'openai_whisper',
  ASSEMBLYAI: 'assemblyai',
  LOCAL_WHISPER: 'local_whisper',
} as const;
