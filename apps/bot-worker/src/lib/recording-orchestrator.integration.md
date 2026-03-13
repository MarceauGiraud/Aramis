# RecordingOrchestrator Integration Guide

This document describes how to integrate the `RecordingOrchestrator` into the existing Aramis bot infrastructure.

## Overview

The `RecordingOrchestrator` replaces the current Playwright-based video recording in `base.ts` with a more robust solution using FFmpeg for:

1. **Video capture** from Xvfb (X11 display)
2. **Audio capture** from PulseAudio
3. **Live S3 uploads** of recording chunks
4. **Audio/video merging** for final output
5. **Event-driven architecture** for progress tracking

## Current Flow (base.ts)

```typescript
// Current implementation in base.ts
class BaseMeetingBot {
  async startRecording() {
    this.isRecording = true;
    const video = this.page.video();
    this.recordingPath = await video.path();
  }

  async stopRecording() {
    const video = this.page.video();
    await this.page.close();
    this.recordingPath = await video.path();
  }

  async saveRecording() {
    await this.stopRecording();
    // Rename file with meetingId
    return this.recordingPath;
  }
}
```

## New Flow with RecordingOrchestrator

### Step 1: Import and Initialize

```typescript
// In base.ts
import {
  RecordingOrchestrator,
  createRecordingOrchestrator,
  RecordingOrchestratorConfig,
} from '../lib/recording-orchestrator';

export abstract class BaseMeetingBot {
  protected recordingOrchestrator: RecordingOrchestrator | null = null;

  // ... existing code ...

  async initialize(): Promise<void> {
    // ... existing browser initialization ...

    // Initialize the recording orchestrator
    this.recordingOrchestrator = createRecordingOrchestrator({
      meetingId: this.config.meetingId,
      display: process.env.DISPLAY || ':99',
      audioSource: process.env.PULSE_SOURCE || 'default',
      tempDir: '/tmp/recordings',
      resolution: { width: 1920, height: 1080 },
      frameRate: 30,
      enableLiveUpload: true,
    });

    // Set up event handlers
    this.setupRecordingEventHandlers();
  }

  private setupRecordingEventHandlers(): void {
    if (!this.recordingOrchestrator) return;

    this.recordingOrchestrator.on('chunk-uploaded', (event) => {
      logger.info(`Chunk uploaded: ${event.s3Url} (${event.size} bytes)`);
    });

    this.recordingOrchestrator.on('recording-complete', (event) => {
      logger.info(`Recording complete: ${event.duration}s`);
      logger.info(`  Video: ${event.videoUrl}`);
      logger.info(`  Audio: ${event.audioUrl}`);
      logger.info(`  Merged: ${event.mergedUrl}`);
    });

    this.recordingOrchestrator.on('error', (event) => {
      logger.error(`Recording error in ${event.phase}: ${event.error.message}`);
      if (!event.recoverable) {
        // Handle fatal error
        this.handleRecordingError(event.error);
      }
    });
  }
}
```

### Step 2: Replace startRecording

```typescript
async startRecording(options: RecordingOptions = {}): Promise<void> {
  if (!this.recordingOrchestrator) {
    throw new Error('Recording orchestrator not initialized');
  }

  await this.recordingOrchestrator.start();
  this.isRecording = true;
  this.startTime = new Date();

  logger.info(`Recording started for meeting: ${this.config.meetingId}`);
}
```

### Step 3: Replace stopRecording

```typescript
async stopRecording(): Promise<string | null> {
  if (!this.isRecording || !this.recordingOrchestrator) {
    return null;
  }

  logger.info('Stopping recording...');

  const recordingInfo = await this.recordingOrchestrator.stop({
    merge: true,    // Merge audio and video
    upload: true,   // Upload to S3
    cleanup: true,  // Clean up temp files
  });

  this.isRecording = false;

  // Return the S3 URL (merged > video > local path)
  return recordingInfo.s3MergedUrl
    ?? recordingInfo.s3VideoUrl
    ?? recordingInfo.mergedPath
    ?? recordingInfo.videoPath;
}
```

### Step 4: Replace saveRecording

```typescript
async saveRecording(): Promise<string> {
  const recordingPath = await this.stopRecording();

  if (!recordingPath) {
    throw new Error('No recording available');
  }

  return recordingPath;
}
```

### Step 5: Update cleanup

```typescript
async cleanup(): Promise<void> {
  logger.info('Cleaning up bot resources');

  // Force cleanup recording orchestrator if still running
  if (this.recordingOrchestrator?.isRecording()) {
    await this.recordingOrchestrator.forceCleanup();
  }

  // ... existing browser cleanup ...
}
```

