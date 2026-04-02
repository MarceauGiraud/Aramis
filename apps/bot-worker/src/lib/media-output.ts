/**
 * MediaOutputController
 *
 * Provides capabilities for the bot to output media into a meeting:
 * - Play audio through PulseAudio virtual mic
 * - Set video source via v4l2loopback virtual camera
 * - Text-to-speech via Google TTS API
 *
 * Docker requirements:
 * - PulseAudio must be configured with a virtual mic (module-pipe-source or module-null-sink)
 * - v4l2loopback kernel module for virtual camera output (Linux only)
 * - paplay or ffplay must be available for audio playback
 * - ffmpeg must be available for video source piping
 *
 * Example Docker configuration:
 *   # Virtual mic sink
 *   pactl load-module module-null-sink sink_name=virtual_mic sink_properties=device.description="VirtualMic"
 *   pactl set-default-source virtual_mic.monitor
 *
 *   # v4l2loopback (requires kernel module)
 *   modprobe v4l2loopback devices=1 video_nr=10 card_label="VirtualCam" exclusive_caps=1
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { logger } from './logger';

export class MediaOutputController {
  private currentAudioProcess: ChildProcess | null = null;
  private currentVideoProcess: ChildProcess | null = null;
  private virtualMicSink: string;
  private virtualCameraDevice: string;

  constructor(
    options: {
      virtualMicSink?: string;
      virtualCameraDevice?: string;
    } = {},
  ) {
    this.virtualMicSink = options.virtualMicSink ?? process.env.PULSE_VIRTUAL_MIC ?? 'virtual_mic';
    this.virtualCameraDevice = options.virtualCameraDevice ?? process.env.V4L2_DEVICE ?? '/dev/video10';
  }

  /**
   * Play an audio file through the PulseAudio virtual mic.
   * The audio will be heard by other participants in the meeting.
   *
   * @param audioPath - Path to the audio file (WAV, MP3, OGG, etc.)
   * @returns Promise that resolves when playback is complete
   */
  async playAudio(audioPath: string): Promise<void> {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    // Stop any currently playing audio
    this.stopAudio();

    logger.info(`Playing audio through virtual mic: ${audioPath}`);

    return new Promise((resolve, reject) => {
      // Use paplay for PulseAudio playback to specific sink
      this.currentAudioProcess = spawn('paplay', ['--device', this.virtualMicSink, audioPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.currentAudioProcess.on('exit', (code) => {
        this.currentAudioProcess = null;
        if (code === 0) {
          logger.info('Audio playback completed');
          resolve();
        } else {
          // Fallback: try ffplay
          this.playAudioWithFFplay(audioPath).then(resolve).catch(reject);
        }
      });

      this.currentAudioProcess.on('error', () => {
        this.currentAudioProcess = null;
        // Fallback: try ffplay
        this.playAudioWithFFplay(audioPath).then(resolve).catch(reject);
      });
    });
  }

  /**
   * Fallback audio playback using ffplay
   */
  private playAudioWithFFplay(audioPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.currentAudioProcess = spawn(
        'ffplay',
        ['-nodisp', '-autoexit', '-af', `aresample=async=1,pan=mono|FC=FL`, audioPath],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      this.currentAudioProcess.on('exit', (code) => {
        this.currentAudioProcess = null;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffplay exited with code ${code}`));
        }
      });

      this.currentAudioProcess.on('error', (error) => {
        this.currentAudioProcess = null;
        reject(error);
      });
    });
  }

  /**
   * Stop any currently playing audio
   */
  stopAudio(): void {
    if (this.currentAudioProcess && !this.currentAudioProcess.killed) {
      this.currentAudioProcess.kill('SIGTERM');
      this.currentAudioProcess = null;
    }
  }

  /**
   * Set the video source for the virtual camera.
   * This allows the bot to display a video feed or image to other participants.
   *
   * Requires v4l2loopback kernel module to be loaded.
   *
   * @param source - Path to video file, image, or URL
   * @param type - Type of source: 'file', 'image', or 'url'
   */
  async setVideoSource(source: string, type: 'file' | 'image' | 'url' = 'file'): Promise<void> {
    // Stop any current video source
    this.stopVideo();

    logger.info(`Setting virtual camera source: ${source} (${type})`);

    const args: string[] = [];

    switch (type) {
      case 'file':
        args.push(
          '-re', // Read at native frame rate
          '-i',
          source,
          '-f',
          'v4l2',
          '-pix_fmt',
          'yuv420p',
          '-vcodec',
          'rawvideo',
          this.virtualCameraDevice,
        );
        break;

      case 'image':
        args.push(
          '-loop',
          '1',
          '-i',
          source,
          '-f',
          'v4l2',
          '-pix_fmt',
          'yuv420p',
          '-vcodec',
          'rawvideo',
          '-r',
          '1', // 1 fps for static image
          this.virtualCameraDevice,
        );
        break;

      case 'url':
        args.push('-i', source, '-f', 'v4l2', '-pix_fmt', 'yuv420p', '-vcodec', 'rawvideo', this.virtualCameraDevice);
        break;
    }

    this.currentVideoProcess = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.currentVideoProcess.on('error', (error) => {
      logger.error(`Virtual camera error: ${error.message}`);
      this.currentVideoProcess = null;
    });

    this.currentVideoProcess.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`Virtual camera FFmpeg exited with code ${code}`);
      }
      this.currentVideoProcess = null;
    });
  }

  /**
   * Stop the virtual camera source
   */
  stopVideo(): void {
    if (this.currentVideoProcess && !this.currentVideoProcess.killed) {
      this.currentVideoProcess.kill('SIGTERM');
      this.currentVideoProcess = null;
    }
  }

  /**
   * Text-to-speech: convert text to audio and play through virtual mic.
   *
   * Uses Google TTS API if GOOGLE_TTS_API_KEY is set, otherwise falls back
   * to system TTS (espeak/say).
   *
   * @param text - Text to speak
   * @param language - BCP-47 language code (default: 'en-US')
   */
  async speak(text: string, language: string = 'en-US'): Promise<void> {
    logger.info(`TTS: "${text.substring(0, 100)}"`);

    const apiKey = process.env.GOOGLE_TTS_API_KEY;

    if (apiKey) {
      await this.speakWithGoogleTTS(text, language, apiKey);
    } else {
      await this.speakWithSystemTTS(text);
    }
  }

  /**
   * TTS using Google Cloud Text-to-Speech API
   */
  private async speakWithGoogleTTS(text: string, language: string, apiKey: string): Promise<void> {
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

    const body = JSON.stringify({
      input: { text },
      voice: { languageCode: language, ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'LINEAR16' },
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!response.ok) {
        throw new Error(`Google TTS API error: ${response.status}`);
      }

      const data = (await response.json()) as { audioContent: string };
      const audioBuffer = Buffer.from(data.audioContent, 'base64');

      // Write to temp file and play
      const tempPath = `/tmp/tts_${Date.now()}.wav`;
      fs.writeFileSync(tempPath, audioBuffer);

      try {
        await this.playAudio(tempPath);
      } finally {
        // Clean up temp file
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      logger.warn(`Google TTS failed, falling back to system TTS: ${error}`);
      await this.speakWithSystemTTS(text);
    }
  }

  /**
   * Fallback TTS using system tools (espeak on Linux, say on macOS)
   */
  private speakWithSystemTTS(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const isLinux = process.platform === 'linux';
      const cmd = isLinux ? 'espeak' : 'say';
      const args = isLinux
        ? ['--stdout', text] // espeak outputs WAV to stdout
        : [text]; // macOS say plays directly

      if (isLinux) {
        // Pipe espeak output to paplay for virtual mic
        const espeak = spawn('espeak', ['--stdout', text], { stdio: ['pipe', 'pipe', 'pipe'] });
        const paplay = spawn('paplay', ['--device', this.virtualMicSink, '--raw'], {
          stdio: [espeak.stdout, 'pipe', 'pipe'],
        });

        paplay.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`System TTS failed with code ${code}`));
        });

        paplay.on('error', (error) => reject(error));
        espeak.on('error', (error) => reject(error));
      } else {
        const proc = spawn(cmd, args, { stdio: 'pipe' });
        proc.on('exit', () => resolve());
        proc.on('error', (error) => reject(error));
      }
    });
  }

  /**
   * Cleanup all media output resources
   */
  cleanup(): void {
    this.stopAudio();
    this.stopVideo();
  }
}
