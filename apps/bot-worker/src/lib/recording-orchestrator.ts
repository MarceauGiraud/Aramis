/**
 * RecordingOrchestrator
 *
 * Coordinates video+audio capture and upload for the Aramis meeting recorder.
 *
 * Architecture (two-process A/V):
 * - Video FFmpeg: x11grab -> video-only MP4/WebM file
 * - Audio FFmpeg: PulseAudio -> 48kHz stereo WAV file + 16kHz mono PCM on pipe:1
 *   The pipe:1 feeds the PassThrough stream for live transcription (Deepgram/WebSocket).
 * - After recording stops, a merge step combines video + audio into the final file.
 * - The 48kHz WAV is kept for transcription upload (or a 16kHz mono WAV is extracted).
 *
 * Features:
 * - Pause/Resume recording via SIGSTOP/SIGCONT
 * - Multiple formats: WebM (VP9), MP4 (H.264), MP3 (audio-only)
 * - Configurable resolution
 * - Live audio stream for transcription/WebSocket
 * - NVENC GPU acceleration when available
 * - ChunkUploader watches the video file during recording for live S3 upload
 *
 * Events:
 * - 'chunk-uploaded': Emitted when a chunk is uploaded to S3
 * - 'recording-complete': Emitted when recording stops and final upload completes
 * - 'error': Emitted on any error during recording or upload
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, PassThrough } from 'stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { logger } from './logger';
import { isS3Configured, getS3Client } from './s3-config';
import { ChunkUploader } from './chunk-uploader';
import { FORMAT_CONFIG, RESOLUTION_MAP } from '@aramis/shared';
import type { RecordingFormat, Resolution } from '@aramis/shared';

// ============================================================================
// GPU Detection
// ============================================================================

let _gpuAvailable: boolean | null = null;

/**
 * Check if NVIDIA GPU encoding (NVENC) is available.
 * Runs a tiny test encode to confirm the hardware is actually usable.
 * Result is cached for the process lifetime.
 */
function isNvencAvailable(): boolean {
  if (_gpuAvailable !== null) return _gpuAvailable;
  try {
    execSync('ffmpeg -y -f lavfi -i nullsrc=s=16x16:d=0.1 -c:v h264_nvenc -f null - 2>/dev/null', {
      timeout: 5000,
      stdio: 'pipe',
    });
    _gpuAvailable = true;
    logger.info('NVENC GPU encoding available — using hardware acceleration');
  } catch {
    _gpuAvailable = false;
    logger.info('NVENC not available — using software encoding');
  }
  return _gpuAvailable;
}

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface RecordingOrchestratorConfig {
  /** Meeting ID for organizing recordings */
  meetingId: string;
  /** X11 display to capture (e.g., ':99') */
  display?: string;
  /** PulseAudio source for audio capture (e.g., 'default' or device name) */
  audioSource?: string;
  /** Temporary directory for storing chunks */
  tempDir?: string;
  /** Duration of each chunk in seconds (for live upload) */
  chunkDurationSec?: number;
  /** Video resolution */
  resolution?: { width: number; height: number };
  /** Video frame rate */
  frameRate?: number;
  /** Enable live chunked uploads */
  enableLiveUpload?: boolean;
  /** S3 bucket name */
  s3Bucket?: string;
  /** S3 key prefix */
  s3KeyPrefix?: string;
  /** Recording format: webm, mp4, or mp3 */
  format?: RecordingFormat;
  /** Resolution preset key */
  resolutionPreset?: Resolution;
  /** Video capture mode: 'x11grab' for screen capture, 'webrtc' for browser MediaRecorder */
  captureMode?: 'x11grab' | 'webrtc';
}

export interface PauseEvent {
  pausedAt: Date;
  resumedAt: Date | null;
  durationMs: number;
}

export interface RecordingInfo {
  meetingId: string;
  status: RecordingStatus;
  startTime: Date | null;
  endTime: Date | null;
  duration: number;
  /** Path to the video-only file (MP4/WebM) */
  videoPath: string | null;
  /** Path to the 48kHz stereo WAV audio file */
  audioPath: string | null;
  /** Path to the merged A/V file produced after recording stops */
  mergedPath: string | null;
  s3VideoUrl: string | null;
  s3AudioUrl: string | null;
  /** S3 URL of the merged A/V file */
  s3MergedUrl: string | null;
  chunksUploaded: number;
  errors: string[];
  format: RecordingFormat;
  pauseEvents: PauseEvent[];
  totalPauseDuration: number;
}

export type RecordingStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'uploading'
  | 'complete'
  | 'error';

export interface ChunkUploadedEvent {
  chunkIndex: number;
  chunkPath: string;
  s3Url: string;
  type: 'video' | 'audio';
  size: number;
}

export interface RecordingCompleteEvent {
  meetingId: string;
  duration: number;
  /** URL of the video file */
  videoUrl: string | null;
  /** URL of the audio file for transcription */
  audioUrl: string | null;
  /** URL of the merged A/V file */
  mergedUrl: string | null;
  format: RecordingFormat;
}

export interface RecordingErrorEvent {
  error: Error;
  phase: 'video-capture' | 'audio-capture' | 'merge' | 'upload' | 'cleanup';
  recoverable: boolean;
}

// ============================================================================
// RecordingOrchestrator Class
// ============================================================================

export class RecordingOrchestrator extends EventEmitter {
  private config: Required<RecordingOrchestratorConfig>;
  private status: RecordingStatus = 'idle';
  private startTime: Date | null = null;
  private endTime: Date | null = null;

  // FFmpeg processes
  /** Video FFmpeg: x11grab -> video-only file */
  private videoProcess: ChildProcess | null = null;
  /** Audio FFmpeg: pulse -> WAV file + pipe:1 for live transcription */
  private audioProcess: ChildProcess | null = null;

