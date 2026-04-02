import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface AudioStreamerConfig {
  /**
   * Output directory for audio files
   */
  outputDir?: string;

  /**
   * Output format: 'wav' for transcription (recommended) or 'aac' for smaller files
   */
  format?: 'wav' | 'aac';

  /**
   * Sample rate in Hz (default: 16000 for transcription compatibility)
   */
  sampleRate?: number;

  /**
   * Number of audio channels (default: 1 for mono)
   */
  channels?: number;

  /**
   * PulseAudio sink name for browser audio routing
   */
  sinkName?: string;
}

export interface AudioStreamerState {
  isRecording: boolean;
  outputPath: string | null;
  startTime: Date | null;
  error: Error | null;
}

/**
 * AudioStreamer captures live audio from PulseAudio virtual sink using FFmpeg.
 *
 * Architecture:
 * 1. Creates a virtual PulseAudio null sink for browser audio routing
 * 2. Sets the sink as the default output so browser audio goes there
 * 3. Uses FFmpeg to capture from the sink's monitor source
 * 4. Writes audio continuously to disk in WAV/AAC format
 *
 * For headless browser audio capture in Docker:
 * - Requires PulseAudio daemon running
 * - Browser (Chrome/Playwright) audio routes to the virtual sink
 * - FFmpeg captures from the monitor source of that sink
 */
export class AudioStreamer {
  private config: Required<AudioStreamerConfig>;
  private ffmpegProcess: ChildProcess | null = null;
  private state: AudioStreamerState = {
    isRecording: false,
    outputPath: null,
    startTime: null,
    error: null,
  };
  private pulseInitialized = false;

  constructor(config: AudioStreamerConfig = {}) {
    this.config = {
      outputDir: config.outputDir ?? '/tmp/recordings',
      format: config.format ?? 'wav',
      sampleRate: config.sampleRate ?? 16000,
      channels: config.channels ?? 1,
      sinkName: config.sinkName ?? 'aramis_audio_sink',
    };
  }

  /**
   * Initialize PulseAudio virtual sink for browser audio routing.
   * This creates a null sink that captures all audio output.
   */
  async initializePulseAudio(): Promise<void> {
    if (this.pulseInitialized) {
      logger.debug('PulseAudio already initialized');
      return;
    }

    logger.info('Initializing PulseAudio for audio capture');

    try {
      // Start PulseAudio if not running
      await this.ensurePulseAudioRunning();

      // Check if sink already exists
      const existingSinks = this.runCommand('pactl list short sinks');
      if (existingSinks.includes(this.config.sinkName)) {
        logger.info(`Using existing PulseAudio sink: ${this.config.sinkName}`);
        this.pulseInitialized = true;
        return;
      }

      // Create a null sink for capturing audio
      // The monitor source of this sink will capture all audio routed to it
      this.runCommand(
        `pactl load-module module-null-sink sink_name=${this.config.sinkName} sink_properties=device.description="Aramis_Audio_Capture"`,
      );
      logger.info(`Created PulseAudio null sink: ${this.config.sinkName}`);

      // Set as default sink so browser audio goes here
      this.runCommand(`pactl set-default-sink ${this.config.sinkName}`);
      logger.info(`Set ${this.config.sinkName} as default sink`);

      this.pulseInitialized = true;
      logger.info('PulseAudio initialization complete');
    } catch (error) {
      logger.error(`Failed to initialize PulseAudio: ${error}`);
      throw new Error(`PulseAudio initialization failed: ${error}`);
    }
  }

  /**
   * Ensure PulseAudio daemon is running
   */
  private async ensurePulseAudioRunning(): Promise<void> {
    try {
      // Check if PulseAudio is already running
      this.runCommand('pulseaudio --check');
      logger.debug('PulseAudio daemon is running');
    } catch {
      // PulseAudio not running, start it
      logger.info('Starting PulseAudio daemon');
      try {
        // Start PulseAudio in daemon mode with system-wide configuration
        this.runCommand('pulseaudio --start --exit-idle-time=-1');
        // Wait for it to start
        await this.sleep(500);
      } catch (startError) {
        // Try with different options for Docker environment
        logger.warn(`Standard PulseAudio start failed, trying alternative: ${startError}`);
        try {
          this.runCommand('pulseaudio -D --exit-idle-time=-1 --system=false --disallow-exit');
        } catch (altError) {
          logger.error(`Could not start PulseAudio: ${altError}`);
          throw altError;
        }
      }
    }
  }

  /**
   * Start capturing audio from PulseAudio to file
   */
  async start(meetingId?: string): Promise<string> {
    if (this.state.isRecording) {
      logger.warn('Audio streaming already in progress');
      return this.state.outputPath!;
    }

    // Ensure PulseAudio is set up
    await this.initializePulseAudio();

    // Ensure output directory exists
    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }

    // Generate output filename
    const timestamp = Date.now();
    const filename = meetingId
      ? `${meetingId}_audio_${timestamp}.${this.config.format}`
      : `audio_${timestamp}.${this.config.format}`;
    const outputPath = path.join(this.config.outputDir, filename);

    logger.info(`Starting audio capture to: ${outputPath}`);

