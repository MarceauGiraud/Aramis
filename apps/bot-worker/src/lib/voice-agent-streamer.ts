/**
 * Voice Agent Streamer
 *
 * Opens a second Playwright browser page that loads an HTTPS URL
 * (e.g., a voice agent UI), and streams it into the meeting
 * via screen share or virtual camera.
 *
 * Features:
 * - Loads external voice agent HTTPS page
 * - Updates URL mid-meeting for agent switching
 * - Health monitoring every 30 seconds
 * - Graceful cleanup on stop
 */

import { EventEmitter } from 'events';
import { Browser, Page, BrowserContext } from 'playwright';
import { logger } from './logger';

export interface VoiceAgentConfig {
  /** HTTPS URL of the voice agent page to load */
  url: string;
  /** Browser instance to create the page in */
  browser: Browser;
  /** Viewport width (default: 1280) */
  width?: number;
  /** Viewport height (default: 720) */
  height?: number;
  /** Health check interval in ms (default: 30000) */
  healthCheckIntervalMs?: number;
}

export class VoiceAgentStreamer extends EventEmitter {
  private config: Required<VoiceAgentConfig>;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private isActive = false;
  private currentUrl: string;

  constructor(config: VoiceAgentConfig) {
    super();
    this.config = {
      url: config.url,
      browser: config.browser,
      width: config.width || 1280,
      height: config.height || 720,
      healthCheckIntervalMs: config.healthCheckIntervalMs || 30000,
    };
    this.currentUrl = config.url;
  }

  /**
   * Start the voice agent by opening a new browser page with the configured URL.
   */
  async start(): Promise<void> {
    if (this.isActive) {
      logger.warn('Voice agent streamer is already active');
      return;
    }

    logger.info(`Starting voice agent streamer with URL: ${this.currentUrl}`);

    try {
      // Create a separate browser context for the voice agent
      this.context = await this.config.browser.newContext({
        viewport: {
          width: this.config.width,
          height: this.config.height,
        },
        permissions: ['microphone', 'camera'],
      });

      this.page = await this.context.newPage();

      // Navigate to the voice agent URL
      await this.page.goto(this.currentUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      this.isActive = true;

      // Start health monitoring
      this.startHealthCheck();

      this.emit('started', { url: this.currentUrl });
      logger.info('Voice agent streamer started');
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Update the voice agent URL mid-meeting.
   * Navigates the existing page to the new URL.
   */
  async updateUrl(newUrl: string): Promise<void> {
    if (!this.page || !this.isActive) {
      throw new Error('Voice agent is not active');
    }

    logger.info(`Updating voice agent URL to: ${newUrl}`);
    this.currentUrl = newUrl;

    try {
      await this.page.goto(newUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      this.emit('url-changed', { url: newUrl });
    } catch (error) {
      logger.error(`Failed to update voice agent URL: ${error}`);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Stop the voice agent and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.isActive) {
      return;
    }

    logger.info('Stopping voice agent streamer');
    await this.cleanup();
    this.emit('stopped');
  }

  /**
   * Get the current URL loaded in the voice agent page.
   */
  getCurrentUrl(): string {
    return this.currentUrl;
  }

  /**
   * Whether the voice agent is currently active.
   */
  getIsActive(): boolean {
    return this.isActive;
  }

  /**
   * Get the Playwright page (for advanced use cases like injecting scripts).
   */
  getPage(): Page | null {
    return this.page;
  }

  /**
   * Start periodic health checks on the voice agent page.
   * Checks that the page is still responsive and reloads if needed.
   */
  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      if (!this.page || !this.isActive) {
        return;
      }

      try {
        // Check if the page is still responsive by evaluating a simple expression
        await this.page.evaluate(() => document.readyState);
        logger.debug('Voice agent health check: OK');
      } catch (error) {
        logger.warn(`Voice agent health check failed: ${error}`);
        this.emit('health-check-failed', { error });

        // Attempt to reload the page
        try {
          await this.page.goto(this.currentUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
          logger.info('Voice agent page reloaded after health check failure');
          this.emit('reloaded', { url: this.currentUrl });
        } catch (reloadError) {
          logger.error(`Voice agent reload failed: ${reloadError}`);
          this.emit('error', reloadError instanceof Error ? reloadError : new Error(String(reloadError)));
        }
      }
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Clean up all resources.
   */
  private async cleanup(): Promise<void> {
    this.isActive = false;

    // Stop health check timer
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Close the page
    if (this.page) {
      try {
        await this.page.close();
      } catch {
        // Ignore close errors
      }
      this.page = null;
    }

    // Close the browser context
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // Ignore close errors
      }
      this.context = null;
    }
  }
}