  // Output paths
  /** Path to the video-only file (MP4/WebM) */
  private videoPath: string | null = null;
  /** Path to the 48kHz stereo WAV audio file */
  private audioPath: string | null = null;
  /** Path to the merged A/V file (produced after recording stops) */
  private mergedPath: string | null = null;
  /** Alias for mergedPath (backward compatibility) */
  private get combinedPath(): string | null {
    return this.mergedPath;
  }
  /** Path to 16kHz mono WAV extracted for transcription upload */
  private transcriptionAudioPath: string | null = null;

  // S3 URLs
  private s3VideoUrl: string | null = null;
  private s3AudioUrl: string | null = null;
  private s3MergedUrl: string | null = null;

  // Chunk tracking
  private chunksUploaded = 0;
  private chunkIndex = 0;

  // Error tracking
  private errors: string[] = [];
  private audioFailed = false;

  // Browser chrome height (measured dynamically, default 80px)
  private chromeHeight = 80;

  // S3 client
  private s3Client: S3Client | null = null;

  // Pause tracking
  private pauseEvents: PauseEvent[] = [];
  private totalPauseDurationMs = 0;
  private currentPauseStart: Date | null = null;

  // Format config
  private formatConfig: (typeof FORMAT_CONFIG)[RecordingFormat];

  // Live chunked upload
  private chunkUploader: ChunkUploader | null = null;

  // Audio stream fork for live consumers (transcription, WebSocket)
  private audioStreamPassthrough: PassThrough | null = null;