    // Build FFmpeg command
    const ffmpegArgs = this.buildFFmpegArgs(outputPath);
    logger.debug(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

    // Start FFmpeg process
    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle FFmpeg output
    this.ffmpegProcess.stdout?.on('data', (data) => {
      logger.debug(`FFmpeg stdout: ${data.toString()}`);
    });

    this.ffmpegProcess.stderr?.on('data', (data) => {
      const message = data.toString();
      // FFmpeg logs to stderr, filter out non-errors
      if (message.includes('Error') || message.includes('error')) {
        logger.warn(`FFmpeg stderr: ${message}`);
      } else {
        logger.debug(`FFmpeg: ${message}`);
      }
    });

    this.ffmpegProcess.on('error', (error) => {
      logger.error(`FFmpeg process error: ${error}`);
      this.state.error = error;
    });

    this.ffmpegProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.warn(`FFmpeg exited with code ${code}, signal: ${signal}`);
      } else {
        logger.info('FFmpeg process exited normally');
      }
      this.ffmpegProcess = null;
    });

    // Update state
    this.state = {
      isRecording: true,
      outputPath,
      startTime: new Date(),
      error: null,
    };

    // Small delay to ensure FFmpeg has started
    await this.sleep(200);

    // Verify process is still running
    if (!this.ffmpegProcess || this.ffmpegProcess.killed) {
      throw new Error('FFmpeg failed to start');
    }

    logger.info('Audio capture started successfully');
    return outputPath;
  }

  /**
   * Build FFmpeg arguments for audio capture
   */
  private buildFFmpegArgs(outputPath: string): string[] {
    const args: string[] = [
      // Overwrite output file if exists
      '-y',

      // Input: PulseAudio monitor source
      '-f',
      'pulse',
      '-i',
      `${this.config.sinkName}.monitor`,

      // Audio settings
      '-ac',
      this.config.channels.toString(),
      '-ar',
      this.config.sampleRate.toString(),
    ];

    if (this.config.format === 'wav') {
      // WAV format - best for transcription
      args.push(
        '-acodec',
        'pcm_s16le',
        // Flush output frequently for real-time writing
        '-flush_packets',
        '1',
      );
    } else {
      // AAC format - smaller file size
      args.push('-acodec', 'aac', '-b:a', '128k');
    }

    // Output file
    args.push(outputPath);

    return args;
  }

  /**
   * Stop audio capture and finalize the file
   */
  async stop(): Promise<string | null> {
    if (!this.state.isRecording || !this.ffmpegProcess) {
      logger.warn('No audio recording in progress');
      return this.state.outputPath;
    }

    logger.info('Stopping audio capture...');

    const outputPath = this.state.outputPath;

    // Send quit signal to FFmpeg (graceful shutdown)
    this.ffmpegProcess.stdin?.write('q');

    // Wait for process to exit gracefully
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if not exited
        if (this.ffmpegProcess) {
          logger.warn('FFmpeg did not exit gracefully, forcing kill');
          this.ffmpegProcess.kill('SIGKILL');
        }
        resolve();
      }, 3000);

      if (this.ffmpegProcess) {
        this.ffmpegProcess.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    // Update state
    this.state.isRecording = false;
    this.ffmpegProcess = null;

    // Verify output file exists
    if (outputPath && fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      logger.info(`Audio capture complete: ${outputPath} (${stats.size} bytes)`);
    } else {
      logger.warn(`Output file not found: ${outputPath}`);
    }

    return outputPath;
  }

  /**
   * Get the current output file path
   */
  getOutputPath(): string | null {
    return this.state.outputPath;
  }

  /**
   * Get recording duration in seconds
   */
  getDuration(): number {
    if (!this.state.startTime) {
      return 0;
    }

    const now = this.state.isRecording ? new Date() : new Date();
    return Math.floor((now.getTime() - this.state.startTime.getTime()) / 1000);
  }

  /**
   * Check if currently recording
   */
  isRecording(): boolean {
    return this.state.isRecording;
  }

  /**
   * Get any error that occurred
   */
  getError(): Error | null {
    return this.state.error;
  }

  /**
   * Clean up PulseAudio sink
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up AudioStreamer resources');

    // Stop recording if active
    if (this.state.isRecording) {
      await this.stop();
    }

    // Unload the null sink module (optional, will be cleaned up on PulseAudio exit)
    if (this.pulseInitialized) {
      try {
        // Find and unload the module
        const modules = this.runCommand('pactl list short modules');
        const lines = modules.split('\n');
        for (const line of lines) {
          if (line.includes(this.config.sinkName)) {
            const moduleId = line.split('\t')[0];
            this.runCommand(`pactl unload-module ${moduleId}`);
            logger.info(`Unloaded PulseAudio module ${moduleId}`);
          }
        }
      } catch (error) {
        logger.debug(`Could not unload PulseAudio module: ${error}`);
      }
      this.pulseInitialized = false;
    }
  }

  /**
   * Helper to run shell commands synchronously
   */
  private runCommand(command: string): string {
    try {
      return execSync(command, { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch (error: any) {
      if (error.stderr) {
        throw new Error(`Command failed: ${command}\n${error.stderr}`);
      }
      throw error;
    }
  }

  /**
   * Helper to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get audio file duration using FFprobe (for completed recordings)
   */
  async getFileDuration(filePath?: string): Promise<number> {
    const file = filePath ?? this.state.outputPath;
    if (!file || !fs.existsSync(file)) {
      return 0;
    }

    try {
      const output = this.runCommand(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`,
      );
      return parseFloat(output) || 0;
    } catch (error) {
      logger.warn(`Could not get file duration: ${error}`);
      return 0;
    }
  }
}

export default AudioStreamer;
