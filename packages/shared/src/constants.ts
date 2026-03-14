// Queue names
export const QUEUE_NAMES = {
  MEETING_BOT: 'meeting-bot',
  RECORDING_PROCESSOR: 'recording-processor',
  TRANSCRIPTION: 'transcription',
  SUMMARY: 'summary',
  WEBHOOK_DELIVERY: 'webhook-delivery',
  CALENDAR_SYNC: 'calendar-sync',
} as const;

// Job types
export const JOB_TYPES = {
  JOIN_MEETING: 'join_meeting',
  LEAVE_MEETING: 'leave_meeting',
  PROCESS_RECORDING: 'process_recording',
  TRANSCRIBE: 'transcribe',
  GENERATE_SUMMARY: 'generate_summary',
  WEBHOOK_DELIVERY: 'webhook_delivery',
  SYNC_CALENDAR: 'sync_calendar',
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
  JOIN_TIMEOUT_MS: 60000,
  JOIN_MAX_ATTEMPTS: 3,
  JOIN_STEP_RETRIES: 3,
  JOIN_STEP_TIMEOUT_MS: 5000,
  POPUP_STABLE_MS: 2000,
  ADMISSION_TIMEOUT_MS: 5 * 60 * 1000,
  RECORDING_CHECK_INTERVAL_MS: 5000,
  MAX_RECORDING_DURATION_MS: 4 * 60 * 60 * 1000,
  HEARTBEAT_INTERVAL_MS: 30000,
  SILENCE_TIMEOUT_MS: 10 * 60 * 1000, // 10 min silence = auto-leave
  CHAT_POLL_INTERVAL_MS: 2000,
  SPEAKER_TRACKING_INTERVAL_MS: 500,
} as const;

// Supported formats
export const SUPPORTED_FORMATS = {
  VIDEO: ['webm', 'mp4', 'mkv'],
  AUDIO: ['wav', 'mp3', 'ogg', 'm4a'],
} as const;

// Resolution mappings
export const RESOLUTION_MAP = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
} as const;

// Format-specific FFmpeg configurations
export const FORMAT_CONFIG = {
  webm: { videoCodec: 'libvpx-vp9', audioCodec: 'libopus', ext: 'webm', mime: 'video/webm' },
  mp4: { videoCodec: 'libx264', audioCodec: 'aac', ext: 'mp4', mime: 'video/mp4' },
  mp3: { videoCodec: null, audioCodec: 'libmp3lame', ext: 'mp3', mime: 'audio/mpeg' },
} as const;

// Transcription providers
export const TRANSCRIPTION_PROVIDERS = {
  DEEPGRAM: 'deepgram',
  OPENAI_WHISPER: 'openai_whisper',
  ASSEMBLYAI: 'assemblyai',
  LOCAL_WHISPER: 'local_whisper',
} as const;

// Audio sample rates for WebSocket streaming
export const AUDIO_SAMPLE_RATES = [8000, 16000, 24000] as const;

// Webhook event types
export const WEBHOOK_EVENT_TYPES = {
  BOT_STATUS_CHANGE: 'bot.status_change',
  BOT_ERROR: 'bot.error',
  MEETING_STARTED: 'meeting.started',
  MEETING_ENDED: 'meeting.ended',
  RECORDING_STARTED: 'recording.started',
  RECORDING_PAUSED: 'recording.paused',
  RECORDING_RESUMED: 'recording.resumed',
  RECORDING_STOPPED: 'recording.stopped',
  TRANSCRIPTION_UTTERANCE: 'transcription.utterance',
  TRANSCRIPTION_COMPLETED: 'transcription.completed',
  PARTICIPANT_JOINED: 'participant.joined',
  PARTICIPANT_LEFT: 'participant.left',
  CHAT_MESSAGE: 'chat.message',
} as const;

// Redis pub/sub channels for bot commands
export const BOT_COMMANDS_CHANNEL = 'bot:commands';
export const BOT_EVENTS_CHANNEL = 'bot:events';

// Bot command types
export const BOT_COMMAND_TYPES = {
  PAUSE: 'pause',
  RESUME: 'resume',
  LEAVE: 'leave',
  SEND_CHAT: 'send_chat',
  OUTPUT_AUDIO: 'output_audio',
} as const;

// Stale bot threshold (10 minutes without heartbeat)
export const STALE_BOT_THRESHOLD_MS = 10 * 60 * 1000;

// Default chunk retention period in days
export const DEFAULT_CHUNK_RETENTION_DAYS = 30;