  constructor(config: RecordingOrchestratorConfig) {
    super();

    const format = config.format ?? 'webm';
    this.formatConfig = FORMAT_CONFIG[format];

    // If resolutionPreset is provided, use it; otherwise fall back to explicit resolution
    const resolvedResolution = config.resolutionPreset
      ? RESOLUTION_MAP[config.resolutionPreset]
      : (config.resolution ?? { width: 1920, height: 1080 });

    // Apply defaults
    this.config = {
      meetingId: config.meetingId,
      display: config.display ?? process.env.DISPLAY ?? ':99',
      audioSource: config.audioSource ?? 'default',
      tempDir: config.tempDir ?? '/tmp/recordings',
      chunkDurationSec: config.chunkDurationSec ?? 30,
      resolution: resolvedResolution,
      frameRate: config.frameRate ?? 30,
      enableLiveUpload: config.enableLiveUpload ?? true,
      s3Bucket: config.s3Bucket ?? process.env.S3_BUCKET ?? 'recordings',
      s3KeyPrefix: config.s3KeyPrefix ?? 'recordings',
      format,
      resolutionPreset: config.resolutionPreset ?? '1080p',
      captureMode: config.captureMode ?? 'x11grab',
    };

    // Initialize S3 client if configured (singleton shared across all modules)
    if (isS3Configured()) {
      this.s3Client = getS3Client();
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Start recording video and audio
   */
  async start(): Promise<void> {
    if (this.status !== 'idle') {
      throw new Error(`Cannot start recording: current status is '${this.status}'`);
    }

    this.status = 'starting';
    this.startTime = new Date();
    this.errors = [];
    this.pauseEvents = [];
    this.totalPauseDurationMs = 0;
    this.currentPauseStart = null;

    logger.info(`Starting recording for meeting: ${this.config.meetingId} (format: ${this.config.format})`);

    // Ensure temp directory exists
    await this.ensureTempDir();

    // Configure display resolution if on Linux
    this.configureDisplay();

    // Generate output paths based on format
    const timestamp = Date.now();
    const ext = this.formatConfig.ext;

    if (this.config.format === 'mp3') {
      // Audio-only: no video file, audioPath doubles as the main output
      this.audioPath = path.join(this.config.tempDir, `${this.config.meetingId}_${timestamp}_audio.${ext}`);
    } else {
      // In WebRTC mode, the browser sends WebM regardless of the configured format
      const videoExt = this.config.captureMode === 'webrtc' ? 'webm' : ext;
      // Video-only file (will be merged with audio after recording)
      this.videoPath = path.join(this.config.tempDir, `${this.config.meetingId}_${timestamp}_video.${videoExt}`);
      // 48kHz stereo WAV for the audio track
      this.audioPath = path.join(this.config.tempDir, `${this.config.meetingId}_${timestamp}_audio.wav`);
      // Merged A/V file (produced after recording stops)
      this.mergedPath = path.join(this.config.tempDir, `${this.config.meetingId}_${timestamp}_merged.${videoExt}`);
    }

    // 16kHz mono WAV for transcription upload (extracted from audio WAV after recording)
    this.transcriptionAudioPath = path.join(this.config.tempDir, `${this.config.meetingId}_${timestamp}_audio_16k.wav`);

    try {
      if (this.config.format === 'mp3') {
        // Audio-only recording
        await this.startAudioOnlyCapture();
      } else if (this.config.captureMode === 'webrtc') {
        // WebRTC mode: video comes from browser MediaRecorder via WebSocket
        // Only start audio capture (PulseAudio), video file will be written by WebRTC handler
        logger.info('WebRTC capture mode: skipping FFmpeg video, waiting for browser video chunks');
        await this.startAudioCapture();
      } else {
        // x11grab mode: FFmpeg captures both video and audio from the display
        await Promise.all([this.startVideoCapture(), this.startAudioCapture()]);
      }

      // Start live chunked upload on the VIDEO file if enabled and S3 is configured.
      // The video file is written in real-time by FFmpeg, so ChunkUploader can watch it.
      // For webrtc mode, ChunkUploader is started when the first video chunk arrives.
      if (this.config.captureMode !== 'webrtc' && this.config.enableLiveUpload && this.s3Client && this.videoPath) {
        try {
          this.chunkUploader = new ChunkUploader({
            uploadIntervalMs: (this.config.chunkDurationSec || 30) * 1000,
            contentType: this.formatConfig.mime,
          });
          await this.chunkUploader.start(this.videoPath, this.config.meetingId);
          logger.info('Live chunked upload started (watching video file)');
        } catch (err) {
          logger.warn(`Failed to start chunk uploader, will fall back to full upload: ${err}`);
          this.chunkUploader = null;
        }
      }

      this.status = 'recording';
      logger.info(`Recording started for meeting: ${this.config.meetingId}`);
    } catch (error) {
      this.status = 'error';
      const err = error instanceof Error ? error : new Error(String(error));
      this.errors.push(err.message);
      this.emitError(err, 'video-capture', false);
      throw error;
    }
  }

  /**
   * Pause recording by sending SIGSTOP to FFmpeg processes
   */
  pause(): void {
    if (this.status !== 'recording') {
      throw new Error(`Cannot pause recording: current status is '${this.status}'`);
    }

    logger.info(`Pausing recording for meeting: ${this.config.meetingId}`);

    // Send SIGSTOP to freeze FFmpeg processes
    if (this.videoProcess && !this.videoProcess.killed) {
      this.videoProcess.kill('SIGSTOP');
    }
    if (this.audioProcess && !this.audioProcess.killed) {
      this.audioProcess.kill('SIGSTOP');
    }

    this.currentPauseStart = new Date();
    this.status = 'paused';

    logger.info('Recording paused');
  }

  /**
   * Resume recording by sending SIGCONT to FFmpeg processes
   */
  resume(): void {
    if (this.status !== 'paused') {
      throw new Error(`Cannot resume recording: current status is '${this.status}'`);
    }

    logger.info(`Resuming recording for meeting: ${this.config.meetingId}`);

    // Send SIGCONT to unfreeze FFmpeg processes
    if (this.videoProcess && !this.videoProcess.killed) {
      this.videoProcess.kill('SIGCONT');
    }
    if (this.audioProcess && !this.audioProcess.killed) {
      this.audioProcess.kill('SIGCONT');
    }

    // Track pause duration
    if (this.currentPauseStart) {
      const now = new Date();
      const pauseDuration = now.getTime() - this.currentPauseStart.getTime();
      this.totalPauseDurationMs += pauseDuration;

      this.pauseEvents.push({
        pausedAt: this.currentPauseStart,
        resumedAt: now,
        durationMs: pauseDuration,
      });

      this.currentPauseStart = null;
    }

    this.status = 'recording';

    logger.info(`Recording resumed. Total pause time: ${Math.floor(this.totalPauseDurationMs / 1000)}s`);
  }

  /**
   * Check if recording is paused
   */
  isPaused(): boolean {
    return this.status === 'paused';
  }

  /**
   * Check if audio capture is (or was) active and healthy.
   * Returns false if the audio FFmpeg process exited with an error.
   */
  hasAudio(): boolean {
    return !this.audioFailed && this.audioProcess !== null;
  }

  /**
   * Stop recording and finalize outputs
   *
   * @param options - Options for stopping
   * @param options.upload - Whether to upload to S3 (default: true if S3 configured)
   * @param options.cleanup - Whether to cleanup temp files after upload (default: true)
   */
  async stop(
    options: {
      merge?: boolean;
      upload?: boolean;
      cleanup?: boolean;
      /** Trim this many seconds from the start of the recording (waiting room frames) */
      trimStartSeconds?: number;
      /** Trim the recording to this duration (seconds) after start trim — removes trailing frames after meeting ended */
      trimEndSeconds?: number;
    } = {},
  ): Promise<RecordingInfo> {
    const { upload = true, cleanup = true } = options;

    if (this.status !== 'recording' && this.status !== 'paused') {
      throw new Error(`Cannot stop recording: current status is '${this.status}'`);
    }

    // Auto-resume if paused before stopping
    if (this.status === 'paused') {
      logger.info('Auto-resuming paused recording before stopping');
      this.resume();
    }

    this.status = 'stopping';
    this.endTime = new Date();

    logger.info(`Stopping recording for meeting: ${this.config.meetingId}`);

    try {
      // Stop FFmpeg processes
      logger.info('Stopping FFmpeg capture processes');
      if (this.config.format === 'mp3') {
        await this.stopProcess(this.audioProcess, 'audio');
        this.audioProcess = null;
      } else {
        await Promise.all([this.stopProcess(this.videoProcess, 'video'), this.stopProcess(this.audioProcess, 'audio')]);
        this.videoProcess = null;
        this.audioProcess = null;
      }
      logger.info('FFmpeg capture processes stopped');

      // Merge video + audio into the final file (skip if audio capture failed)
      if (this.config.format !== 'mp3' && !this.audioFailed) {
        try {
          await this.mergeAudioVideo(options.trimStartSeconds, options.trimEndSeconds);
        } catch (error) {
          logger.error('Merge failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Non-fatal for upload: video file can still be uploaded separately
          this.mergedPath = null;
        }
      } else if (this.audioFailed && this.config.format !== 'mp3') {
        logger.warn('Audio capture failed — skipping merge and audio extraction');
      }

      // Extract 16kHz mono WAV from the audio file for transcription upload.
      // The audio WAV is 48kHz stereo; we need 16kHz mono for transcription
      // services (Deepgram, AssemblyAI).
      if (this.config.format !== 'mp3' && !this.audioFailed) {
        try {
          await this.extractTranscriptionAudio();
        } catch (error) {
          // Non-fatal: transcription can still work from the audio WAV
          logger.warn('Transcription audio extraction failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.transcriptionAudioPath = null;
        }
      }

      // Finalize live chunked upload if active
      if (this.chunkUploader) {
        try {
          const s3Url = await this.chunkUploader.stop();
          this.s3VideoUrl = s3Url;
          logger.info('Live chunked upload finalized');
        } catch (err) {
          logger.warn(`Chunk uploader finalize failed, falling back to full upload: ${err}`);
          this.chunkUploader = null; // fall through to full upload
        }
      }

      // Give Supabase Storage time to finalize the multipart upload
      // before starting another upload with the same S3Client
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Upload to S3 if requested and configured
      if (upload && this.s3Client) {
        this.status = 'uploading';
        logger.info('Starting S3 upload of final recordings');
        await this.uploadFinalRecordings();
        logger.info('S3 upload complete');
      } else {
        logger.info(`S3 upload skipped (upload=${upload}, s3Configured=${!!this.s3Client})`);
      }

      // Cleanup temp files if requested
      if (cleanup && upload && this.s3Client) {
        await this.cleanupTempFiles();
      }

      this.status = 'complete';

      // Emit recording complete event
      const completeEvent: RecordingCompleteEvent = {
        meetingId: this.config.meetingId,
        duration: this.getDuration(),
        videoUrl: this.s3VideoUrl,
        audioUrl: this.s3AudioUrl,
        mergedUrl: this.s3MergedUrl,
        format: this.config.format,
      };
      this.emit('recording-complete', completeEvent);

      logger.info(`Recording complete for meeting: ${this.config.meetingId}`);

      return this.getRecordingInfo();
    } catch (error) {
      this.status = 'error';
      const err = error instanceof Error ? error : new Error(String(error));
      this.errors.push(err.message);
      throw error;
    }
  }

  /**
   * Get current recording information
   */
  getRecordingInfo(): RecordingInfo {
    return {
      meetingId: this.config.meetingId,
      status: this.status,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.getDuration(),
      videoPath: this.videoPath,
      audioPath: this.audioPath,
      mergedPath: this.mergedPath,
      s3VideoUrl: this.s3VideoUrl,
      s3AudioUrl: this.s3AudioUrl,
      s3MergedUrl: this.s3MergedUrl,
      chunksUploaded: this.chunksUploaded,
      errors: [...this.errors],
      format: this.config.format,
      pauseEvents: [...this.pauseEvents],
      totalPauseDuration: Math.floor(this.totalPauseDurationMs / 1000),
    };
  }

  /**
   * Get current recording status
   */
  getStatus(): RecordingStatus {
    return this.status;
  }

  /**
   * Check if currently recording
   */
  isRecording(): boolean {
    return this.status === 'recording';
  }

  /**
   * Get the recording start time.
   */
  getStartTime(): Date | null {
    return this.startTime;
  }

  /**
   * Write a WebRTC video chunk (WebM data from browser MediaRecorder).
   * Called by the WebSocket server when it receives type=200 messages.
   */
  writeWebRTCVideoChunk(chunk: Buffer): void {
    if (!this.videoPath) {
      // Generate video path if not already set
      const timestamp = Date.now();
      this.videoPath = path.join(this.config.tempDir, `${this.config.meetingId}_${timestamp}_video.webm`);
      this.mergedPath = path.join(this.config.tempDir, `${this.config.meetingId}_${timestamp}_merged.webm`);
    }

    try {
      fs.appendFileSync(this.videoPath, chunk);
    } catch (error) {
      logger.warn(`Failed to write WebRTC video chunk: ${error}`);
    }

    // Start ChunkUploader on first chunk if not already started
    if (!this.chunkUploader && this.config.enableLiveUpload && this.s3Client) {
      try {
        this.chunkUploader = new ChunkUploader({
          uploadIntervalMs: (this.config.chunkDurationSec || 30) * 1000,
          contentType: 'video/webm',
        });
        this.chunkUploader.start(this.videoPath, this.config.meetingId);
        logger.info('WebRTC video: ChunkUploader started');
      } catch (err) {
        logger.warn(`Failed to start chunk uploader for WebRTC video: ${err}`);
      }
    }
  }

  /**
   * Set the measured browser chrome height (address bar + tabs).
   * Used by the crop filter to remove the toolbar from recordings.
   */
  setChromeHeight(height: number): void {
    this.chromeHeight = height;
  }

  /**
   * Reset orchestrator state so it can be started again (for recording rotation).
   * Must be called after stop() and before start().
   */
  reset(): void {
    if (this.status !== 'complete' && this.status !== 'error') {
      throw new Error(`Cannot reset orchestrator in state: ${this.status}`);
    }
    this.status = 'idle';
    this.videoProcess = null;
    this.audioProcess = null;
    this.chunkUploader = null;
    this.videoPath = null;
    this.audioPath = null;
    this.transcriptionAudioPath = null;
    this.mergedPath = null;
    this.startTime = null;
    this.endTime = null;
    this.s3VideoUrl = null;
    this.s3AudioUrl = null;
    this.s3MergedUrl = null;
    this.chunksUploaded = 0;
    this.chunkIndex = 0;
    this.errors = [];
    this.audioFailed = false;
    this.pauseEvents = [];
    this.totalPauseDurationMs = 0;
    this.currentPauseStart = null;
    this.audioStreamPassthrough = null;
    logger.info('Recording orchestrator reset for new segment');
  }

  /**
   * Get recording duration in seconds, subtracting pause time
   */
  getDuration(): number {
    if (!this.startTime) return 0;
    const end = this.endTime ?? new Date();
    const totalMs = end.getTime() - this.startTime.getTime();

    // Subtract completed pause durations
    let pauseMs = this.totalPauseDurationMs;

    // If currently paused, add current pause duration
    if (this.currentPauseStart) {
      pauseMs += new Date().getTime() - this.currentPauseStart.getTime();
    }

    return Math.max(0, Math.floor((totalMs - pauseMs) / 1000));
  }

  /**
   * Get a Readable stream of raw PCM audio data for live consumers.
   *
   * This stream receives a copy of the audio data captured by FFmpeg,
   * allowing live transcription and WebSocket streaming without affecting
   * the recorded file.
   *
   * Returns null if recording has not started or audio capture is not active.
   */
  getAudioStream(): Readable | null {
    return this.audioStreamPassthrough;
  }

  /**
   * Force cleanup all resources (for error recovery)
   */
  async forceCleanup(): Promise<void> {
    logger.warn(`Force cleanup initiated for meeting: ${this.config.meetingId}`);

    // Abort chunk uploader if active
    if (this.chunkUploader) {
      try {
        await this.chunkUploader.abortUpload();
      } catch {
        /* ignore */
      }
      this.chunkUploader = null;
    }

    // Resume if paused before killing (SIGKILL on stopped process may not work)
    if (this.videoProcess && !this.videoProcess.killed) {
      try {
        this.videoProcess.kill('SIGCONT');
      } catch {
        /* ignore */
      }
      this.videoProcess.kill('SIGKILL');
      this.videoProcess = null;
    }
    if (this.audioProcess && !this.audioProcess.killed) {
      try {
        this.audioProcess.kill('SIGCONT');
      } catch {
        /* ignore */
      }
      this.audioProcess.kill('SIGKILL');
      this.audioProcess = null;
    }

    // Cleanup temp files
    await this.cleanupTempFiles();

    this.status = 'idle';
  }

  // ==========================================================================
  // Display Configuration
  // ==========================================================================

  /**
   * Configure Xvfb display resolution using xrandr (Linux only)
   */
  private configureDisplay(): void {
    if (process.platform !== 'linux') return;

    const { width, height } = this.config.resolution;
    try {
      execSync(`xrandr --display ${this.config.display} -s ${width}x${height}`, { timeout: 5000, stdio: 'pipe' });
      logger.info(`Display ${this.config.display} configured to ${width}x${height}`);
    } catch {
      // xrandr may not be available or mode may not exist; not fatal
      logger.debug(`Could not configure display resolution via xrandr (non-fatal)`);
    }
  }

  // ==========================================================================
  // Video Capture (x11grab -> video-only file)
  // ==========================================================================

  /**
   * Start FFmpeg to capture video only from the X11 display.
   * Produces a video-only file (no audio track).
   */
  private async startVideoCapture(): Promise<void> {
    if (!this.videoPath) return;

    const videoCodec = this.formatConfig.videoCodec;
    if (!videoCodec) return; // audio-only format

    logger.info(`Starting video capture: display=${this.config.display}`);

    // Build codec-specific video args (includes bitrate floor fix from Sprint 2)
    const codecArgs = this.getVideoCodecArgs(videoCodec);

    // Xvfb is chromeHeight px taller than the target resolution to accommodate
    // Chrome's toolbar. We capture the full display and crop out the top.
    // chromeHeight is measured dynamically via window.outerHeight - window.innerHeight,
    // plus a safety offset applied in base.ts to avoid browser chrome leaking through.
    // Cap chrome height to avoid exceeding Xvfb display (which is resolution + 110)
    const ch = Math.min(this.chromeHeight, 110);
    const captureHeight = this.config.resolution.height + ch;
    const args = [
      '-y',
      '-f',
      'x11grab',
      '-video_size',
      `${this.config.resolution.width}x${captureHeight}`,
      '-framerate',
      String(this.config.frameRate),
      '-draw_mouse',
      '0',
      '-i',
      this.config.display,
      // Crop out the browser chrome (top N pixels) to produce clean video
      '-vf',
      `crop=${this.config.resolution.width}:${this.config.resolution.height}:0:${ch}`,
      // Video encoding
      ...codecArgs,
      // No audio
      '-an',
      // Output video-only file
      this.videoPath,
    ];

    return new Promise((resolve, reject) => {
      this.videoProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      this.videoProcess.stderr?.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-2000);
        if (stderr.includes('frame=')) {
          const match = stderr.match(/frame=\s*(\d+)/);
          if (match) {
            logger.debug(`Video capture progress: frame ${match[1]}`);
          }
        }
      });

      this.videoProcess.on('error', (error) => {
        logger.error(`Video capture error: ${error.message}`);
        this.emitError(error, 'video-capture', false);
        reject(error);
      });

      this.videoProcess.on('exit', (code, signal) => {
        if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
          const error = new Error(`Video capture exited with code ${code}: ${stderr.slice(-500)}`);
          logger.error(error.message);
          this.emitError(error, 'video-capture', false);
        }
      });

      // Give FFmpeg a moment to initialize
      setTimeout(() => {
        if (this.videoProcess && !this.videoProcess.killed) {
          resolve();
        } else {
          reject(new Error('Video capture failed to start'));
        }
      }, 500);
    });
  }

