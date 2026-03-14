/**
 * RTMP Streamer
 *
 * Streams the meeting video and audio to an RTMP endpoint (e.g., YouTube Live, Twitch).
 * Uses FFmpeg to capture from X11 display and PulseAudio, then outputs FLV over RTMP.
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { logger } from './logger';

export interface RtmpStreamerConfig {
  /** RTMP server URL (e.g., rtmp://a.rtmp.youtube.com/live2) */
  url: string;
  /** Stream key for authentication */
  streamKey: string;
  /** X11 display to capture (default: ':99') */
  display?: string;
  /** PulseAudio source (default: 'default') */
  audioSource?: string;
  /** Video resolution */
  resolution?: { width: number; height: number };
  /** Frame rate (default: 30) */
  frameRate?: number;
  /** Video bitrate (default: '2500k') */
  videoBitrate?: string;
  /** Audio bitrate (default: '128k') */
  audioBitrate?: string;
}

export class RtmpStreamer extends EventEmitter {
  private config: Required<RtmpStreamerConfig>;
  private process: ChildProcess | null = null;
  private streaming = false;

  constructor(config: RtmpStreamerConfig) {
    super();
    this.config = {
      url: config.url,
      streamKey: config.streamKey,
      display: config.display || process.env.DISPLAY || ':99',
      audioSource: config.audioSource || 'default',
      resolution: config.resolution || { width: 1920, height: 1080 },
      frameRate: config.frameRate || 30,
      videoBitrate: config.videoBitrate || '2500k',
      audioBitrate: config.audioBitrate || '128k',
    };
  }

  /**
   * Start streaming to the RTMP endpoint.
   */
  async start(): Promise<void> {
    if (this.streaming) {
      throw new Error('RTMP streaming is already active');
    }

    const rtmpUrl = `${this.config.url}/${this.config.streamKey}`;
    logger.info(`Starting RTMP stream to ${this.config.url}`);

    const args = [
      // Video input from X11 display
      '-f', 'x11grab',
      '-video_size', `${this.config.resolution.width}x${this.config.resolution.height}`,
      '-framerate', String(this.config.frameRate),
      '-i', this.config.display,
      // Audio input from PulseAudio
      '-f', 'pulse',
      '-i', this.config.audioSource,
      // Video encoding (H.264 for RTMP compatibility)
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', this.config.videoBitrate,
      '-maxrate', this.config.videoBitrate,
      '-bufsize', `${parseInt(this.config.videoBitrate) * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-g', String(this.config.frameRate * 2), // Keyframe interval = 2 seconds
      // Audio encoding (AAC for RTMP compatibility)
      '-c:a', 'aac',
      '-b:a', this.config.audioBitrate,
      '-ar', '44100',
      '-ac', '2',
      // Output as FLV to RTMP
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl,
    ];

    return new Promise((resolve, reject) => {
      this.process = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      this.process.stderr?.on('data', (data) => {
        stderr += data.toString();
        // Check for connection success
        if (stderr.includes('Output #0')) {
          this.streaming = true;
          this.emit('started');
        }
      });

      this.process.on('error', (error) => {
        logger.error(`RTMP stream error: ${error.message}`);
        this.streaming = false;
        this.emit('error', error);
        reject(error);
      });

      this.process.on('exit', (code, signal) => {
        this.streaming = false;
        this.process = null;

        if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
          logger.info('RTMP stream ended gracefully');
          this.emit('stopped');
        } else {
          const error = new Error(`RTMP stream exited with code ${code}: ${stderr.slice(-500)}`);
          logger.error(error.message);
          this.emit('error', error);
        }
      });

      // Give FFmpeg a moment to initialize and connect
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.streaming = true;
          resolve();
        } else {
          reject(new Error('RTMP stream failed to start'));
        }
      }, 2000);
    });
  }

  /**
   * Stop the RTMP stream gracefully.
   *
   * Sends 'q' to FFmpeg stdin for graceful shutdown,
   * falls back to SIGTERM after 5 seconds.
   */
  async stop(): Promise<void> {
    if (!this.process || !this.streaming) {
      return;
    }

    logger.info('Stopping RTMP stream');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('RTMP stream did not stop gracefully, sending SIGTERM');
        this.process?.kill('SIGTERM');

        // Final fallback: SIGKILL after 5 more seconds
        setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL');
            this.process = null;
            this.streaming = false;
            resolve();
          }
        }, 5000);
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        this.streaming = false;
        resolve();
      });

      // Send 'q' to FFmpeg for graceful shutdown
      try {
        this.process!.stdin?.write('q');
        this.process!.stdin?.end();
      } catch {
        // If stdin write fails, fall back to SIGTERM
        this.process?.kill('SIGTERM');
      }
    });
  }

  /**
   * Check if currently streaming.
   */
  isStreaming(): boolean {
    return this.streaming;
  }
}
