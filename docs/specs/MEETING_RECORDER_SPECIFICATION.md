# Aramis Meeting Recorder - Full Specification

**Version:** 1.0
**Date:** January 2026
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [User Stories](#2-user-stories)
3. [System Architecture](#3-system-architecture)
4. [Calendar Integration](#4-calendar-integration)
5. [Meeting Recording](#5-meeting-recording)
6. [Transcript System](#6-transcript-system)
7. [Video Recording & Chunk Management](#7-video-recording--chunk-management)
8. [AI Summary System](#8-ai-summary-system)
9. [Custom Template System](#9-custom-template-system)
10. [Data Models](#10-data-models)
11. [API Specification](#11-api-specification)
12. [Security & Privacy](#12-security--privacy)
13. [Error Handling](#13-error-handling)

---

## 1. Overview

### 1.1 Purpose

Aramis Meeting Recorder is a self-hosted solution that automatically records, transcribes, and summarizes meetings from Zoom, Microsoft Teams, and Google Meet. Users connect their calendars, and the system automatically joins and records scheduled meetings.

### 1.2 Key Features

- **Calendar Sync**: OAuth2 integration with Google Calendar and Microsoft Outlook
- **Auto-Join**: Bot automatically joins meetings at scheduled time
- **Recording**: Video/audio capture with chunk-based storage
- **Transcription**: Real-time and post-meeting transcription with speaker identification
- **AI Summaries**: Structured summaries with key outputs, decisions, and action items
- **Custom Templates**: User-defined templates for AI summary structure

### 1.3 Target Users

- Teams wanting to keep meeting records
- Professionals who miss meetings and need catch-up
- Organizations requiring meeting documentation for compliance
- Sales/CS teams needing call analytics

---

## 2. User Stories

### 2.1 Calendar Connection

```
US-001: As a user, I want to connect my Google Calendar so that Aramis can see my scheduled meetings.

Acceptance Criteria:
- User can initiate OAuth2 flow for Google Calendar
- System requests minimal required scopes (calendar.readonly, calendar.events.readonly)
- User sees list of connected calendars after successful auth
- User can disconnect calendar at any time
- System syncs calendar events within 5 minutes of connection
```

```
US-002: As a user, I want to connect my Microsoft Outlook Calendar so that Aramis can see my scheduled meetings.

Acceptance Criteria:
- User can initiate OAuth2 flow for Microsoft Graph API
- System requests minimal required scopes (Calendars.Read)
- User sees list of connected calendars after successful auth
- User can disconnect calendar at any time
- System syncs calendar events within 5 minutes of connection
```

```
US-003: As a user, I want to select which calendars to monitor so I can control which meetings are recorded.

Acceptance Criteria:
- User sees all available calendars from connected accounts
- User can enable/disable recording for each calendar
- User can set default recording behavior (opt-in vs opt-out)
- Changes take effect immediately
```

### 2.2 Meeting Configuration

```
US-004: As a user, I want to configure which meetings should be automatically recorded based on rules.

Acceptance Criteria:
- User can create rules based on: meeting title, attendees, calendar, recurring status
- User can set recording to: always record, never record, or ask before
- Rules have priority ordering
- User can preview which upcoming meetings match rules
```

```
US-005: As a user, I want to manually request recording for a specific meeting.

Acceptance Criteria:
- User can paste a meeting URL to request immediate recording
- User can select an upcoming calendar event to enable recording
- User receives confirmation when recording is scheduled
- User can cancel scheduled recording before it starts
```

### 2.3 Recording Management

```
US-006: As a user, I want to see all my recorded meetings in a dashboard.

Acceptance Criteria:
- Dashboard shows list of recordings with: title, date, duration, platform, status
- User can filter by: date range, platform, status
- User can search by title or transcript content
- Recordings are sorted by date (newest first) by default
```

```
US-007: As a user, I want to view a recording with its transcript.

Acceptance Criteria:
- User sees video player with transcript sidebar
- Transcript is synced with video playback (click to jump)
- Speaker labels are shown in transcript
- User can search within transcript
- User can copy transcript text
```

```
US-008: As a user, I want to download the recording and transcript.

Acceptance Criteria:
- User can download video in MP4 format
- User can download audio only in MP3 format
- User can download transcript in TXT, SRT, or VTT format
- User can download AI summary in Markdown or PDF
```

### 2.4 AI Summary

```
US-009: As a user, I want to see an AI-generated summary of my meeting.

Acceptance Criteria:
- Summary is generated within 5 minutes of recording completion
- Summary includes: overview, key discussion points, decisions made, action items
- Action items include: assignee (if mentioned), description, due date (if mentioned)
- User can regenerate summary if needed
```

```
US-010: As a user, I want to create custom templates for AI summaries.

Acceptance Criteria:
- User can create named templates with custom sections
- User can define section: name, description/prompt, required/optional
- User can set a template as default for all meetings
- User can assign templates to specific calendars or meeting rules
- Templates support variables: {{meeting_title}}, {{attendees}}, {{date}}, etc.
```

```
US-011: As a user, I want to edit and refine the AI summary.

Acceptance Criteria:
- User can edit any section of the summary
- User can mark action items as complete
- User can add manual notes to the summary
- Changes are saved and versioned
```

### 2.5 Sharing & Collaboration

```
US-012: As a user, I want to share a recording with others.

Acceptance Criteria:
- User can generate shareable link with optional expiration
- User can set permissions: view only, view + download, full access
- User can require email/password to access
- User can revoke access at any time
```

---

## 3. System Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  Client Layer                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  Web App    │  │  Mobile App │  │  Browser    │  │   Webhooks  │        │
│  │  (Next.js)  │  │  (Future)   │  │  Extension  │  │  (Incoming) │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
└─────────┼────────────────┼────────────────┼────────────────┼────────────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  API Layer                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                     Next.js API Routes                          │        │
│  │  /api/auth/*  /api/meetings/*  /api/calendars/*  /api/templates │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                    │                                         │
│  ┌─────────────┐  ┌─────────────┐  │  ┌─────────────┐  ┌─────────────┐     │
│  │  NextAuth   │  │   Prisma    │◄─┴─►│   BullMQ    │  │  WebSocket  │     │
│  │   (Auth)    │  │   (ORM)     │     │   (Queue)   │  │  (Realtime) │     │
│  └──────┬──────┘  └──────┬──────┘     └──────┬──────┘  └──────┬──────┘     │
└─────────┼────────────────┼───────────────────┼────────────────┼─────────────┘
          │                │                   │                │
          ▼                ▼                   ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Service Layer                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │  Calendar Sync   │  │   Bot Worker     │  │  Transcription   │          │
│  │     Service      │  │    Service       │  │    Service       │          │
│  │                  │  │                  │  │                  │          │
│  │ - Google Cal API │  │ - Playwright     │  │ - Deepgram       │          │
│  │ - MS Graph API   │  │ - Screen Capture │  │ - Whisper        │          │
│  │ - Webhook sync   │  │ - Audio Capture  │  │ - AssemblyAI     │          │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘          │
│           │                     │                     │                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │   AI Summary     │  │  Chunk Manager   │  │  Storage Service │          │
│  │    Service       │  │    Service       │  │                  │          │
│  │                  │  │                  │  │                  │          │
│  │ - OpenAI GPT-4   │  │ - Segment video  │  │ - S3 Upload      │          │
│  │ - Claude         │  │ - Merge chunks   │  │ - Presigned URLs │          │
│  │ - Template proc  │  │ - HLS streaming  │  │ - CDN delivery   │          │
│  └──────────────────┘  └────────┬─────────┘  └────────┬─────────┘          │
│                                 │                     │                     │
└─────────────────────────────────┼─────────────────────┼─────────────────────┘
                                  │                     │
                                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Storage Layer                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ PostgreSQL  │  │    Redis    │  │  S3/MinIO   │  │    CDN      │        │
│  │             │  │             │  │             │  │  (Future)   │        │
│  │ - Users     │  │ - Job Queue │  │ - Videos    │  │             │        │
│  │ - Meetings  │  │ - Cache     │  │ - Audio     │  │             │        │
│  │ - Templates │  │ - Sessions  │  │ - Chunks    │  │             │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Responsibilities

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| Web App | User interface, API gateway | Next.js 14, React, Tailwind |
| Calendar Sync | Fetch and sync calendar events | Node.js, Google/MS APIs |
| Bot Worker | Join meetings, capture audio/video | Playwright, FFmpeg |
| Transcription | Convert audio to text | Deepgram, Whisper |
| AI Summary | Generate structured summaries | OpenAI GPT-4, Claude |
| Chunk Manager | Handle video segmentation | FFmpeg, Node.js |
| Storage | File storage and delivery | S3, MinIO |

---

## 4. Calendar Integration

### 4.1 Google Calendar OAuth2 Flow

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  User    │     │  Aramis  │     │  Google  │     │ Calendar │
│          │     │   Web    │     │  OAuth   │     │   API    │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     │ Click Connect  │                │                │
     │───────────────>│                │                │
     │                │                │                │
     │                │ Redirect to    │                │
     │                │ Google OAuth   │                │
     │<───────────────│───────────────>│                │
     │                │                │                │
     │ User consents  │                │                │
     │───────────────────────────────>│                │
     │                │                │                │
     │                │ Callback with  │                │
     │                │ auth code      │                │
     │                │<───────────────│                │
     │                │                │                │
     │                │ Exchange code  │                │
     │                │ for tokens     │                │
     │                │───────────────>│                │
     │                │                │                │
     │                │ Access + Refresh│               │
     │                │ tokens         │                │
     │                │<───────────────│                │
     │                │                │                │
     │                │ Store tokens   │                │
     │                │ (encrypted)    │                │
     │                │                │                │
     │                │ Fetch calendars│                │
     │                │────────────────────────────────>│
     │                │                │                │
     │                │ Calendar list  │                │
     │                │<────────────────────────────────│
     │                │                │                │
     │ Show calendars │                │                │
     │<───────────────│                │                │
     │                │                │                │
```

### 4.2 Google Calendar Scopes Required

```
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events.readonly
```

### 4.3 Microsoft Graph OAuth2 Flow

Similar to Google, using Microsoft Identity Platform endpoints:

```
Authorization endpoint: https://login.microsoftonline.com/common/oauth2/v2.0/authorize
Token endpoint: https://login.microsoftonline.com/common/oauth2/v2.0/token
```

### 4.4 Microsoft Graph Scopes Required

```
Calendars.Read
User.Read
offline_access
```

### 4.5 Calendar Sync Strategy

```typescript
interface CalendarSyncConfig {
  // How often to poll for changes (in minutes)
  pollInterval: number; // default: 15

  // How far ahead to look for meetings (in days)
  lookAheadDays: number; // default: 7

  // Use webhooks for real-time updates
  useWebhooks: boolean; // default: true

  // Sync frequency for full refresh (in hours)
  fullRefreshInterval: number; // default: 24
}
```

### 4.6 Calendar Event Processing

When a calendar event is synced:

1. **Extract meeting URL** from:
   - Event location field
   - Event description
   - Conference data (Google Meet link)
   - Online meeting URL (Teams)

2. **Identify platform**:
   ```typescript
   function detectPlatform(url: string): MeetingPlatform | null {
     if (url.includes('zoom.us')) return 'ZOOM';
     if (url.includes('teams.microsoft.com')) return 'TEAMS';
     if (url.includes('meet.google.com')) return 'GOOGLE_MEET';
     return null;
   }
   ```

3. **Apply recording rules** to determine if meeting should be recorded

4. **Schedule bot** to join meeting 1 minute before start time

---

## 5. Meeting Recording

### 5.1 Recording Lifecycle

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  SCHEDULED  │───>│   JOINING   │───>│  RECORDING  │───>│ PROCESSING  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                          │                  │                  │
                          ▼                  ▼                  ▼
                   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
                   │   FAILED    │    │   STOPPED   │    │  COMPLETED  │
                   │ (join error)│    │  (manual)   │    │             │
                   └─────────────┘    └─────────────┘    └─────────────┘
```

### 5.2 Recording States

| State | Description |
|-------|-------------|
| `SCHEDULED` | Bot is scheduled to join at meeting start time |
| `JOINING` | Bot is attempting to join the meeting |
| `WAITING` | Bot has joined but meeting hasn't started (waiting room) |
| `RECORDING` | Active recording in progress |
| `STOPPED` | Recording stopped manually by user |
| `PROCESSING` | Recording complete, processing video/transcript |
| `COMPLETED` | All processing done, ready for viewing |
| `FAILED` | Recording failed at some stage |

### 5.3 Bot Join Process

```typescript
async function joinMeeting(config: BotConfig): Promise<void> {
  // 1. Launch browser with virtual audio device
  const browser = await playwright.chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-web-security',
    ]
  });

  // 2. Navigate to meeting URL
  const page = await browser.newPage();
  await page.goto(config.meetingUrl);

  // 3. Handle platform-specific join flow
  await platformHandler.join(page, config);

  // 4. Start recording
  await startRecording(page, config);

  // 5. Monitor for meeting end
  await monitorMeeting(page);

  // 6. Stop recording and process
  await stopAndProcess();
}
```

---

## 6. Transcript System

### 6.1 Transcription Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Audio Stream │────>│  Chunker     │────>│ Transcription│
│ (from bot)   │     │ (5s chunks)  │     │   Service    │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                                  ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Transcript  │<────│   Speaker    │<────│   Raw Text   │
│   Storage    │     │ Diarization  │     │  + Timing    │
└──────────────┘     └──────────────┘     └──────────────┘
```

### 6.2 Transcription Providers

| Provider | Real-time | Diarization | Languages | Cost |
|----------|-----------|-------------|-----------|------|
| Deepgram | Yes | Yes | 30+ | $0.0043/min |
| AssemblyAI | Yes | Yes | 10+ | $0.00025/sec |
| OpenAI Whisper | No | No | 50+ | $0.006/min |
| Local Whisper | No | No | 50+ | Self-hosted |

### 6.3 Transcript Data Model

```typescript
interface Transcript {
  id: string;
  meetingId: string;

  // Full text
  fullText: string;

  // Structured segments
  segments: TranscriptSegment[];

  // Speaker information
  speakers: Speaker[];

  // Metadata
  language: string;
  confidence: number;
  wordCount: number;
  duration: number; // in seconds

  createdAt: Date;
  updatedAt: Date;
}

interface TranscriptSegment {
  id: string;
  speakerId: string | null;
  text: string;
  startTime: number; // seconds from start
  endTime: number;
  confidence: number;
  words: Word[];
}

interface Word {
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
}

interface Speaker {
  id: string;
  label: string; // "Speaker 1", "Speaker 2", or identified name
  identifiedName?: string;
  totalSpeakingTime: number;
  segmentCount: number;
}
```

### 6.4 Real-time Transcription Flow

For real-time transcription during recording:

```typescript
// WebSocket connection to transcription service
const ws = new WebSocket('wss://api.deepgram.com/v1/listen');

ws.on('open', () => {
  ws.send(JSON.stringify({
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1,
    interim_results: true,
    diarize: true,
    punctuate: true,
  }));
});

// Stream audio chunks
audioStream.on('data', (chunk) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(chunk);
  }
});

// Receive transcription results
ws.on('message', (data) => {
  const result = JSON.parse(data);
  if (result.is_final) {
    saveTranscriptSegment(result);
    broadcastToClient(result);
  }
});
```

### 6.5 Speaker Identification

1. **Automatic diarization**: Transcription service assigns Speaker 1, 2, etc.
2. **Name matching**: Match speaker voice to names mentioned in meeting
3. **Manual labeling**: User can manually assign names to speakers
4. **Learning**: System learns voice patterns for returning speakers (future)

---

## 7. Video Recording & Chunk Management

### 7.1 Chunk-Based Recording Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Recording Session                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       ┌──────────┐   │
│  │ Chunk 1  │  │ Chunk 2  │  │ Chunk 3  │  ...  │ Chunk N  │   │
│  │ 0:00-5:00│  │5:00-10:00│  │10:00-15:00│      │ Final    │   │
│  │  ~50MB   │  │  ~50MB   │  │  ~50MB   │       │          │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘       └────┬─────┘   │
│       │             │             │                   │         │
│       ▼             ▼             ▼                   ▼         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    S3 Storage                             │  │
│  │  recordings/{meetingId}/chunks/                           │  │
│  │  ├── chunk_001.webm                                       │  │
│  │  ├── chunk_002.webm                                       │  │
│  │  ├── chunk_003.webm                                       │  │
│  │  └── ...                                                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Chunk Configuration

```typescript
interface ChunkConfig {
  // Duration of each chunk in seconds
  chunkDuration: number; // default: 300 (5 minutes)

  // Max file size per chunk in bytes
  maxChunkSize: number; // default: 100MB

  // Video settings
  video: {
    codec: 'vp8' | 'vp9' | 'h264';
    width: number;  // default: 1920
    height: number; // default: 1080
    bitrate: number; // default: 2500000 (2.5 Mbps)
    frameRate: number; // default: 30
  };

  // Audio settings
  audio: {
    codec: 'opus' | 'aac';
    sampleRate: number; // default: 48000
    channels: number; // default: 2
    bitrate: number; // default: 128000
  };
}
```

### 7.3 Recording Process

```typescript
class ChunkManager {
  private currentChunk: number = 0;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async startRecording(stream: MediaStream): Promise<void> {
    this.recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9,opus',
      videoBitsPerSecond: 2500000,
    });

    this.recorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);

        // Check if we should finalize this chunk
        if (this.shouldFinalizeChunk()) {
          await this.finalizeCurrentChunk();
        }
      }
    };

    // Request data every second for real-time upload
    this.recorder.start(1000);

    // Set up chunk rotation timer
    this.startChunkRotation();
  }

  private shouldFinalizeChunk(): boolean {
    const totalSize = this.chunks.reduce((sum, c) => sum + c.size, 0);
    return totalSize >= this.config.maxChunkSize;
  }

  private async finalizeCurrentChunk(): Promise<void> {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    this.chunks = [];

    const filename = `chunk_${String(this.currentChunk).padStart(3, '0')}.webm`;
    await this.uploadChunk(blob, filename);

    // Save chunk metadata to database
    await this.saveChunkMetadata({
      chunkNumber: this.currentChunk,
      filename,
      size: blob.size,
      startTime: this.chunkStartTime,
      endTime: Date.now(),
    });

    this.currentChunk++;
    this.chunkStartTime = Date.now();
  }
}
```

### 7.4 Chunk Merging (Post-Recording)

After recording completes, chunks are merged for final video:

```typescript
async function mergeChunks(meetingId: string): Promise<string> {
  const chunks = await db.recordingChunk.findMany({
    where: { meetingId },
    orderBy: { chunkNumber: 'asc' },
  });

  // Download all chunks
  const localPaths: string[] = [];
  for (const chunk of chunks) {
    const localPath = await downloadChunk(chunk.s3Key);
    localPaths.push(localPath);
  }

  // Create FFmpeg concat file
  const concatFile = localPaths.map(p => `file '${p}'`).join('\n');
  await fs.writeFile('/tmp/concat.txt', concatFile);

  // Merge with FFmpeg
  const outputPath = `/tmp/${meetingId}_merged.mp4`;
  await execAsync(`ffmpeg -f concat -safe 0 -i /tmp/concat.txt -c copy ${outputPath}`);

  // Upload merged file
  const s3Key = `recordings/${meetingId}/full_recording.mp4`;
  await uploadToS3(outputPath, s3Key);

  // Clean up
  await Promise.all(localPaths.map(p => fs.unlink(p)));

  return s3Key;
}
```

### 7.5 HLS Streaming (Optional)

For large recordings, generate HLS manifest for streaming:

```typescript
async function generateHLS(meetingId: string): Promise<string> {
  const inputPath = await downloadRecording(meetingId);
  const outputDir = `/tmp/${meetingId}_hls`;

  await fs.mkdir(outputDir, { recursive: true });

  // Generate HLS segments
  await execAsync(`
    ffmpeg -i ${inputPath} \
      -c:v libx264 -c:a aac \
      -hls_time 10 \
      -hls_list_size 0 \
      -hls_segment_filename "${outputDir}/segment_%03d.ts" \
      "${outputDir}/playlist.m3u8"
  `);

  // Upload all HLS files
  const files = await fs.readdir(outputDir);
  for (const file of files) {
    await uploadToS3(`${outputDir}/${file}`, `recordings/${meetingId}/hls/${file}`);
  }

  return `recordings/${meetingId}/hls/playlist.m3u8`;
}
```

### 7.6 Storage Structure

```
S3 Bucket: aramis-recordings
└── recordings/
    └── {meetingId}/
        ├── chunks/
        │   ├── chunk_001.webm
        │   ├── chunk_002.webm
        │   └── chunk_003.webm
        ├── audio/
        │   └── full_audio.wav
        ├── hls/
        │   ├── playlist.m3u8
        │   ├── segment_000.ts
        │   ├── segment_001.ts
        │   └── ...
        ├── full_recording.mp4
        └── thumbnail.jpg
```

---

## 8. AI Summary System

### 8.1 Summary Generation Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Transcript  │────>│   Template   │────>│     LLM      │
│              │     │   Processor  │     │  (GPT-4/etc) │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                            ┌─────────────────────┘
                            ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Validate   │────>│    Store     │────>│   Notify     │
│   Output     │     │   Summary    │     │    User      │
└──────────────┘     └──────────────┘     └──────────────┘
```

### 8.2 Default Summary Structure

```typescript
interface MeetingSummary {
  id: string;
  meetingId: string;
  templateId: string | null;

  // Core sections
  overview: string;
  keyPoints: KeyPoint[];
  decisions: Decision[];
  actionItems: ActionItem[];

  // Optional sections (based on template)
  customSections: CustomSection[];

  // Metadata
  generatedAt: Date;
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;

  // Versioning
  version: number;
  previousVersionId: string | null;
}

interface KeyPoint {
  id: string;
  topic: string;
  summary: string;
  timestamp?: number; // seconds from start
  speakers?: string[];
}

interface Decision {
  id: string;
  description: string;
  context: string;
  madeBy?: string;
  timestamp?: number;
}

interface ActionItem {
  id: string;
  description: string;
  assignee?: string;
  dueDate?: Date;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
  timestamp?: number;
}

interface CustomSection {
  id: string;
  name: string;
  content: string;
  order: number;
}
```

### 8.3 Summary Generation Prompt

```typescript
const DEFAULT_SUMMARY_PROMPT = `
You are an expert meeting analyst. Analyze the following meeting transcript and provide a structured summary.

## Meeting Information
- Title: {{meeting_title}}
- Date: {{meeting_date}}
- Duration: {{duration}}
- Participants: {{participants}}

## Transcript
{{transcript}}

## Instructions
Provide a comprehensive summary with the following sections:

### 1. Overview
Write a 2-3 sentence overview of the meeting's purpose and main outcome.

### 2. Key Discussion Points
List the main topics discussed with brief explanations. Include:
- The topic/theme
- Key points made
- Who spoke about it (if identifiable)

### 3. Decisions Made
List any decisions that were made during the meeting:
- What was decided
- Context/reasoning
- Who made or approved the decision

### 4. Action Items
Extract all action items mentioned. For each include:
- Task description
- Assignee (if mentioned, otherwise "Unassigned")
- Due date (if mentioned, otherwise "Not specified")
- Priority (infer from context: high/medium/low)

### 5. Next Steps
Summarize what happens next after this meeting.

Respond in JSON format matching this structure:
{
  "overview": "string",
  "keyPoints": [{"topic": "string", "summary": "string", "speakers": ["string"]}],
  "decisions": [{"description": "string", "context": "string", "madeBy": "string"}],
  "actionItems": [{"description": "string", "assignee": "string", "dueDate": "string", "priority": "string"}],
  "nextSteps": "string"
}
`;
```

### 8.4 LLM Integration

```typescript
interface LLMConfig {
  provider: 'openai' | 'anthropic' | 'local';
  model: string;
  maxTokens: number;
  temperature: number;
}

class SummaryGenerator {
  private llm: LLMProvider;

  async generateSummary(
    transcript: Transcript,
    template: SummaryTemplate | null,
    meeting: Meeting
  ): Promise<MeetingSummary> {
    // Build prompt from template or use default
    const prompt = template
      ? this.buildPromptFromTemplate(template, transcript, meeting)
      : this.buildDefaultPrompt(transcript, meeting);

    // Call LLM
    const response = await this.llm.complete({
      prompt,
      maxTokens: 4000,
      temperature: 0.3,
      responseFormat: { type: 'json_object' },
    });

    // Parse and validate response
    const parsed = JSON.parse(response.content);
    const validated = this.validateSummary(parsed);

    // Store summary
    const summary = await db.meetingSummary.create({
      data: {
        meetingId: meeting.id,
        templateId: template?.id,
        ...validated,
        modelUsed: this.llm.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
      },
    });

    return summary;
  }
}
```

---

## 9. Custom Template System

### 9.1 Template Structure

```typescript
interface SummaryTemplate {
  id: string;
  userId: string;
  name: string;
  description: string;

  // Template sections
  sections: TemplateSection[];

  // Settings
  isDefault: boolean;
  includeDefaultSections: boolean; // Include overview, keyPoints, decisions, actionItems

  // Targeting
  applyTo: TemplateTarget;

  createdAt: Date;
  updatedAt: Date;
}

interface TemplateSection {
  id: string;
  name: string;
  key: string; // kebab-case identifier
  description: string; // Instruction for AI
  prompt: string; // Specific prompt for this section
  required: boolean;
  order: number;
  outputFormat: 'text' | 'list' | 'table' | 'json';

  // Optional validation
  maxLength?: number;
  minItems?: number; // For lists
  maxItems?: number;
}

interface TemplateTarget {
  type: 'all' | 'calendar' | 'rule' | 'meeting';
  calendarIds?: string[];
  ruleIds?: string[];
  meetingPatterns?: string[]; // Regex patterns for meeting titles
}
```

### 9.2 Template Examples

**Sales Call Template:**
```json
{
  "name": "Sales Call Summary",
  "description": "Optimized for sales discovery and demo calls",
  "sections": [
    {
      "name": "Customer Overview",
      "key": "customer-overview",
      "prompt": "Summarize the customer's company, role, and current situation based on what they shared.",
      "outputFormat": "text",
      "required": true
    },
    {
      "name": "Pain Points",
      "key": "pain-points",
      "prompt": "List all pain points, challenges, or problems the customer mentioned.",
      "outputFormat": "list",
      "required": true
    },
    {
      "name": "Requirements",
      "key": "requirements",
      "prompt": "List specific requirements, must-haves, and nice-to-haves mentioned.",
      "outputFormat": "list",
      "required": true
    },
    {
      "name": "Competitors Mentioned",
      "key": "competitors",
      "prompt": "List any competitor products or solutions mentioned and context.",
      "outputFormat": "list",
      "required": false
    },
    {
      "name": "Budget & Timeline",
      "key": "budget-timeline",
      "prompt": "Extract any information about budget, timeline, or decision process.",
      "outputFormat": "text",
      "required": false
    },
    {
      "name": "Objections",
      "key": "objections",
      "prompt": "List any concerns, objections, or hesitations expressed.",
      "outputFormat": "list",
      "required": false
    },
    {
      "name": "Next Steps",
      "key": "next-steps",
      "prompt": "What were the agreed next steps? Include any scheduled follow-ups.",
      "outputFormat": "list",
      "required": true
    }
  ],
  "includeDefaultSections": true,
  "applyTo": {
    "type": "rule",
    "meetingPatterns": [".*[Dd]emo.*", ".*[Ss]ales.*", ".*[Dd]iscovery.*"]
  }
}
```

**Engineering Standup Template:**
```json
{
  "name": "Engineering Standup",
  "description": "Quick summary for daily standups",
  "sections": [
    {
      "name": "Updates by Person",
      "key": "updates-by-person",
      "prompt": "For each participant, summarize: what they completed, what they're working on, any blockers.",
      "outputFormat": "json",
      "required": true
    },
    {
      "name": "Blockers",
      "key": "blockers",
      "prompt": "List all blockers or issues that need resolution.",
      "outputFormat": "list",
      "required": true
    },
    {
      "name": "Cross-team Dependencies",
      "key": "dependencies",
      "prompt": "Note any mentioned dependencies on other teams or external factors.",
      "outputFormat": "list",
      "required": false
    }
  ],
  "includeDefaultSections": false,
  "applyTo": {
    "type": "rule",
    "meetingPatterns": [".*[Ss]tandup.*", ".*[Dd]aily.*"]
  }
}
```

### 9.3 Template Processing

```typescript
class TemplateProcessor {
  async processTemplate(
    template: SummaryTemplate,
    transcript: Transcript,
    meeting: Meeting
  ): Promise<ProcessedSummary> {
    const results: Record<string, any> = {};

    // Process each section
    for (const section of template.sections.sort((a, b) => a.order - b.order)) {
      const sectionPrompt = this.buildSectionPrompt(section, transcript, meeting);

      const response = await this.llm.complete({
        prompt: sectionPrompt,
        maxTokens: this.getMaxTokensForFormat(section.outputFormat),
        temperature: 0.3,
      });

      results[section.key] = this.parseOutput(response.content, section.outputFormat);
    }

    // Include default sections if configured
    if (template.includeDefaultSections) {
      const defaultSummary = await this.generateDefaultSections(transcript, meeting);
      return { ...defaultSummary, customSections: results };
    }

    return { customSections: results };
  }

  private buildSectionPrompt(
    section: TemplateSection,
    transcript: Transcript,
    meeting: Meeting
  ): string {
    return `
## Meeting Context
Title: ${meeting.title}
Date: ${meeting.scheduledStart}
Participants: ${meeting.attendees.join(', ')}

## Task
${section.prompt}

## Meeting Transcript
${transcript.fullText}

## Output Format
Provide the response as ${this.getFormatInstruction(section.outputFormat)}.
${section.maxLength ? `Maximum length: ${section.maxLength} characters.` : ''}
${section.minItems ? `Include at least ${section.minItems} items.` : ''}
${section.maxItems ? `Include at most ${section.maxItems} items.` : ''}
`;
  }
}
```

### 9.4 Template Variables

Templates support variable interpolation:

| Variable | Description |
|----------|-------------|
| `{{meeting_title}}` | Title of the meeting |
| `{{meeting_date}}` | Formatted meeting date |
| `{{meeting_time}}` | Meeting start time |
| `{{duration}}` | Meeting duration |
| `{{participants}}` | Comma-separated list of attendees |
| `{{participant_count}}` | Number of participants |
| `{{platform}}` | Meeting platform (Zoom/Teams/Meet) |
| `{{organizer}}` | Meeting organizer name |
| `{{transcript}}` | Full transcript text |
| `{{transcript_summary}}` | Condensed transcript (for long meetings) |
| `{{speaker_list}}` | List of identified speakers |

---

## 10. Data Models

### 10.1 Complete Prisma Schema

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ==================== USERS ====================

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String?
  image         String?
  emailVerified DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // Relations
  accounts        Account[]
  sessions        Session[]
  calendarConnections CalendarConnection[]
  meetings        Meeting[]
  templates       SummaryTemplate[]
  recordingRules  RecordingRule[]
  shares          Share[]
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

// ==================== CALENDAR ====================

model CalendarConnection {
  id           String   @id @default(cuid())
  userId       String
  provider     CalendarProvider
  email        String
  accessToken  String   @db.Text
  refreshToken String?  @db.Text
  expiresAt    DateTime?
  scope        String?
  isActive     Boolean  @default(true)
  lastSyncAt   DateTime?
  syncError    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  user      User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  calendars Calendar[]

  @@unique([userId, provider, email])
}

enum CalendarProvider {
  GOOGLE
  MICROSOFT
}

model Calendar {
  id             String   @id @default(cuid())
  connectionId   String
  externalId     String
  name           String
  color          String?
  isPrimary      Boolean  @default(false)
  isEnabled      Boolean  @default(true)
  autoRecord     Boolean  @default(false)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  connection CalendarConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  events     CalendarEvent[]

  @@unique([connectionId, externalId])
}

model CalendarEvent {
  id            String    @id @default(cuid())
  calendarId    String
  externalId    String
  title         String
  description   String?   @db.Text
  location      String?
  startTime     DateTime
  endTime       DateTime
  isAllDay      Boolean   @default(false)
  meetingUrl    String?
  platform      MeetingPlatform?
  organizer     String?
  attendees     String[]
  isRecurring   Boolean   @default(false)
  recurringId   String?
  isCancelled   Boolean   @default(false)
  lastSyncAt    DateTime  @default(now())
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  calendar Calendar @relation(fields: [calendarId], references: [id], onDelete: Cascade)
  meeting  Meeting?

  @@unique([calendarId, externalId])
}

// ==================== MEETINGS ====================

model Meeting {
  id              String        @id @default(cuid())
  userId          String
  calendarEventId String?       @unique
  title           String
  description     String?       @db.Text
  meetingUrl      String
  platform        MeetingPlatform
  scheduledStart  DateTime
  scheduledEnd    DateTime?
  actualStart     DateTime?
  actualEnd       DateTime?
  duration        Int?          // in seconds
  status          MeetingStatus @default(SCHEDULED)
  botName         String        @default("Aramis Recorder")
  errorMessage    String?
  retryCount      Int           @default(0)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  user          User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  calendarEvent CalendarEvent? @relation(fields: [calendarEventId], references: [id])
  recording     Recording?
  transcript    Transcript?
  summary       MeetingSummary?
  shares        Share[]
  participants  Participant[]
}

enum MeetingPlatform {
  ZOOM
  TEAMS
  GOOGLE_MEET
}

enum MeetingStatus {
  SCHEDULED
  JOINING
  WAITING
  RECORDING
  STOPPED
  PROCESSING
  COMPLETED
  FAILED
  CANCELLED
}

model Participant {
  id        String   @id @default(cuid())
  meetingId String
  name      String
  email     String?
  isHost    Boolean  @default(false)
  joinedAt  DateTime?
  leftAt    DateTime?

  meeting Meeting @relation(fields: [meetingId], references: [id], onDelete: Cascade)
}

// ==================== RECORDING ====================

model Recording {
  id          String   @id @default(cuid())
  meetingId   String   @unique
  status      RecordingStatus @default(PENDING)

  // Storage
  videoUrl    String?
  audioUrl    String?
  hlsUrl      String?
  thumbnailUrl String?

  // Metadata
  fileSize    BigInt?  // in bytes
  duration    Int?     // in seconds
  width       Int?
  height      Int?
  frameRate   Int?
  codec       String?

  // Processing
  processedAt DateTime?
  errorMessage String?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  meeting Meeting @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  chunks  RecordingChunk[]
}

enum RecordingStatus {
  PENDING
  RECORDING
  PROCESSING
  COMPLETED
  FAILED
}

model RecordingChunk {
  id          String   @id @default(cuid())
  recordingId String
  chunkNumber Int
  s3Key       String
  fileSize    BigInt
  startTime   DateTime
  endTime     DateTime
  duration    Int      // in seconds
  isUploaded  Boolean  @default(false)
  createdAt   DateTime @default(now())

  recording Recording @relation(fields: [recordingId], references: [id], onDelete: Cascade)

  @@unique([recordingId, chunkNumber])
}

// ==================== TRANSCRIPT ====================

model Transcript {
  id          String   @id @default(cuid())
  meetingId   String   @unique
  status      TranscriptStatus @default(PENDING)

  // Content
  fullText    String?  @db.Text
  wordCount   Int?
  language    String?
  confidence  Float?

  // Provider info
  provider    String?
  externalId  String?

  // Processing
  processedAt DateTime?
  errorMessage String?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  meeting  Meeting @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  segments TranscriptSegment[]
  speakers TranscriptSpeaker[]
}

enum TranscriptStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

model TranscriptSegment {
  id           String  @id @default(cuid())
  transcriptId String
  speakerId    String?
  text         String  @db.Text
  startTime    Float   // seconds
  endTime      Float   // seconds
  confidence   Float?
  order        Int

  transcript Transcript         @relation(fields: [transcriptId], references: [id], onDelete: Cascade)
  speaker    TranscriptSpeaker? @relation(fields: [speakerId], references: [id])
  words      TranscriptWord[]

  @@index([transcriptId, order])
}

model TranscriptWord {
  id        String @id @default(cuid())
  segmentId String
  text      String
  startTime Float
  endTime   Float
  confidence Float?
  order     Int

  segment TranscriptSegment @relation(fields: [segmentId], references: [id], onDelete: Cascade)

  @@index([segmentId, order])
}

model TranscriptSpeaker {
  id              String  @id @default(cuid())
  transcriptId    String
  label           String  // "Speaker 1", "Speaker 2"
  identifiedName  String?
  totalDuration   Float?  // seconds
  segmentCount    Int     @default(0)

  transcript Transcript         @relation(fields: [transcriptId], references: [id], onDelete: Cascade)
  segments   TranscriptSegment[]

  @@unique([transcriptId, label])
}

// ==================== AI SUMMARY ====================

model MeetingSummary {
  id          String   @id @default(cuid())
  meetingId   String   @unique
  templateId  String?
  status      SummaryStatus @default(PENDING)

  // Content (JSON stored as text for flexibility)
  overview    String?  @db.Text
  keyPoints   Json?    // KeyPoint[]
  decisions   Json?    // Decision[]
  actionItems Json?    // ActionItem[]
  nextSteps   String?  @db.Text
  customSections Json? // CustomSection[]
  rawResponse Json?    // Full LLM response

  // LLM info
  modelUsed       String?
  promptTokens    Int?
  completionTokens Int?

  // Versioning
  version         Int     @default(1)
  previousVersionId String?

  // Processing
  generatedAt  DateTime?
  errorMessage String?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  meeting  Meeting          @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  template SummaryTemplate? @relation(fields: [templateId], references: [id])
}

enum SummaryStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

// ==================== TEMPLATES ====================

model SummaryTemplate {
  id          String   @id @default(cuid())
  userId      String
  name        String
  description String?

  // Sections
  sections    Json     // TemplateSection[]

  // Settings
  isDefault   Boolean  @default(false)
  includeDefaultSections Boolean @default(true)

  // Targeting
  applyTo     Json?    // TemplateTarget

  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user      User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  summaries MeetingSummary[]

  @@unique([userId, name])
}

// ==================== RECORDING RULES ====================

model RecordingRule {
  id          String   @id @default(cuid())
  userId      String
  name        String
  description String?

  // Conditions (all must match)
  conditions  Json     // RuleCondition[]

  // Action
  action      RuleAction @default(RECORD)
  templateId  String?

  // Priority (lower = higher priority)
  priority    Int      @default(100)

  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

enum RuleAction {
  RECORD
  SKIP
  ASK
}

// ==================== SHARING ====================

model Share {
  id          String   @id @default(cuid())
  meetingId   String
  userId      String
  token       String   @unique @default(cuid())

  // Permissions
  canView     Boolean  @default(true)
  canDownload Boolean  @default(false)
  canEdit     Boolean  @default(false)

  // Access control
  password    String?
  expiresAt   DateTime?

  // Stats
  viewCount   Int      @default(0)
  lastViewedAt DateTime?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  meeting Meeting @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

---

## 11. API Specification

### 11.1 Calendar Endpoints

```
POST   /api/calendars/connect/google     - Initiate Google OAuth
POST   /api/calendars/connect/microsoft  - Initiate Microsoft OAuth
GET    /api/calendars/callback/google    - Google OAuth callback
GET    /api/calendars/callback/microsoft - Microsoft OAuth callback
GET    /api/calendars                    - List connected calendars
DELETE /api/calendars/:connectionId      - Disconnect calendar
PATCH  /api/calendars/:calendarId        - Update calendar settings
POST   /api/calendars/sync               - Force calendar sync
```

### 11.2 Meeting Endpoints

```
GET    /api/meetings                     - List meetings
POST   /api/meetings                     - Create meeting (manual URL)
GET    /api/meetings/:id                 - Get meeting details
DELETE /api/meetings/:id                 - Delete meeting
POST   /api/meetings/:id/start           - Start recording now
POST   /api/meetings/:id/stop            - Stop recording
```

### 11.3 Recording Endpoints

```
GET    /api/recordings/:meetingId        - Get recording details
GET    /api/recordings/:meetingId/stream - Get streaming URL
GET    /api/recordings/:meetingId/download - Get download URL
```

### 11.4 Transcript Endpoints

```
GET    /api/transcripts/:meetingId       - Get full transcript
GET    /api/transcripts/:meetingId/search - Search transcript
GET    /api/transcripts/:meetingId/export - Export transcript
PATCH  /api/transcripts/:meetingId/speakers/:speakerId - Update speaker name
```

### 11.5 Summary Endpoints

```
GET    /api/summaries/:meetingId         - Get meeting summary
POST   /api/summaries/:meetingId/regenerate - Regenerate summary
PATCH  /api/summaries/:meetingId         - Update summary
GET    /api/summaries/:meetingId/versions - Get summary versions
```

### 11.6 Template Endpoints

```
GET    /api/templates                    - List templates
POST   /api/templates                    - Create template
GET    /api/templates/:id                - Get template
PATCH  /api/templates/:id                - Update template
DELETE /api/templates/:id                - Delete template
POST   /api/templates/:id/preview        - Preview template with sample
```

### 11.7 Rules Endpoints

```
GET    /api/rules                        - List recording rules
POST   /api/rules                        - Create rule
GET    /api/rules/:id                    - Get rule
PATCH  /api/rules/:id                    - Update rule
DELETE /api/rules/:id                    - Delete rule
POST   /api/rules/test                   - Test rules against meeting
```

---

## 12. Security & Privacy

### 12.1 Data Encryption

- All OAuth tokens encrypted at rest (AES-256)
- Recordings encrypted in S3 (SSE-S3 or SSE-KMS)
- Database connections use TLS
- All API traffic over HTTPS

### 12.2 Access Control

- Users can only access their own data
- Shared links use unguessable tokens
- Optional password protection for shares
- Rate limiting on all endpoints

### 12.3 Consent & Compliance

- Bot announces presence when joining (name visible)
- Optional notification to all participants
- Recordings deleted on user request
- Data export functionality for GDPR

### 12.4 Token Management

- OAuth refresh tokens rotated on use
- Access tokens cached in Redis with TTL
- Revoked tokens blacklisted

---

## 13. Error Handling

### 13.1 Bot Errors

| Error | Recovery Strategy |
|-------|-------------------|
| Meeting not found | Mark as failed, notify user |
| Join rejected | Retry once, then fail |
| Waiting room timeout | Wait 15min, then leave |
| Recording failed | Retry from last chunk |
| Audio capture failed | Continue with video only |
| Browser crash | Restart bot, rejoin if meeting active |

### 13.2 Processing Errors

| Error | Recovery Strategy |
|-------|-------------------|
| Transcription failed | Retry with different provider |
| Summary generation failed | Retry, then fallback to basic summary |
| Chunk upload failed | Retry with exponential backoff |
| Merge failed | Keep individual chunks available |

### 13.3 API Errors

Standard HTTP error responses with JSON body:

```json
{
  "error": {
    "code": "MEETING_NOT_FOUND",
    "message": "Meeting with ID xyz not found",
    "details": {}
  }
}
```

---

## Appendix A: Flow Diagrams

### A.1 Full Recording Flow

```
User connects calendar
         │
         ▼
Calendar sync fetches events
         │
         ▼
Events with meeting URLs identified
         │
         ▼
Recording rules applied
         │
         ▼
Bot scheduled for matching meetings
         │
         ▼
Bot joins meeting 1 min before start
         │
         ▼
Recording starts (chunks uploaded continuously)
         │
         ├──────────────────────────────────────┐
         ▼                                      ▼
Audio streamed to transcription           Video chunks stored
         │                                      │
         ▼                                      ▼
Real-time transcript available           Meeting ends detected
         │                                      │
         │◄─────────────────────────────────────┘
         ▼
Chunks merged into final video
         │
         ▼
Final transcript generated (if not real-time)
         │
         ▼
AI summary generated using template
         │
         ▼
User notified - meeting ready
```

---

*End of Specification Document*