  /**
   * Get FFmpeg video codec arguments based on format
   */
  private getVideoCodecArgs(codec: string): string[] {
    const gpu = isNvencAvailable();

    switch (codec) {
      case 'libvpx-vp9':
        // VP9: NVENC doesn't support VP9, always software
        // -g sets max keyframe interval (2s at current framerate) to avoid
        // long gaps between keyframes that cause black frames when seeking/trimming.
        return [
          '-c:v',
          'libvpx-vp9',
          '-b:v',
          '1M',
          '-maxrate',
          '2M',
          '-bufsize',
          '2M',
          '-crf',
          '32',
          '-g',
          String(this.config.frameRate * 2),
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-row-mt',
          '1',
          '-tile-columns',
          '2',
        ];
      case 'libx264':
        if (gpu) {
          // NVENC H.264: hardware-accelerated, much faster and lower CPU
          // frag_keyframe+empty_moov: write moov atom at start so file is valid even if interrupted
          return [
            '-c:v',
            'h264_nvenc',
            '-preset',
            'p4',
            '-tune',
            'll',
            '-rc',
            'vbr',
            '-cq',
            '28',
            '-b:v',
            '2M',
            '-maxrate',
            '3M',
            '-bufsize',
            '4M',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            'frag_keyframe+empty_moov',
          ];
        }
        // frag_keyframe+empty_moov: write moov atom at start so file is always
        // valid even if FFmpeg is killed mid-recording (crash resilience)
        return [
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-tune',
          'zerolatency',
          '-crf',
          '28',
          '-b:v',
          '1500k',
          '-minrate',
          '500k',
          '-maxrate',
          '3000k',
          '-bufsize',
          '3000k',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          'frag_keyframe+empty_moov',
        ];
      default:
        return ['-c:v', codec];
    }
  }

