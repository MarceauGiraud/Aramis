import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface VideoStreamerOptions {
  /** Output directory for video files (default: /tmp/recordings) */
  outputDir?: string;
  /** Output format: 'webm' or 'mp4' (default: 'webm') */
  format?: 'webm' | 'mp4';
  /** X11 display to capture (default: ':99' for Xvfb) */
  display?: string;
  /** Video resolution (default: '1920x1080') */
  resolution?: string;
  /** Frame rate (default: 30) */
  frameRate?: number;
  /** Video bitrate (default: '2M') */
  videoBitrate?: string;
  /** Audio capture enabled (default: false) */
  captureAudio?: boolean;
  /** PulseAudio source for audio capture */
  audioSource?: string;
}

export interface VideoStreamerEvents {
  'start': () => void;
  'stop': (outputPath: string) => void;
  'error': (error: Error) => void;
  'progress': (info: ProgressInfo) => void;
}

export interface ProgressInfo {
  /** Duration in seconds */
  duration: number;
  /** File size in bytes */
  fileSize: number;
  /** Frames captured */
  frames: number;
  /** Current bitrate */
  bitrate: string;
}

/**
 * VideoStreamer - Real-time video capture using FFmpeg
 *
 * Captures the X11 display (Xvfb) and streams to a file continuously,
 * allowing video data to be written in real-time rather than buffered
 * until the end of recording.
 *
 * @example
 * ```typescript
 * const streamer = new VideoStreamer({
 *   outputDir: '/tmp/recordings',
 *   format: 'webm',
 *   display: ':99',
 * });
 *
 * streamer.on('error', (err) => console.error('Recording error:', err));
 * streamer.on('progress', (info) => console.log('Duration:', info.duration));
 *
 * await streamer.start('meeting-123');
 * // ... meeting runs ...
 * const outputPath = await streamer.stop();
 * ```
 */
export class VideoStreamer extends EventEmitter {
  private options: Required<VideoStreamerOptions>;
  private ffmpegProcess: ChildProcess | null = null;
  private outputPath: string | null = null;
  private isRecording = false;
  private startTime: Date | null = null;
  private progressInterval: NodeJS.Timeout | null = null;

  constructor(options: VideoStreamerOptions = {}) {
    super();

    this.options = {
      outputDir: options.outputDir ?? '/tmp/recordings',
      format: options.format ?? 'webm',
      display: options.display ?? (process.env.DISPLAY || ':99'),
      resolution: options.resolution ?? '1920x1080',
      frameRate: options.frameRate ?? 30,
      videoBitrate: options.videoBitrate ?? '2M',
      captureAudio: options.captureAudio ?? false,
      audioSource: options.audioSource ?? 'default',
    };
  }

