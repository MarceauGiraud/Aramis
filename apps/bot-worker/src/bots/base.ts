import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../lib/logger';
import { BOT_CONFIG } from '@aramis/shared';

export interface BotConfig {
  meetingId: string;
  meetingUrl: string;
  botName: string;
}

export interface RecordingOptions {
  outputDir?: string;
  format?: 'webm' | 'mp4';
}

export interface BotOptions {
  headless?: boolean;
  debug?: boolean;
  screenshotDir?: string;
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

  constructor(config: BotConfig, options: BotOptions = {}) {
    this.config = config;
    this.options = {
      headless: options.headless ?? (process.env.BOT_HEADLESS !== 'false'),
      debug: options.debug ?? (process.env.BOT_DEBUG === 'true'),
      screenshotDir: options.screenshotDir ?? '/tmp/bot-screenshots',
    };
  }

  /**
   * Initialize the browser with stealth settings
   */
  async initialize(): Promise<void> {
    logger.info(`Initializing bot for meeting: ${this.config.meetingId}`);
    logger.info(`Bot options: headless=${this.options.headless}, debug=${this.options.debug}`);

    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--use-fake-ui-for-media-stream', // Auto-accept camera/mic permissions
        '--use-fake-device-for-media-stream', // Use fake media devices
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    this.context = await this.browser.newContext({
      permissions: ['microphone', 'camera'],
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    this.page = await this.context.newPage();

    // Add stealth scripts to avoid detection
    await this.page.addInitScript(() => {
      // Override webdriver detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      // Override plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });
  }

  /**
   * Join the meeting - implemented by each platform bot
   */
  abstract join(): Promise<void>;

  /**
   * Start recording the meeting
   */
  async startRecording(options: RecordingOptions = {}): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const outputDir = options.outputDir || '/tmp/recordings';
    const format = options.format || 'webm';

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    this.recordingPath = path.join(
      outputDir,
      `${this.config.meetingId}_${Date.now()}.${format}`
    );

    logger.info(`Starting recording: ${this.recordingPath}`);

    // Use CDP to capture the page
    const client = await this.page.context().newCDPSession(this.page);

    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      everyNthFrame: 1,
    });

    this.isRecording = true;
    this.startTime = new Date();

    logger.info('Recording started');
  }

  /**
   * Stop recording and save the file
   */
  async stopRecording(): Promise<string | null> {
    if (!this.isRecording || !this.page) {
      return null;
    }

    logger.info('Stopping recording...');

    const client = await this.page.context().newCDPSession(this.page);
    await client.send('Page.stopScreencast');

    this.isRecording = false;

    logger.info(`Recording saved: ${this.recordingPath}`);

    return this.recordingPath;
  }

  /**
   * Wait for the meeting to end
   */
  async waitForEnd(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const maxDuration = BOT_CONFIG.MAX_RECORDING_DURATION_MS;
    const checkInterval = BOT_CONFIG.RECORDING_CHECK_INTERVAL_MS;
    const startTime = Date.now();

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

      await this.sleep(checkInterval);
    }
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
   * Save the recording and return the path
   */
  async saveRecording(): Promise<string> {
    await this.stopRecording();

    if (!this.recordingPath) {
      throw new Error('No recording available');
    }

    // In a real implementation, upload to S3 here
    return this.recordingPath;
  }

  /**
   * Leave the meeting
   */
  abstract leave(): Promise<void>;

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up bot resources');

    if (this.isRecording) {
      await this.stopRecording();
    }

    if (this.page) {
      await this.page.close().catch(() => {});
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
   * Helper to click an element with retry
   */
  protected async clickWithRetry(
    selector: string,
    options: { timeout?: number; retries?: number } = {}
  ): Promise<boolean> {
    const { timeout = 5000, retries = 3 } = options;

    for (let i = 0; i < retries; i++) {
      try {
        await this.page?.click(selector, { timeout });
        return true;
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
