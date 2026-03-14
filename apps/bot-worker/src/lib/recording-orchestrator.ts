/**
 * RecordingOrchestrator
 *
 * Coordinates video capture, audio capture, and upload for the Aramis meeting recorder.
 *
 * Architecture:
 * - Video is captured via FFmpeg from Xvfb (X11 display)
 * - Audio is captured via FFmpeg from PulseAudio
 * - Chunks are uploaded to S3 as they are recorded (live upload)
 * - At the end, transcription is triggered
 *
 * Features:
 * - Pause/Resume recording via SIGSTOP/SIGCONT
 * - Multiple formats: WebM (VP9), MP4 (H.264), MP3 (audio-only)
 * - Configurable resolution
 * - Live audio stream for transcription/WebSocket via tee muxer
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
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { logger } from './logger';
import { isS3Configured } from './s3-config';
import { FORMAT_CONFIG, RESOLUTION_MAP } from '@aramis/shared';
import type { RecordingFormat, Resolution } from '@aramis/shared';

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
  videoPath: string | null;
  audioPath: string | null;
  mergedPath: string | null;
  s3VideoUrl: string | null;
  s3AudioUrl: string | null;
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
  | 'merging'
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
  videoUrl: string | null;
  audioUrl: string | null;
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
  private videoProcess: ChildProcess | null = null;
  private audioProcess: ChildProcess | null = null;

  // Output paths
  private videoPath: string | null = null;
  private audioPath: string | null = null;
  private mergedPath: string | null = null;

  // S3 URLs
  private s3VideoUrl: string | null = null;
  private s3AudioUrl: string | null = null;
  private s3MergedUrl: string | null = null;

  // Chunk tracking
  private chunksUploaded = 0;
  private chunkIndex = 0;

  // Error tracking
  private errors: string[] = [];

  // S3 client
  private s3Client: S3Client | null = null;

  // Pause tracking
  private pauseEvents: PauseEvent[] = [];
  private totalPauseDurationMs = 0;
  private currentPauseStart: Date | null = null;

  // Format config
  private formatConfig: typeof FORMAT_CONFIG[RecordingFormat];

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
    };

    // Initialize S3 client if configured
    if (isS3Configured()) {
      this.s3Client = new S3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY || '',
          secretAccessKey: process.env.S3_SECRET_KEY || '',
        },
        forcePathStyle: true,
      });
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

    // For MP3 format, skip video entirely
    if (this.config.format === 'mp3') {
      this.videoPath = null;
      this.audioPath = path.join(
        this.config.tempDir,
        `${this.config.meetingId}_${timestamp}_audio.${ext}`
      );
      this.mergedPath = null;
    } else {
      this.videoPath = path.join(
        this.config.tempDir,
        `${this.config.meetingId}_${timestamp}_video.${ext}`
      );
      this.audioPath = path.join(
        this.config.tempDir,
        `${this.config.meetingId}_${timestamp}_audio.wav`
      );
      this.mergedPath = path.join(
        this.config.tempDir,
        `${this.config.meetingId}_${timestamp}_merged.${ext}`
      );
    }

    try {
      if (this.config.format === 'mp3') {
        // Audio-only recording
        await this.startAudioCapture();
      } else {
        // Start video and audio capture in parallel
        await Promise.all([this.startVideoCapture(), this.startAudioCapture()]);
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
   * Stop recording and finalize outputs
   *
   * @param options - Options for stopping
   * @param options.merge - Whether to merge audio and video (default: true)
   * @param options.upload - Whether to upload to S3 (default: true if S3 configured)
   * @param options.cleanup - Whether to cleanup temp files after upload (default: true)
   */
  async stop(
    options: {
      merge?: boolean;
      upload?: boolean;
      cleanup?: boolean;
    } = {}
  ): Promise<RecordingInfo> {
    const { merge = true, upload = true, cleanup = true } = options;

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
      // Stop video and audio capture
      if (this.config.format === 'mp3') {
        await this.stopAudioCapture();
      } else {
        await Promise.all([this.stopVideoCapture(), this.stopAudioCapture()]);
      }

      // Merge audio and video if requested (not for mp3)
      if (merge && this.config.format !== 'mp3' && this.videoPath && this.audioPath) {
        this.status = 'merging';
        await this.mergeAudioVideo();
      }

      // Upload to S3 if requested and configured
      if (upload && this.s3Client) {
        this.status = 'uploading';
        await this.uploadFinalRecordings();
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

    // Resume if paused before killing (SIGKILL on stopped process may not work)
    if (this.videoProcess && !this.videoProcess.killed) {
      try { this.videoProcess.kill('SIGCONT'); } catch { /* ignore */ }
      this.videoProcess.kill('SIGKILL');
      this.videoProcess = null;
    }
    if (this.audioProcess && !this.audioProcess.killed) {
      try { this.audioProcess.kill('SIGCONT'); } catch { /* ignore */ }
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
      execSync(
        `xrandr --display ${this.config.display} -s ${width}x${height}`,
        { timeout: 5000, stdio: 'pipe' }
      );
      logger.info(`Display ${this.config.display} configured to ${width}x${height}`);
    } catch {
      // xrandr may not be available or mode may not exist; not fatal
      logger.debug(`Could not configure display resolution via xrandr (non-fatal)`);
    }
  }

  // ==========================================================================
  // Video Capture
  // ==========================================================================

  private async startVideoCapture(): Promise<void> {
    if (!this.videoPath) return;

    logger.info(`Starting video capture from display ${this.config.display}`);

    const videoCodec = this.formatConfig.videoCodec;
    if (!videoCodec) return; // audio-only format

    // Build codec-specific args
    const codecArgs = this.getVideoCodecArgs(videoCodec);

    const args = [
      // Input from X11 display
      '-f', 'x11grab',
      '-video_size', `${this.config.resolution.width}x${this.config.resolution.height}`,
      '-framerate', String(this.config.frameRate),
      '-i', this.config.display,
      // Video encoding
      ...codecArgs,
      // Output
      '-y',
      this.videoPath,
    ];

    return new Promise((resolve, reject) => {
      this.videoProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      this.videoProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
        // Log progress periodically (FFmpeg outputs progress to stderr)
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
    switch (codec) {
      case 'libvpx-vp9':
        return [
          '-c:v', 'libvpx-vp9',
          '-b:v', '2M',
          '-crf', '30',
          '-deadline', 'realtime',
          '-cpu-used', '8',
        ];
      case 'libx264':
        return [
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
        ];
      default:
        return ['-c:v', codec];
    }
  }

  private async stopVideoCapture(): Promise<void> {
    const proc = this.videoProcess;
    if (!proc) return;

    logger.info('Stopping video capture');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('Video capture did not stop gracefully, forcing kill');
        proc.kill('SIGKILL');
        resolve();
      }, 10000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        this.videoProcess = null;
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
  // Audio Capture
  // ==========================================================================

  private async startAudioCapture(): Promise<void> {
    if (!this.audioPath) return;

    logger.info(`Starting audio capture from source ${this.config.audioSource}`);

    // Create passthrough stream for live audio consumers
    this.audioStreamPassthrough = new PassThrough();

    let args: string[];

    if (this.config.format === 'mp3') {
      // MP3 audio-only output with tee muxer for live stream
      // Tee outputs to both MP3 file and raw PCM on stdout for live consumers
      const teeOutput = `[f=mp3]${this.audioPath}|[f=s16le]pipe:1`;
      args = [
        '-f', 'pulse',
        '-i', this.config.audioSource,
        '-c:a', 'libmp3lame',
        '-b:a', this.formatConfig.mergeAudioBitrate,
        '-ar', '44100',
        '-ac', '2',
        // Output via tee muxer to both file and stdout
        '-f', 'tee',
        '-y',
        teeOutput,
      ];
    } else {
      // WAV for transcription compatibility with tee muxer for live stream
      // Use tee muxer to output to both file and stdout pipe for live consumers.
      // FFmpeg tee format: -f tee "[f=wav]file.wav|[f=s16le]pipe:1"
      // The pipe:1 output sends raw PCM to stdout for live transcription/WebSocket.
      const teeOutput = `[f=wav]${this.audioPath}|[f=s16le]pipe:1`;
      args = [
        '-f', 'pulse',
        '-i', this.config.audioSource,
        '-c:a', 'pcm_s16le',
        '-ar', '16000', // 16kHz sample rate (good for speech recognition)
        '-ac', '1', // Mono channel
        // Output via tee muxer to both file and stdout
        '-f', 'tee',
        '-y',
        teeOutput,
      ];
    }

    return new Promise((resolve, reject) => {
      this.audioProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      // Pipe stdout (raw PCM from tee) to the passthrough stream
      if (this.audioProcess.stdout) {
        this.audioProcess.stdout.pipe(this.audioStreamPassthrough!);
      }

      this.audioProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      this.audioProcess.on('error', (error) => {
        logger.error(`Audio capture error: ${error.message}`);
        this.emitError(error, 'audio-capture', true); // Audio errors are recoverable
        reject(error);
      });

      this.audioProcess.on('exit', (code, signal) => {
        // End the passthrough stream when FFmpeg exits
        if (this.audioStreamPassthrough) {
          this.audioStreamPassthrough.end();
        }

        if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
          const error = new Error(`Audio capture exited with code ${code}: ${stderr.slice(-500)}`);
          logger.error(error.message);
          this.emitError(error, 'audio-capture', true);
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

  private async stopAudioCapture(): Promise<void> {
    const proc = this.audioProcess;
    if (!proc) return;

    logger.info('Stopping audio capture');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('Audio capture did not stop gracefully, forcing kill');
        proc.kill('SIGKILL');
        resolve();
      }, 10000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        this.audioProcess = null;
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

  private async mergeAudioVideo(): Promise<void> {
    if (!this.videoPath || !this.audioPath || !this.mergedPath) {
      throw new Error('Missing paths for merge operation');
    }

    // Verify input files exist
    if (!fs.existsSync(this.videoPath)) {
      throw new Error(`Video file not found: ${this.videoPath}`);
    }
    if (!fs.existsSync(this.audioPath)) {
      logger.warn(`Audio file not found, skipping merge: ${this.audioPath}`);
      return;
    }

    logger.info('Merging audio and video');

    const mergeAudioCodec = this.formatConfig.mergeAudioCodec;
    const mergeAudioBitrate = this.formatConfig.mergeAudioBitrate;

    if (!mergeAudioCodec) {
      logger.warn('No merge audio codec configured for this format, skipping merge');
      return;
    }

    const args = [
      // Input video
      '-i', this.videoPath,
      // Input audio
      '-i', this.audioPath,
      // Map streams
      '-map', '0:v:0',
      '-map', '1:a:0',
      // Copy video, encode audio per format
      '-c:v', 'copy',
      '-c:a', mergeAudioCodec,
      '-b:a', mergeAudioBitrate,
      // Sync audio
      '-shortest',
      // Output
      '-y',
      this.mergedPath,
    ];

    return new Promise((resolve, reject) => {
      const mergeProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      mergeProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      mergeProcess.on('error', (error) => {
        logger.error(`Merge error: ${error.message}`);
        this.emitError(error, 'merge', true);
        reject(error);
      });

      mergeProcess.on('exit', (code) => {
        if (code === 0) {
          logger.info('Audio/video merge complete');
          resolve();
        } else {
          const error = new Error(`Merge failed with code ${code}: ${stderr.slice(-500)}`);
          logger.error(error.message);
          this.emitError(error, 'merge', true);
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
      if (this.audioPath && fs.existsSync(this.audioPath)) {
        uploadPromises.push(this.uploadFile(this.audioPath, 'audio', this.formatConfig.mimeType));
      }
    } else {
      // Upload merged file if available, otherwise upload video and audio separately
      if (this.mergedPath && fs.existsSync(this.mergedPath)) {
        uploadPromises.push(this.uploadFile(this.mergedPath, 'merged', this.formatConfig.mimeType));
      } else {
        // Upload video
        if (this.videoPath && fs.existsSync(this.videoPath)) {
          uploadPromises.push(this.uploadFile(this.videoPath, 'video', this.formatConfig.mimeType));
        }
      }

      // Always upload audio separately for transcription
      if (this.audioPath && fs.existsSync(this.audioPath)) {
        uploadPromises.push(this.uploadFile(this.audioPath, 'audio', 'audio/wav'));
      }
    }

    await Promise.all(uploadPromises);
  }

  private async uploadFile(
    localPath: string,
    type: 'video' | 'audio' | 'merged',
    contentType: string
  ): Promise<void> {
    if (!this.s3Client) return;

    const filename = path.basename(localPath);
    const key = `${this.config.s3KeyPrefix}/${this.config.meetingId}/${filename}`;

    logger.info(`Uploading ${type} to S3: ${key}`);

    const fileStream = fs.createReadStream(localPath);
    const fileStats = fs.statSync(localPath);

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

    try {
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
        case 'merged':
          this.s3MergedUrl = s3Url;
          break;
      }

      // Emit chunk uploaded event
      const chunkEvent: ChunkUploadedEvent = {
        chunkIndex: this.chunkIndex++,
        chunkPath: localPath,
        s3Url,
        type: type === 'merged' ? 'video' : type,
        size: fileStats.size,
      };
      this.emit('chunk-uploaded', chunkEvent);
      this.chunksUploaded++;

      logger.info(`${type} uploaded to S3: ${s3Url}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Failed to upload ${type}: ${err.message}`);
      this.emitError(err, 'upload', true);
      throw error;
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

    const filesToDelete = [this.videoPath, this.audioPath, this.mergedPath].filter(
      (p): p is string => p !== null && fs.existsSync(p)
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

  private emitError(
    error: Error,
    phase: RecordingErrorEvent['phase'],
    recoverable: boolean
  ): void {
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
export function createRecordingOrchestrator(
  config: RecordingOrchestratorConfig
): RecordingOrchestrator {
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
  'error': RecordingErrorEvent;
};
