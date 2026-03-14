import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../lib/logger';
import {
  BOT_CONFIG,
  SILENCE_TIMEOUT_MS,
  DEFAULT_BOT_KEYWORDS,
  RESOLUTION_MAP,
} from '@aramis/shared';
import type { RecordingConfig, RecordingView, MeetingPlatform } from '@aramis/shared';
import {
  RecordingOrchestrator,
  RecordingOrchestratorConfig,
  RecordingInfo,
} from '../lib/recording-orchestrator';
import { ChatCapturer, CapturedChatMessage } from '../lib/chat-capturer';
import { uploadRecording } from '../lib/storage';
import { prisma } from '@aramis/database';

// Add stealth plugin to avoid bot detection
// Disable specific evasions that can cause issues
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

export interface BotConfig {
  meetingId: string;
  meetingUrl: string;
  botName: string;
  platform?: MeetingPlatform;
  recordingConfig?: RecordingConfig;
}

export interface RecordingOptions {
  outputDir?: string;
  format?: 'webm' | 'mp4';
}

export interface BotOptions {
  headless?: boolean;
  debug?: boolean;
  screenshotDir?: string;
  /** Maximum recording duration in ms (overrides BOT_CONFIG.MAX_RECORDING_DURATION_MS) */
  maxRecordingDurationMs?: number;
  /** Silence timeout in ms before auto-leave (default: SILENCE_TIMEOUT_MS) */
  silenceTimeoutMs?: number;
  /** Waiting room timeout in ms (default: 5 min) */
  waitingRoomTimeoutMs?: number;
  /** Bot keywords to exclude from participant counts */
  botKeywords?: string[];
}

export abstract class BaseMeetingBot {
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected config: BotConfig;
  protected options: BotOptions;
  protected isRecording = false;
  protected recordingPath: string | null = null;
  protected startTime: Date | null = null;
  protected screenshotCounter = 0;
  protected recordingOrchestrator: RecordingOrchestrator | null = null;
  protected lastRecordingInfo: RecordingInfo | null = null;
  protected chatCapturer: ChatCapturer | null = null;

  // Auto-leave tracking
  protected lastAudioActivity: number = Date.now();

