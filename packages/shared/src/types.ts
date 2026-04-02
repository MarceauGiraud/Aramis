// Meeting platform types
export type MeetingPlatform = 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET';

export type MeetingStatus =
  | 'PENDING'
  | 'JOINING'
  | 'WAITING'
  | 'RECORDING'
  | 'RECORDING_PAUSED'
  | 'STOPPED'
  | 'PROCESSING'
  | 'POST_PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

// Recording configuration
export type RecordingFormat = 'webm' | 'mp4' | 'mp3';
export type RecordingView = 'speaker' | 'gallery';
export type Resolution = '1080p' | '720p';

export interface RecordingConfig {
  format: RecordingFormat;
  view: RecordingView;
  resolution: Resolution;
  noRecording: boolean;
}

// Transcription configuration
export interface TranscriptionConfig {
  provider: string;
  language?: string;
  model?: string;
}

// WebSocket audio streaming
export interface AudioStreamConfig {
  sampleRate: 8000 | 16000 | 24000;
  encoding: 'pcm_s16le';
  channels: 1;
}

// RTMP streaming
export interface RtmpStreamConfig {
  url: string;
  streamKey: string;
}

// Webhook configuration
export interface WebhookConfig {
  url: string;
  secret: string;
  events: string[];
}

// Job types
export interface JoinMeetingJob {
  meetingId: string;
  meetingUrl: string;
  platform: MeetingPlatform;
  botName?: string;
  recordingConfig?: RecordingConfig;
  transcriptionConfig?: TranscriptionConfig;
  rtmpConfig?: RtmpStreamConfig;
  audioStreamEnabled?: boolean;
  webhooks?: WebhookConfig[];
  deduplicationKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessRecordingJob {
  meetingId: string;
  recordingPath: string;
}

export interface TranscribeJob {
  meetingId: string;
  audioUrl: string;
  language?: string;
  provider?: string;
}

export interface GenerateSummaryJob {
  meetingId: string;
  transcriptId: string;
}

// API types
export interface CreateMeetingRequest {
  title: string;
  meetingUrl: string;
  platform?: MeetingPlatform;
  scheduledAt?: string;
  recordingConfig?: RecordingConfig;
  webhooks?: WebhookConfig[];
  deduplicationKey?: string;
  metadata?: Record<string, unknown>;
}

export interface MeetingResponse {
  id: string;
  title: string;
  platform: MeetingPlatform;
  meetingUrl: string;
  status: MeetingStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  duration: number | null;
  createdAt: string;
}

export interface RecordingResponse {
  id: string;
  meetingId: string;
  fileUrl: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  fileSize: number | null;
  format: string;
}

export interface TranscriptResponse {
  id: string;
  meetingId: string;
  content: string;
  language: string;
  summary: string | null;
  actionItems: string[];
  segments: TranscriptSegmentResponse[];
}

export interface TranscriptSegmentResponse {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  speaker: string | null;
}

// Bot event types
export interface BotEvent {
  type: BotEventType;
  meetingId: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

export type BotEventType =
  | 'bot_creating'
  | 'bot_ready'
  | 'bot_joining'
  | 'bot_joined'
  | 'bot_waiting_for_host'
  | 'bot_admitted'
  | 'bot_denied'
  | 'bot_left'
  | 'bot_kicked'
  | 'bot_error'
  | 'recording_started'
  | 'recording_paused'
  | 'recording_resumed'
  | 'recording_stopped'
  | 'participant_joined'
  | 'participant_left'
  | 'participant_speaking'
  | 'transcript_started'
  | 'transcript_segment'
  | 'transcript_completed'
  | 'summary_started'
  | 'summary_completed'
  | 'chat_message_received'
  | 'chat_message_sent'
  | 'audio_output_started'
  | 'audio_output_completed'
  | 'screenshot_captured'
  | 'mhtml_captured'
  | 'breakout_room_detected'
  | 'error';

// Webhook types
export interface WebhookPayload {
  event: string;
  meetingId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// Bot error classification
export type BotErrorType =
  | 'denied_entry'
  | 'timeout'
  | 'network_error'
  | 'kicked'
  | 'meeting_ended'
  | 'login_required'
  | 'display_error'
  | 'recording_error'
  | 'unknown';

// Bot command (sent via Redis pub/sub)
export type BotCommandType = 'pause' | 'resume' | 'leave' | 'send_chat' | 'output_audio';

export interface BotCommand {
  action: BotCommandType;
  meetingId: string;
  data?: Record<string, unknown>;
}

// Chat message
export interface ChatMessageData {
  sender: string;
  message: string;
  timestamp: Date;
  platform: MeetingPlatform;
}