  /**
   * Start capturing video from the X11 display
   * @param recordingId - Unique identifier for this recording (used in filename)
   * @returns Promise that resolves when recording has started
   */
  async start(recordingId: string): Promise<void> {
    if (this.isRecording) {
      throw new Error('Recording already in progress');
    }

    // Ensure output directory exists
    if (!fs.existsSync(this.options.outputDir)) {
      fs.mkdirSync(this.options.outputDir, { recursive: true });
    }

    // Generate output filename
    const timestamp = Date.now();
    const extension = this.options.format;
    const filename = `${recordingId}_${timestamp}.${extension}`;
    this.outputPath = path.join(this.options.outputDir, filename);

    // Build FFmpeg command arguments
    const args = this.buildFFmpegArgs();

    logger.info(`Starting video capture to: ${this.outputPath}`);
    logger.debug(`FFmpeg args: ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      try {
        this.ffmpegProcess = spawn('ffmpeg', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let startupError = '';
        let hasStarted = false;

        // Handle stderr (FFmpeg outputs progress info here)
        this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString();

          // Check for startup errors
          if (!hasStarted && output.includes('error')) {
            startupError += output;
          }

          // Parse progress information
          const progressInfo = this.parseFFmpegProgress(output);
          if (progressInfo) {
            this.emit('progress', progressInfo);
          }

          // Log debug output
          logger.debug(`FFmpeg: ${output.trim()}`);
        });

        this.ffmpegProcess.stdout?.on('data', (data: Buffer) => {
          logger.debug(`FFmpeg stdout: ${data.toString().trim()}`);
        });

        // Handle process errors
        this.ffmpegProcess.on('error', (error) => {
          logger.error(`FFmpeg process error: ${error.message}`);
          this.handleError(error);
          if (!hasStarted) {
            reject(error);
          }
        });

        // Handle process exit
        this.ffmpegProcess.on('close', (code) => {
          logger.info(`FFmpeg process exited with code: ${code}`);

          if (this.isRecording) {
            // Unexpected exit while recording
            const error = new Error(`FFmpeg exited unexpectedly with code ${code}`);
            this.handleError(error);
          }

          this.cleanup();
        });

        // Give FFmpeg a moment to start up and check for immediate failures
        setTimeout(() => {
          if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
            hasStarted = true;
            this.isRecording = true;
            this.startTime = new Date();
            this.startProgressMonitor();
            this.emit('start');
            logger.info('Video capture started successfully');
            resolve();
          } else if (startupError) {
            reject(new Error(`FFmpeg startup failed: ${startupError}`));
          }
        }, 500);

      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`Failed to start FFmpeg: ${err.message}`);
        reject(err);
      }
    });
  }

  /**
   * Stop the video capture
   * @returns Promise that resolves with the output file path
   */
  async stop(): Promise<string> {
    if (!this.isRecording || !this.ffmpegProcess) {
      throw new Error('No recording in progress');
    }

    logger.info('Stopping video capture...');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Force kill if FFmpeg doesn't respond to quit signal
        logger.warn('FFmpeg did not respond to quit signal, forcing termination');
        this.ffmpegProcess?.kill('SIGKILL');
      }, 10000);

      const onClose = () => {
        clearTimeout(timeout);
        this.cleanup();

        if (this.outputPath && fs.existsSync(this.outputPath)) {
          const stats = fs.statSync(this.outputPath);
          logger.info(`Recording saved: ${this.outputPath} (${stats.size} bytes)`);
          this.emit('stop', this.outputPath);
          resolve(this.outputPath);
        } else {
          reject(new Error('Output file not found after recording'));
        }
      };

      const proc = this.ffmpegProcess!;
      proc.once('close', onClose);

      // Send 'q' to FFmpeg's stdin to gracefully stop recording
      // This ensures the file is properly finalized
      if (proc.stdin) {
        proc.stdin.write('q');
        proc.stdin.end();
      } else {
        // Fallback to SIGTERM if stdin is not available
        proc.kill('SIGTERM');
      }
    });
  }

  /**
   * Get the current output file path
   * @returns The output file path, or null if not recording
   */
  getOutputPath(): string | null {
    return this.outputPath;
  }

  /**
   * Check if currently recording
   */
  getIsRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Get recording duration in seconds
   */
  getDuration(): number {
    if (!this.startTime) {
      return 0;
    }
    return (Date.now() - this.startTime.getTime()) / 1000;
  }

  /**
   * Build FFmpeg command line arguments based on options
   */
  private buildFFmpegArgs(): string[] {
    const args: string[] = [
      // Overwrite output file without asking
      '-y',

      // Input: X11 display capture
      '-f', 'x11grab',
      '-framerate', String(this.options.frameRate),
      '-video_size', this.options.resolution,
      '-i', this.options.display,
    ];

    // Add audio capture if enabled
    if (this.options.captureAudio) {
      args.push(
        '-f', 'pulse',
        '-i', this.options.audioSource
      );
    }

    // Output encoding settings based on format
    if (this.options.format === 'webm') {
      args.push(
        // VP9 video codec for WebM
        '-c:v', 'libvpx-vp9',
        '-b:v', this.options.videoBitrate,
        // Real-time encoding preset
        '-deadline', 'realtime',
        '-cpu-used', '8',
        // Keyframe interval for seekability
        '-g', '30',
        // Row-based multithreading
        '-row-mt', '1',
        // Disable tile columns for lower latency
        '-tile-columns', '0'
      );

      if (this.options.captureAudio) {
        args.push('-c:a', 'libopus', '-b:a', '128k');
      }
    } else {
      // MP4 format with H.264
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', this.options.videoBitrate,
        // Keyframe interval
        '-g', '30',
        // Pixel format for compatibility
        '-pix_fmt', 'yuv420p',
        // Enable streaming-friendly output
        '-movflags', '+faststart+frag_keyframe+empty_moov'
      );

      if (this.options.captureAudio) {
        args.push('-c:a', 'aac', '-b:a', '128k');
      }
    }

    // Add output file
    args.push(this.outputPath!);

    return args;
  }

  /**
   * Parse FFmpeg progress output
   */
  private parseFFmpegProgress(output: string): ProgressInfo | null {
    // FFmpeg outputs progress in format like:
    // frame=  120 fps=30 q=0.0 size=    1024kB time=00:00:04.00 bitrate=2048.0kbits/s

    const frameMatch = output.match(/frame=\s*(\d+)/);
    const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    const sizeMatch = output.match(/size=\s*(\d+)(\w+)/);
    const bitrateMatch = output.match(/bitrate=\s*([\d.]+\w+)/);

    if (frameMatch && timeMatch) {
      const hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const seconds = parseFloat(timeMatch[3]);
      const duration = hours * 3600 + minutes * 60 + seconds;

      let fileSize = 0;
      if (sizeMatch) {
        const sizeValue = parseInt(sizeMatch[1], 10);
        const sizeUnit = sizeMatch[2].toLowerCase();
        const multipliers: Record<string, number> = {
          'b': 1,
          'kb': 1024,
          'mb': 1024 * 1024,
          'gb': 1024 * 1024 * 1024,
        };
        fileSize = sizeValue * (multipliers[sizeUnit] || 1);
      }

      return {
        duration,
        fileSize,
        frames: parseInt(frameMatch[1], 10),
        bitrate: bitrateMatch ? bitrateMatch[1] : '0kbits/s',
      };
    }

    return null;
  }

  /**
   * Start periodic progress monitoring
   */
  private startProgressMonitor(): void {
    this.progressInterval = setInterval(() => {
      if (this.outputPath && fs.existsSync(this.outputPath)) {
        const stats = fs.statSync(this.outputPath);
        const duration = this.getDuration();

        this.emit('progress', {
          duration,
          fileSize: stats.size,
          frames: Math.floor(duration * this.options.frameRate),
          bitrate: `${Math.round(stats.size * 8 / duration / 1000)}kbits/s`,
        });
      }
    }, 5000);
  }

  /**
   * Handle errors during recording
   */
  private handleError(error: Error): void {
    logger.error(`Video streamer error: ${error.message}`);
    this.emit('error', error);
    this.cleanup();
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.isRecording = false;

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      this.ffmpegProcess.kill('SIGKILL');
    }
    this.ffmpegProcess = null;
  }

  /**
   * Force stop recording (for emergency cleanup)
   */
  forceStop(): void {
    logger.warn('Force stopping video capture');
    this.cleanup();
  }
}

// Type augmentation for EventEmitter
export interface VideoStreamer {
  on<K extends keyof VideoStreamerEvents>(
    event: K,
    listener: VideoStreamerEvents[K]
  ): this;
  emit<K extends keyof VideoStreamerEvents>(
    event: K,
    ...args: Parameters<VideoStreamerEvents[K]>
  ): boolean;
}