## Integration with index.ts Worker

### Current Flow

```typescript
// In index.ts
const recordingPath = await bot.saveRecording();
let videoUrl = recordingPath;

if (isS3Configured()) {
  videoUrl = await uploadRecording(recordingPath, meetingId);
}
```

### New Flow

```typescript
// In index.ts
const recordingPath = await bot.saveRecording();

// The orchestrator already uploaded to S3, so recordingPath is the S3 URL
// No need to call uploadRecording separately

// The audio is already uploaded separately for transcription
const recordingInfo = bot.getRecordingInfo();

// Update meeting with recording info
await prisma.meeting.update({
  where: { id: meetingId },
  data: {
    status: 'PROCESSING',
    actualEnd: new Date(),
  },
});

// Create recording record with both video and audio URLs
const recording = await prisma.recording.create({
  data: {
    meetingId,
    videoUrl: recordingInfo.s3MergedUrl ?? recordingInfo.s3VideoUrl ?? recordingPath,
    audioUrl: recordingInfo.s3AudioUrl, // Audio URL for transcription
    status: recordingInfo.s3MergedUrl ? 'COMPLETED' : 'PROCESSING',
  },
});

// Queue transcription with audio URL
if (recordingInfo.s3AudioUrl && process.env.DEEPGRAM_API_KEY) {
  await transcriptionQueue.add('transcribe', {
    meetingId,
    recordingId: recording.id,
    audioUrl: recordingInfo.s3AudioUrl, // Use audio URL directly
  });
}
```

## Environment Variables

The orchestrator uses these environment variables:

```bash
# X11 Display (from Xvfb)
DISPLAY=:99

# PulseAudio source
PULSE_SOURCE=default

# S3 Configuration (existing)
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=recordings
S3_REGION=us-east-1
```

## Docker Integration

The bot container needs Xvfb and PulseAudio:

```dockerfile
# In Dockerfile
RUN apt-get update && apt-get install -y \
    xvfb \
    pulseaudio \
    ffmpeg \
    x11-utils

# Start Xvfb
ENV DISPLAY=:99
CMD xvfb-run --server-args="-screen 0 1920x1080x24" npm start
```

## Comparison: Old vs New Architecture

### Old Architecture (Playwright recordVideo)

```
Browser Page
    |
    v
Playwright recordVideo (VP8, no audio)
    |
    v
Local WebM file
    |
    v
Upload to S3
    |
    v
Queue transcription (audio extraction needed)
```

**Limitations:**
- No separate audio capture (audio extracted from video)
- Single file upload at end (no live upload)
- Limited control over encoding parameters
- Audio quality may be poor for transcription

### New Architecture (RecordingOrchestrator)

```
Xvfb Display  ----FFmpeg----> Video (WebM/VP9)
                                    |
                                    +---> S3 Upload
                                    |
PulseAudio    ----FFmpeg----> Audio (WAV/PCM)
                                    |
                                    +---> S3 Upload (for transcription)
                                    |
                              FFmpeg Merge
                                    |
                                    v
                              Merged WebM -----> S3 Upload
```

**Benefits:**
- High-quality audio for transcription (16kHz WAV)
- Separate audio track for immediate transcription
- Live chunk uploads (future enhancement)
- Full control over encoding parameters
- Event-driven progress tracking
- Graceful error handling and recovery

## Event Flow

```
start()
  |
  +-- 'chunk-uploaded' (if live upload enabled)
  |
stop()
  |
  +-- merge audio/video
  |
  +-- upload to S3
  |       |
  |       +-- 'chunk-uploaded' (video)
  |       +-- 'chunk-uploaded' (audio)
  |       +-- 'chunk-uploaded' (merged)
  |
  +-- 'recording-complete'

On any error:
  +-- 'error' { phase, recoverable }
```

## Error Handling

The orchestrator provides structured error events:

```typescript
interface RecordingErrorEvent {
  error: Error;
  phase: 'video-capture' | 'audio-capture' | 'merge' | 'upload' | 'cleanup';
  recoverable: boolean;
}
```

**Recoverable errors** (continue recording):
- Audio capture failure
- Merge failure
- Upload failure

**Non-recoverable errors** (stop recording):
- Video capture failure

## Future Enhancements

1. **Live Chunked Uploads**: Upload video/audio in 30-second chunks during recording
2. **Bandwidth Adaptation**: Adjust quality based on upload bandwidth
3. **Redundant Audio**: Capture audio from both browser and system simultaneously
4. **HLS/DASH Streaming**: Generate streamable segments for live preview
5. **Speaker Diarization**: Separate audio tracks per speaker