  // ==========================================================================
  // Audio Capture (PulseAudio -> WAV file + pipe:1 for live transcription)
  // ==========================================================================

  /**
   * Start FFmpeg to capture audio from PulseAudio. Uses filter_complex to split
   * the audio into two outputs:
   * 1. A 48kHz stereo WAV file on disk (for merging with video later)
   * 2. A 16kHz mono PCM stream on pipe:1 (for live transcription / WebSocket)
   */
  private async startAudioCapture(): Promise<void> {
    if (!this.audioPath) return;

    logger.info(`Starting audio capture from source ${this.config.audioSource}`);

    // Create passthrough stream for live audio consumers (WebSocket + live transcription)
    this.audioStreamPassthrough = new PassThrough({ highWaterMark: 64 * 1024 });
    logger.info('Audio passthrough stream created for live consumers (WebSocket/transcription)');

    const args = [
      '-y',
      '-thread_queue_size',
      '1024',
      '-f',
      'pulse',
      '-i',
      this.config.audioSource,
      // Split audio into two streams: one for file, one for live transcription
      '-filter_complex',
      '[0:a]asplit=2[file][live];' +
        '[file]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[fileout];' +
        '[live]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[liveout]',
      // Output 1: 48kHz stereo WAV file
      '-map',
      '[fileout]',
      '-c:a',
      'pcm_s16le',
      this.audioPath,
      // Output 2: 16kHz mono PCM on pipe:1 for live transcription
      '-map',
      '[liveout]',
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      'pipe:1',
    ];

    return new Promise((resolve, reject) => {
      this.audioProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      // Pipe stdout (raw PCM 16kHz mono) to the passthrough stream
      if (this.audioProcess.stdout) {
        this.audioProcess.stdout.pipe(this.audioStreamPassthrough!);
        logger.info('Audio FFmpeg piped to passthrough stream (PCM s16le 16kHz mono)');
      }

      this.audioProcess.stderr?.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-2000);
      });