  // Heartbeat interval
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: BotConfig, options: BotOptions = {}) {
    this.config = config;
    this.options = {
      headless: options.headless ?? (process.env.BOT_HEADLESS !== 'false'),
      debug: options.debug ?? (process.env.BOT_DEBUG === 'true'),
      screenshotDir: options.screenshotDir ?? '/tmp/bot-screenshots',
      maxRecordingDurationMs: options.maxRecordingDurationMs,
      silenceTimeoutMs: options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS,
      waitingRoomTimeoutMs: options.waitingRoomTimeoutMs ?? 5 * 60 * 1000,
      botKeywords: options.botKeywords ?? [...DEFAULT_BOT_KEYWORDS],
    };
  }

  /**
   * Initialize the browser with stealth settings
   */
  async initialize(): Promise<void> {
    logger.info(`Initializing bot for meeting: ${this.config.meetingId}`);
    logger.info(`Bot options: headless=${this.options.headless}, debug=${this.options.debug}`);

    // Determine resolution from config
    const resolutionPreset = this.config.recordingConfig?.resolution ?? '1080p';
    const resolution = RESOLUTION_MAP[resolutionPreset];

    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: [
        '--incognito',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        // Use fake media devices to avoid permission popups
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Use a black/silent fake device instead of default green
        '--use-file-for-fake-video-capture=/dev/null',
        '--use-file-for-fake-audio-capture=/dev/null',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    // Ensure recordings directory exists
    const recordingsDir = '/tmp/recordings';
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    // Use incognito context (video recording is now handled by FFmpeg/RecordingOrchestrator)
    this.context = await this.browser.newContext({
      permissions: ['microphone', 'camera'],
      viewport: { width: resolution.width, height: resolution.height },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
    });

    this.page = await this.context.newPage();

    // Comprehensive stealth scripts to avoid detection
    await this.page.addInitScript(() => {
      // Override webdriver detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Override plugins with realistic Chrome plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
          return Object.assign(plugins, { length: plugins.length });
        },
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Override hardware concurrency (CPU cores)
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
      });

      // Override device memory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
      });

      // Override platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'MacIntel',
      });

      // Override maxTouchPoints
      Object.defineProperty(navigator, 'maxTouchPoints', {
        get: () => 0,
      });

      // Override connection
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
        }),
      });

      // Remove automation indicators from window
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

      // Override chrome object
      (window as any).chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {},
      };

      // Override permissions query
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);

      // Override WebGL vendor and renderer
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter: number) {
        if (parameter === 37445) {
          return 'Intel Inc.';
        }
        if (parameter === 37446) {
          return 'Intel Iris OpenGL Engine';
        }
        return getParameter.call(this, parameter);
      };
    });

    // Initialize the recording orchestrator (uses FFmpeg for video/audio capture)
    const recordingConfig = this.config.recordingConfig;
    this.recordingOrchestrator = new RecordingOrchestrator({
      meetingId: this.config.meetingId,
      display: process.env.DISPLAY || ':99',
      audioSource: process.env.PULSE_SOURCE || 'default',
      tempDir: recordingsDir,
      resolution: { width: resolution.width, height: resolution.height },
      frameRate: 30,
      enableLiveUpload: true,
      format: recordingConfig?.format ?? 'webm',
      resolutionPreset: recordingConfig?.resolution ?? '1080p',
    });

    // Set up recording event handlers
    this.setupRecordingEventHandlers();
  }

  /**
   * Set up event handlers for the recording orchestrator
   */
  private setupRecordingEventHandlers(): void {
    if (!this.recordingOrchestrator) return;

    this.recordingOrchestrator.on('chunk-uploaded', (event) => {
      logger.info(`Chunk uploaded: ${event.s3Url} (${event.size} bytes, type: ${event.type})`);
    });

    this.recordingOrchestrator.on('recording-complete', (event) => {
      logger.info(`Recording complete: ${event.duration}s (format: ${event.format})`);
      if (event.videoUrl) logger.info(`  Video: ${event.videoUrl}`);
      if (event.audioUrl) logger.info(`  Audio: ${event.audioUrl}`);
      if (event.mergedUrl) logger.info(`  Merged: ${event.mergedUrl}`);
    });

    this.recordingOrchestrator.on('error', (event) => {
      logger.error(`Recording error in ${event.phase}: ${event.error.message}`);
      if (!event.recoverable) {
        logger.error('Non-recoverable recording error - recording may be incomplete');
      }
    });
  }

  /**
   * Join the meeting - implemented by each platform bot
   */
  abstract join(): Promise<void>;

  /**
   * Start recording the meeting using FFmpeg via RecordingOrchestrator.
   * If noRecording mode is enabled, only starts chat capturer and speaker tracking.
   */
  async startRecording(options: RecordingOptions = {}): Promise<void> {
    const noRecording = this.config.recordingConfig?.noRecording === true;

    // Start chat capturer regardless of recording mode
    if (this.page && this.config.platform) {
      this.chatCapturer = new ChatCapturer(this.page, this.config.platform);
      this.chatCapturer.start();
    }

    if (noRecording) {
      logger.info(`No-recording mode: skipping recording for meeting ${this.config.meetingId}`);
      this.isRecording = false;
      this.startTime = new Date();
      return;
    }

    if (!this.recordingOrchestrator) {
      throw new Error('Recording orchestrator not initialized');
    }

    logger.info(`Starting recording for meeting: ${this.config.meetingId}`);

    await this.recordingOrchestrator.start();

    this.isRecording = true;
    this.startTime = new Date();
    this.lastAudioActivity = Date.now();

    // Start heartbeat
    this.startHeartbeat();

    logger.info('Recording started');
  }

  /**
   * Stop recording and save the file
   */
  async stopRecording(): Promise<string | null> {
    if (!this.isRecording || !this.recordingOrchestrator) {
      return null;
    }

    logger.info('Stopping recording...');

    // Stop the orchestrator with merge and upload
    this.lastRecordingInfo = await this.recordingOrchestrator.stop({
      merge: true,
      upload: true,
      cleanup: true,
    });

    this.isRecording = false;

    // Return the best available URL (S3 merged > S3 video > local path)
    this.recordingPath = this.lastRecordingInfo.s3MergedUrl
      ?? this.lastRecordingInfo.s3VideoUrl
      ?? this.lastRecordingInfo.mergedPath
      ?? this.lastRecordingInfo.videoPath;

    logger.info(`Recording saved: ${this.recordingPath}`);

    return this.recordingPath;
  }

  /**
   * Pause the recording
   */
  pauseRecording(): void {
    if (!this.recordingOrchestrator) {
      logger.warn('Cannot pause: no recording orchestrator');
      return;
    }

    this.recordingOrchestrator.pause();
  }

  /**
   * Resume the recording
   */
  resumeRecording(): void {
    if (!this.recordingOrchestrator) {
      logger.warn('Cannot resume: no recording orchestrator');
      return;
    }

    this.recordingOrchestrator.resume();
  }

  /**
   * Wait for the meeting to end with enhanced auto-leave conditions
   */
  async waitForEnd(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const maxDuration = this.options.maxRecordingDurationMs ?? BOT_CONFIG.MAX_RECORDING_DURATION_MS;
    const checkInterval = BOT_CONFIG.RECORDING_CHECK_INTERVAL_MS;
    const silenceTimeout = this.options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
    const startTime = Date.now();
    const botKeywords = this.options.botKeywords ?? [...DEFAULT_BOT_KEYWORDS];

    while (Date.now() - startTime < maxDuration) {
      // Check if meeting has ended (platform-specific)
      const ended = await this.checkMeetingEnded();
      if (ended) {
        logger.info('Meeting has ended');
        break;
      }

      // Check if we're still in the meeting
      const inMeeting = await this.checkStillInMeeting();
      if (!inMeeting) {
        logger.info('Bot is no longer in meeting');
        break;
      }

      // Max uptime check
      if (Date.now() - startTime >= maxDuration) {
        logger.info(`Max recording duration reached (${Math.floor(maxDuration / 1000)}s), leaving`);
        break;
      }

      // Silence detection: check if there has been audio activity recently
      // (only if recording is active and we have been in the meeting for a while)
      if (this.isRecording && (Date.now() - startTime > 60_000)) {
        const silenceDuration = Date.now() - this.lastAudioActivity;
        if (silenceDuration > silenceTimeout) {
          logger.info(`Silence detected for ${Math.floor(silenceDuration / 1000)}s, auto-leaving`);
          break;
        }
      }

      await this.sleep(checkInterval);
    }
  }

  /**
   * Update the last audio activity timestamp.
   * Should be called by speaker detectors or audio monitors.
   */
  updateAudioActivity(): void {
    this.lastAudioActivity = Date.now();
  }

  /**
   * Check if a participant name matches a known bot keyword
   */
  protected isKnownBot(participantName: string): boolean {
    const botKeywords = this.options.botKeywords ?? [...DEFAULT_BOT_KEYWORDS];
    const lowerName = participantName.toLowerCase();
    return botKeywords.some(keyword => lowerName.includes(keyword.toLowerCase()));
  }

  /**
   * Check if the meeting has ended - implemented by each platform bot
   */
  abstract checkMeetingEnded(): Promise<boolean>;

  /**
   * Check if still in meeting - implemented by each platform bot
   */
  abstract checkStillInMeeting(): Promise<boolean>;

  /**
   * Save the recording and return the path/URL
   * The orchestrator handles S3 upload, so this returns the S3 URL if available
   */
  async saveRecording(): Promise<string> {
    await this.stopRecording();

    if (!this.recordingPath) {
      throw new Error('No recording available');
    }

    return this.recordingPath;
  }

  /**
   * Get the full recording info (includes separate audio URL for transcription)
   */
  getRecordingInfo(): RecordingInfo | null {
    return this.lastRecordingInfo;
  }

  /**
   * Get captured chat messages
   */
  getChatMessages(): CapturedChatMessage[] {
    return this.chatCapturer?.getMessages() ?? [];
  }

  /**
   * Leave the meeting
   */
  abstract leave(): Promise<void>;

  /**
   * Start heartbeat interval for bot session tracking
   */
  private startHeartbeat(): void {
    // Heartbeat is managed by the worker, but we expose a hook
    // The interval is started in index.ts after startRecording
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up bot resources');

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Stop chat capturer
    if (this.chatCapturer) {
      this.chatCapturer.stop();
      this.chatCapturer = null;
    }

    // Force cleanup recording orchestrator if still running
    if (this.recordingOrchestrator?.isRecording() || this.recordingOrchestrator?.isPaused()) {
      try {
        await this.recordingOrchestrator.forceCleanup();
      } catch (error) {
        logger.warn(`Error during recording cleanup: ${error}`);
      }
    }

    if (this.isRecording) {
      await this.stopRecording();
    }

    // Page may already be closed by stopRecording
    if (this.page) {
      try {
        await this.page.close();
      } catch {
        // Page already closed
      }
      this.page = null;
    }

    if (this.context) {
      await this.context.close().catch(() => {});
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
    }

    this.page = null;
    this.context = null;
    this.browser = null;
  }

  /**
   * Capture a screenshot, upload to S3, and store URL in BotLog.
   * Used for debugging join failures and other errors.
   */
  async captureScreenshot(reason: string = 'debug'): Promise<string | null> {
    if (!this.page) return null;

    try {
      const timestamp = Date.now();
      const filename = `screenshot_${this.config.meetingId}_${timestamp}_${reason}.png`;
      const localPath = path.join('/tmp/recordings', filename);

      await this.page.screenshot({ path: localPath, fullPage: true });
      logger.info(`Screenshot captured: ${localPath}`);

      // Upload to S3 if configured
      let s3Url: string | null = null;
      try {
        s3Url = await uploadRecording(localPath, this.config.meetingId);
      } catch {
        logger.warn('Could not upload screenshot to S3');
      }

      // Store in BotLog if bot session exists
      try {
        const session = await prisma.botSession.findUnique({
          where: { meetingId: this.config.meetingId },
        });
        if (session) {
          await prisma.botLog.create({
            data: {
              botSessionId: session.id,
              level: 'INFO',
              message: `Screenshot captured: ${reason}`,
              metadata: {
                screenshotUrl: s3Url || localPath,
                reason,
                timestamp: new Date().toISOString(),
              },
            },
          });
        }
      } catch {
        // Best effort logging
      }

      return s3Url || localPath;
    } catch (error) {
      logger.warn(`Failed to capture screenshot: ${error}`);
      return null;
    }
  }

  /**
   * Capture MHTML page content, upload to S3, and store URL in BotLog.
   */
  async captureMhtml(reason: string = 'debug'): Promise<string | null> {
    if (!this.page) return null;

    try {
      const timestamp = Date.now();
      const filename = `page_${this.config.meetingId}_${timestamp}_${reason}.html`;
      const localPath = path.join('/tmp/recordings', filename);

      const content = await this.page.content();
      fs.writeFileSync(localPath, content, 'utf8');
      logger.info(`Page content captured: ${localPath}`);

      // Upload to S3 if configured
      let s3Url: string | null = null;
      try {
        s3Url = await uploadRecording(localPath, this.config.meetingId);
      } catch {
        logger.warn('Could not upload page content to S3');
      }

      // Store in BotLog
      try {
        const session = await prisma.botSession.findUnique({
          where: { meetingId: this.config.meetingId },
        });
        if (session) {
          await prisma.botLog.create({
            data: {
              botSessionId: session.id,
              level: 'INFO',
              message: `Page content captured: ${reason}`,
              metadata: {
                contentUrl: s3Url || localPath,
                reason,
                timestamp: new Date().toISOString(),
              },
            },
          });
        }
      } catch {
        // Best effort logging
      }

      return s3Url || localPath;
    } catch (error) {
      logger.warn(`Failed to capture page content: ${error}`);
      return null;
    }
  }

  /**
   * Helper to sleep for a given time
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Take a debug screenshot (only if debug mode is enabled)
   */
  protected async takeDebugScreenshot(name: string): Promise<void> {
    if (!this.options.debug || !this.page) return;

    try {
      const dir = this.options.screenshotDir!;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.screenshotCounter++;
      const filename = `${this.config.meetingId}_${this.screenshotCounter.toString().padStart(3, '0')}_${name}.png`;
      const filepath = path.join(dir, filename);

      await this.page.screenshot({ path: filepath, fullPage: true });
      logger.info(`Screenshot saved: ${filepath}`);
    } catch (error) {
      logger.warn(`Failed to take screenshot: ${error}`);
    }
  }

  /**
   * Move mouse in a human-like way to an element before clicking
   */
  protected async humanMove(selector: string): Promise<void> {
    if (!this.page) return;

    try {
      const element = await this.page.$(selector);
      if (!element) return;

      const box = await element.boundingBox();
      if (!box) return;

      // Get current mouse position (default to center of viewport)
      const viewport = this.page.viewportSize() || { width: 1920, height: 1080 };
      let currentX = viewport.width / 2;
      let currentY = viewport.height / 2;

      // Target position with some randomness
      const targetX = box.x + box.width / 2 + (Math.random() - 0.5) * 10;
      const targetY = box.y + box.height / 2 + (Math.random() - 0.5) * 10;

      // Move in steps with slight randomness (simulating human movement)
      const steps = 10 + Math.floor(Math.random() * 10);
      for (let i = 0; i <= steps; i++) {
        const progress = i / steps;
        // Ease-out function for more natural movement
        const eased = 1 - Math.pow(1 - progress, 3);

        const x = currentX + (targetX - currentX) * eased + (Math.random() - 0.5) * 2;
        const y = currentY + (targetY - currentY) * eased + (Math.random() - 0.5) * 2;

        await this.page.mouse.move(x, y);
        await this.sleep(10 + Math.random() * 20);
      }
    } catch (error) {
      // Silently ignore mouse movement errors
    }
  }

  /**
   * Click an element with human-like behavior
   */
  protected async humanClick(selector: string): Promise<boolean> {
    if (!this.page) return false;

    try {
      // First move to the element
      await this.humanMove(selector);

      // Small delay before clicking
      await this.sleep(50 + Math.random() * 100);

      // Click the element
      await this.page.click(selector);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Helper to click an element with retry
   */
  protected async clickWithRetry(
    selector: string,
    options: { timeout?: number; retries?: number; humanLike?: boolean } = {}
  ): Promise<boolean> {
    const { timeout = 5000, retries = 3, humanLike = true } = options;

    for (let i = 0; i < retries; i++) {
      try {
        if (humanLike) {
          const success = await this.humanClick(selector);
          if (success) return true;
        } else {
          await this.page?.click(selector, { timeout });
          return true;
        }
      } catch (error) {
        if (i === retries - 1) {
          logger.warn(`Failed to click ${selector} after ${retries} attempts`);
          return false;
        }
        await this.sleep(1000);
      }
    }
    return false;
  }

  /**
   * Helper to type text with human-like delays
   */
  protected async typeWithDelay(
    selector: string,
    text: string,
    delay: number = 50
  ): Promise<void> {
    await this.page?.fill(selector, '');
    for (const char of text) {
      await this.page?.type(selector, char, { delay });
    }
  }
}
