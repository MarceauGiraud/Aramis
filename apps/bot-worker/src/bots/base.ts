import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../lib/logger';
import { BOT_CONFIG } from '@aramis/shared';

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
        '--incognito',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    // Use incognito context for better isolation
    this.context = await this.browser.newContext({
      permissions: ['microphone', 'camera'],
      viewport: { width: 1920, height: 1080 },
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