      this.audioProcess.on('error', (error) => {
        logger.error(`Audio capture error: ${error.message}`);
        this.emitError(error, 'audio-capture', false);
        reject(error);
      });

      this.audioProcess.on('exit', (code, signal) => {
        // End the passthrough stream when FFmpeg exits
        if (this.audioStreamPassthrough) {
          logger.info('Audio FFmpeg exited, closing passthrough stream');
          this.audioStreamPassthrough.end();
        }

        // FFmpeg returns 255 when killed by SIGTERM (normal shutdown)
        const isNormalExit = code === 0 || signal === 'SIGTERM' || signal === 'SIGINT' || code === 255;
        if (!isNormalExit) {
          this.audioFailed = true;
          const error = new Error(`Audio capture exited with code ${code}: ${stderr.slice(-500)}`);
          logger.error(error.message);
          this.emitError(error, 'audio-capture', false);
        }
      });

      // Give FFmpeg a moment to initialize
      setTimeout(() => {
        if (this.audioProcess && !this.audioProcess.killed) {
          resolve();
        } else {
          reject(new Error('Audio capture failed to start'));
        }
      }, 500);
    });
  }

  // ==========================================================================
  // Audio-Only Capture (MP3 format)
  // ==========================================================================

  /**
   * Start audio-only recording for MP3 format.
   * Produces an MP3 file + 16kHz mono PCM on pipe:1 for live consumers.
   */
  private async startAudioOnlyCapture(): Promise<void> {
    if (!this.audioPath) return;

    logger.info(`Starting audio-only capture from source ${this.config.audioSource}`);

    // Create passthrough stream for live audio consumers
    this.audioStreamPassthrough = new PassThrough({ highWaterMark: 64 * 1024 });

    const args = [
      '-y',
      '-thread_queue_size',
      '1024',
      '-f',
      'pulse',
      '-i',
      this.config.audioSource,
      '-filter_complex',
      '[0:a]asplit=2[file][live];' +
        '[file]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[fileout];' +
        '[live]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[liveout]',
      '-map',
      '[fileout]',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      this.audioPath,
      '-map',
      '[liveout]',
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      'pipe:1',
    ];

    return new Promise((resolve, reject) => {
      this.audioProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      if (this.audioProcess.stdout) {
        this.audioProcess.stdout.pipe(this.audioStreamPassthrough!);
        logger.info('Audio-only FFmpeg piped to passthrough stream (PCM s16le 16kHz)');
      }

      this.audioProcess.stderr?.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-2000);
      });

      this.audioProcess.on('error', (error) => {
        logger.error(`Audio-only capture error: ${error.message}`);
        this.emitError(error, 'audio-capture', true);
        reject(error);
      });

      this.audioProcess.on('exit', (code, signal) => {
        if (this.audioStreamPassthrough) {
          this.audioStreamPassthrough.end();
        }
        // FFmpeg returns 255 when killed by SIGTERM (normal shutdown)
        const isNormalExit = code === 0 || signal === 'SIGTERM' || signal === 'SIGINT' || code === 255;
        if (!isNormalExit) {
          this.audioFailed = true;
          const error = new Error(`Audio-only capture exited with code ${code}: ${stderr.slice(-500)}`);
          logger.error(error.message);
          this.emitError(error, 'audio-capture', true);
        }
      });

      setTimeout(() => {
        if (this.audioProcess && !this.audioProcess.killed) {
          resolve();
        } else {
          reject(new Error('Audio-only capture failed to start'));
        }
      }, 500);
    });
  }

  // ==========================================================================
  // Process Stop Helper
  // ==========================================================================

  /**
   * Gracefully stop an FFmpeg process by sending 'q', then SIGTERM, then SIGKILL.
   */
  private async stopProcess(proc: ChildProcess | null, label: string): Promise<void> {
    if (!proc) return;

    logger.info(`Stopping ${label} FFmpeg process`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn(`${label} FFmpeg did not stop gracefully, forcing kill`);
        proc.kill('SIGKILL');
        resolve();
      }, 10000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Send 'q' to FFmpeg to gracefully stop
      proc.stdin?.write('q');
      proc.stdin?.end();

      // Also send SIGTERM as backup
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGTERM');
      }, 1000);
    });
  }

  // ==========================================================================
  // Audio/Video Merge
  // ==========================================================================

  /**
   * Merge the video-only file and audio WAV into a single A/V file.
   * Uses -c:v copy to avoid re-encoding the video stream.
   */
  private async mergeAudioVideo(trimStartSeconds?: number, trimEndSeconds?: number): Promise<void> {
    if (!this.videoPath || !this.audioPath || !this.mergedPath) {
      logger.warn('Missing paths for merge, skipping');
      return;
    }

    if (!fs.existsSync(this.videoPath)) {
      throw new Error(`Video file not found for merge: ${this.videoPath}`);
    }
    if (!fs.existsSync(this.audioPath)) {
      throw new Error(`Audio file not found for merge: ${this.audioPath}`);
    }

    const trimming = trimStartSeconds && trimStartSeconds > 0;
    const trimmingEnd = trimEndSeconds && trimEndSeconds > 0;
    logger.info(
      `Merging video + audio -> ${this.mergedPath}` +
        (trimming ? ` (trimming first ${trimStartSeconds!.toFixed(1)}s)` : '') +
        (trimmingEnd ? ` (duration limited to ${trimEndSeconds!.toFixed(1)}s)` : ''),
    );

    const args: string[] = ['-y'];

    // When trimming, use input-level -ss (before each -i) for fast keyframe seeking.
    // The capture uses -g 48 (keyframe every 2s at 24fps), so the max black frame
    // duration is ~2s — acceptable for production without expensive re-encoding.
    if (trimming) {
      args.push('-ss', String(trimStartSeconds));
    }
    args.push('-i', this.videoPath);

    if (trimming) {
      args.push('-ss', String(trimStartSeconds));
    }
    args.push('-i', this.audioPath);

    args.push('-map', '0:v:0', '-map', '1:a:0');

    args.push('-c:v', 'copy');

    // WebM containers require Opus audio; MP4 containers use AAC
    const isWebM = this.mergedPath!.endsWith('.webm');
    if (isWebM) {
      args.push('-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    } else {
      args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    }
    args.push('-async', '1');

    // Trim the end: limit output duration to remove trailing "bot alone" frames
    if (trimmingEnd) {
      args.push('-t', String(trimEndSeconds));
    }

    args.push('-shortest', this.mergedPath);

    return new Promise((resolve, reject) => {
      const mergeProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      mergeProcess.stderr?.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-2000);
      });

      mergeProcess.on('error', (error) => {
        logger.error(`Merge error: ${error.message}`);
        this.emitError(error, 'merge', false);
        reject(error);
      });

      mergeProcess.on('exit', (code) => {
        if (code === 0) {
          const videoSize = fs.statSync(this.videoPath!).size;
          const audioSize = fs.statSync(this.audioPath!).size;
          const mergedSize = fs.statSync(this.mergedPath!).size;
          logger.info(
            `Merge complete: video=${(videoSize / 1024 / 1024).toFixed(1)}MB, ` +
              `audio=${(audioSize / 1024 / 1024).toFixed(1)}MB, ` +
              `merged=${(mergedSize / 1024 / 1024).toFixed(1)}MB`,
          );
          resolve();
        } else {
          const error = new Error(`Merge failed with code ${code}: ${stderr.slice(-500)}`);
          logger.error(error.message);
          this.emitError(error, 'merge', false);
          reject(error);
        }
      });
    });
  }

  // ==========================================================================
  // Transcription Audio Extraction
  // ==========================================================================

  /**
   * Extract a 16kHz mono WAV from the 48kHz stereo audio WAV for transcription upload.
   *
   * The audio WAV is 48kHz stereo PCM. Transcription services (Deepgram, AssemblyAI)
   * work best with 16kHz mono, and the smaller file size (~11MB for 10 minutes vs
   * ~132MB) avoids S3 upload timeouts.
   */
  private async extractTranscriptionAudio(): Promise<void> {
    if (!this.audioPath || !this.transcriptionAudioPath) {
      return;
    }

    if (!fs.existsSync(this.audioPath)) {
      logger.warn(`Audio file not found, skipping transcription audio extraction: ${this.audioPath}`);
      return;
    }

    logger.info(`Extracting 16kHz mono audio for transcription: ${this.transcriptionAudioPath}`);

    const args = [
      '-y',
      '-i',
      this.audioPath,
      '-vn', // discard any non-audio (safety)
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      this.transcriptionAudioPath,
    ];

    return new Promise((resolve, reject) => {
      const extractProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      extractProcess.stderr?.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-2000);
      });

      extractProcess.on('error', (error) => {
        logger.error(`Transcription audio extraction error: ${error.message}`);
        reject(error);
      });

      extractProcess.on('exit', (code) => {
        if (code === 0) {
          const sourceSize = fs.statSync(this.audioPath!).size;
          const extractedSize = fs.statSync(this.transcriptionAudioPath!).size;
          logger.info(
            `Transcription audio extracted: source=${(sourceSize / 1024 / 1024).toFixed(1)}MB, 16kHz=${(extractedSize / 1024 / 1024).toFixed(1)}MB`,
          );
          resolve();
        } else {
          const error = new Error(`Transcription audio extraction failed with code ${code}: ${stderr.slice(-500)}`);
          logger.error(error.message);
          reject(error);
        }
      });
    });
  }

  // ==========================================================================
  // S3 Upload
  // ==========================================================================

  private async uploadFinalRecordings(): Promise<void> {
    if (!this.s3Client) {
      logger.warn('S3 not configured, skipping upload');
      return;
    }

    const uploadPromises: Promise<void>[] = [];

    if (this.config.format === 'mp3') {
      // Audio-only: upload the MP3 file
      logger.info('Uploading audio-only recording (MP3)');
      if (this.audioPath && fs.existsSync(this.audioPath)) {
        uploadPromises.push(this.uploadFile(this.audioPath, 'audio', this.formatConfig.mime));
      }
    } else {
      // Upload the merged A/V file as the primary video output.
      // This overwrites s3VideoUrl even if chunk uploader already uploaded the
      // video-only file, because the merged file is the better final output.
      if (this.mergedPath && fs.existsSync(this.mergedPath)) {
        logger.info('Uploading merged A/V file');
        uploadPromises.push(
          this.uploadFile(this.mergedPath, 'video', this.formatConfig.mime).then(() => {
            this.s3MergedUrl = this.s3VideoUrl;
          }),
        );
      } else if (!this.s3VideoUrl && this.videoPath && fs.existsSync(this.videoPath)) {
        // Fallback: if merge failed and chunk uploader didn't upload, upload video-only
        logger.info('Merge not available, uploading video-only file as fallback');
        uploadPromises.push(this.uploadFile(this.videoPath, 'video', this.formatConfig.mime));
      } else if (this.s3VideoUrl) {
        // Chunk uploader already uploaded video-only file; no merged file available
        logger.info('Using chunk-uploaded video-only file (merge was not available)');
      }

      // Always upload the 16kHz mono audio for transcription separately
      if (this.transcriptionAudioPath && fs.existsSync(this.transcriptionAudioPath)) {
        const sizeMB = (fs.statSync(this.transcriptionAudioPath).size / 1024 / 1024).toFixed(1);
        logger.info(`Uploading audio for transcription: ${path.basename(this.transcriptionAudioPath)} (${sizeMB}MB)`);
        uploadPromises.push(this.uploadFile(this.transcriptionAudioPath, 'audio', 'audio/wav'));
      }
    }

    await Promise.all(uploadPromises);
  }

  private async uploadFile(localPath: string, type: 'video' | 'audio', contentType: string): Promise<void> {
    if (!this.s3Client) return;

    const filename = path.basename(localPath);
    const key = `${this.config.s3KeyPrefix}/${this.config.meetingId}/${filename}`;
    const fileStats = fs.statSync(localPath);
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`Uploading ${type} to S3: ${key} (attempt ${attempt}/${maxRetries})`);

        const fileStream = fs.createReadStream(localPath);

        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: this.config.s3Bucket,
            Key: key,
            Body: fileStream,
            ContentType: contentType,
            ContentLength: fileStats.size,
          },
          partSize: 10 * 1024 * 1024, // 10MB chunks
          queueSize: 4,
        });

        upload.on('httpUploadProgress', (progress: { loaded?: number; total?: number }) => {
          if (progress.loaded && progress.total) {
            const percentage = Math.round((progress.loaded / progress.total) * 100);
            logger.debug(`Upload progress (${type}): ${percentage}%`);
          }
        });

        await upload.done();

        const s3Url = `s3://${this.config.s3Bucket}/${key}`;

        // Store URL based on type
        switch (type) {
          case 'video':
            this.s3VideoUrl = s3Url;
            break;
          case 'audio':
            this.s3AudioUrl = s3Url;
            break;
        }

        // Emit chunk uploaded event
        const chunkEvent: ChunkUploadedEvent = {
          chunkIndex: this.chunkIndex++,
          chunkPath: localPath,
          s3Url,
          type,
          size: fileStats.size,
        };
        this.emit('chunk-uploaded', chunkEvent);
        this.chunksUploaded++;

        logger.info(`${type} uploaded to S3: ${s3Url}`);
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(`Upload attempt ${attempt}/${maxRetries} failed for ${key}: ${err.message}`);

        if (attempt === maxRetries) {
          logger.error(`Failed to upload ${type} after ${maxRetries} attempts: ${err.message}`);
          this.emitError(err, 'upload', true);
          throw error;
        }

        // Exponential backoff: 2s, 4s, 8s
        await new Promise((resolve) => setTimeout(resolve, 2000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  private async ensureTempDir(): Promise<void> {
    if (!fs.existsSync(this.config.tempDir)) {
      fs.mkdirSync(this.config.tempDir, { recursive: true });
    }
  }

  private async cleanupTempFiles(): Promise<void> {
    logger.info('Cleaning up temporary files');

    const filesToDelete = [this.videoPath, this.audioPath, this.mergedPath, this.transcriptionAudioPath].filter(
      (p): p is string => p !== null && fs.existsSync(p),
    );

    for (const file of filesToDelete) {
      try {
        fs.unlinkSync(file);
        logger.debug(`Deleted temp file: ${file}`);
      } catch (error) {
        logger.warn(`Failed to delete temp file ${file}: ${error}`);
      }
    }
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  private emitError(error: Error, phase: RecordingErrorEvent['phase'], recoverable: boolean): void {
    const errorEvent: RecordingErrorEvent = {
      error,
      phase,
      recoverable,
    };
    this.emit('error', errorEvent);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new RecordingOrchestrator instance
 */
export function createRecordingOrchestrator(config: RecordingOrchestratorConfig): RecordingOrchestrator {
  return new RecordingOrchestrator(config);
}

// ============================================================================
// Type Exports for Event Handlers
// ============================================================================

/**
 * Event map for RecordingOrchestrator
 *
 * Usage example:
 * ```typescript
 * orchestrator.on('chunk-uploaded', (event: ChunkUploadedEvent) => {
 *   console.log(`Uploaded chunk to ${event.s3Url}`);
 * });
 *
 * orchestrator.on('recording-complete', (event: RecordingCompleteEvent) => {
 *   console.log(`Recording complete: ${event.duration}s`);
 * });
 *
 * orchestrator.on('error', (event: RecordingErrorEvent) => {
 *   console.error(`Error in ${event.phase}: ${event.error.message}`);
 * });
 * ```
 */
export type RecordingOrchestratorEventMap = {
  'chunk-uploaded': ChunkUploadedEvent;
  'recording-complete': RecordingCompleteEvent;
  error: RecordingErrorEvent;
};
