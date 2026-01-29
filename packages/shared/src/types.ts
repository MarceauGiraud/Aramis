// Meeting platform types
export type MeetingPlatform = 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET';

export type MeetingStatus =
  | 'PENDING'
  | 'JOINING'
  | 'RECORDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

// Job types
export interface JoinMeetingJob {
  meetingId: string;
  meetingUrl: string;
  platform: MeetingPlatform;
  botName?: string;
}

export interface ProcessRecordingJob {
  meetingId: string;
  recordingPath: string;
}

export interface TranscribeJob {
  meetingId: string;
  audioUrl: string;
  language?: string;
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
  | 'bot_joining'
  | 'bot_joined'
  | 'bot_left'
  | 'recording_started'
  | 'recording_stopped'
  | 'participant_joined'
  | 'participant_left'
  | 'error';

// Webhook types
export interface WebhookPayload {
  event: string;
  meetingId: string;
  timestamp: string;
  data: Record<string, unknown>;
}
