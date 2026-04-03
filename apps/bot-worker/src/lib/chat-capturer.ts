/**
 * ChatCapturer
 *
 * Captures chat messages from video meeting platforms by polling the DOM.
 * Supports Google Meet, Zoom, and Teams with platform-specific selectors.
 */

import { Page } from 'playwright';
import { logger } from './logger';
import { CHAT_POLL_INTERVAL_MS } from '@aramis/shared';
import type { MeetingPlatform, ChatMessageData } from '@aramis/shared';

// Platform-specific chat selectors
const CHAT_SELECTORS: Record<
  string,
  {
    messageContainer: string;
    senderName: string;
    messageText: string;
    altContainer: string;
    altSender: string;
    altMessage: string;
  }
> = {
  GOOGLE_MEET: {
    messageContainer: '[data-message-text]',
    senderName: '[data-sender-name]',
    messageText: '[data-message-text]',
    // Alternative selectors for different Meet versions
    altContainer: '.GDhqjd',
    altSender: '.YTbUzc',
    altMessage: '.oIy2qc',
  },
  ZOOM: {
    messageContainer: '.chat-item, .new-chat-message__container',
    senderName: '.chat-item__sender, .new-chat-message__sender',
    messageText: '.chat-item__text, .new-chat-message__text',
    // Web client selectors
    altContainer: '[data-message-id]',
    altSender: '.message-author',
    altMessage: '.message-content',
  },
  TEAMS: {
    // Teams v2 (Fluent UI / React SPA) + classic Teams selectors
    messageContainer:
      '[data-tid="chat-pane-message"], [data-tid="message-wrapper"], [data-tid="chat-message"], .ts-message-list-item, .fui-ChatMessage',
    senderName:
      '[data-tid="message-author"], [data-tid="message-author-name"], .ts-message-header-name, .fui-ChatMessage__author',
    messageText:
      '[data-tid="message-body"], [data-tid="message-body-content"], .ts-message-body, .fui-ChatMessage__body',
    // Alternative selectors
    altContainer: '.message-body-container, [data-tid="chat-message-list"] > div',
    altSender: '.message-author-text, [data-tid="message-author-name"]',
    altMessage: '.message-body-content, [data-tid="message-body-content"]',
  },
};

export interface CapturedChatMessage {
  sender: string;
  message: string;
  timestamp: Date;
  platform: MeetingPlatform;
}

export class ChatCapturer {
  private page: Page;
  private platform: MeetingPlatform;
  private isRunning = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private capturedMessages: CapturedChatMessage[] = [];
  private seenMessageKeys = new Set<string>();

  constructor(page: Page, platform: MeetingPlatform) {
    this.page = page;
    this.platform = platform;
  }

  /**
   * Start capturing chat messages
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    logger.info(`Starting chat capture for ${this.platform}`);

    // Open chat panel if possible
    this.openChatPanel().catch(() => {
      logger.debug('Could not auto-open chat panel');
    });

    this.pollInterval = setInterval(() => {
      this.pollMessages().catch((error) => {
        if (this.isRunning) {
          logger.debug(`Chat poll error: ${error}`);
        }
      });
    }, CHAT_POLL_INTERVAL_MS);
  }

  /**
   * Stop capturing chat messages
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info(`Chat capture stopped. Captured ${this.capturedMessages.length} messages`);
  }

  /**
   * Get all captured messages
   */
  getMessages(): CapturedChatMessage[] {
    return [...this.capturedMessages];
  }

  /**
   * Try to open the chat panel on the meeting platform
   */
  private async openChatPanel(): Promise<void> {
    const chatButtonSelectors: Record<MeetingPlatform, string[]> = {
      GOOGLE_MEET: ['[aria-label*="Chat" i]', '[aria-label*="chat" i]', '[data-tooltip*="Chat" i]'],
      ZOOM: ['[aria-label*="Chat" i]', '#chatButton', '.chat-button'],
      TEAMS: ['[data-tid="chat-button"]', '[data-tid="meeting-chat-button"]', '[aria-label*="Chat" i]'],
    };

    const selectors = chatButtonSelectors[this.platform];

    // For Teams, use page.evaluate() to click programmatically.
    // The recording UI injects a blanket overlay at z-index 1998 that covers
    // the chat button, causing Playwright actionability checks to fail.
    if (this.platform === 'TEAMS') {
      try {
        const clicked = await this.page.evaluate((sels: string[]) => {
          for (const sel of sels) {
            const btn = document.querySelector<HTMLElement>(sel);
            if (btn) {
              btn.click();
              return sel;
            }
          }
          return null;
        }, selectors);
        if (clicked) {
          logger.info(`Opened chat panel via JS click (${clicked})`);
          return;
        }
      } catch {
        // Fall through to standard approach
      }
    }

    for (const selector of selectors) {
      try {
        const btn = await this.page.$(selector);
        if (btn) {
          await btn.click();
          logger.info('Opened chat panel');
          return;
        }
      } catch {
        // Continue
      }
    }
  }

  /**
   * Poll the DOM for new chat messages
   */
  private async pollMessages(): Promise<void> {
    if (!this.isRunning) return;

    const selectors = CHAT_SELECTORS[this.platform];

    try {
      const messages = await this.page.evaluate(
        ({ selectors, platform }: { selectors: any; platform: string }) => {
          const results: Array<{ sender: string; message: string }> = [];

          // Try primary selectors
          const containers = document.querySelectorAll(selectors.messageContainer);
          for (const container of containers) {
            let sender = '';
            let message = '';

            if (platform === 'GOOGLE_MEET') {
              sender =
                container.getAttribute('data-sender-name') ||
                container.closest('[data-sender-name]')?.getAttribute('data-sender-name') ||
                '';
              message = container.getAttribute('data-message-text') || container.textContent?.trim() || '';
            } else {
              const senderEl = container.querySelector(selectors.senderName);
              const messageEl = container.querySelector(selectors.messageText);
              sender = senderEl?.textContent?.trim() || '';
              message = messageEl?.textContent?.trim() || '';
            }

            if (sender && message) {
              results.push({ sender, message });
            }
          }

          // Try alternative selectors if primary yielded nothing
          if (results.length === 0) {
            const altContainers = document.querySelectorAll(selectors.altContainer);
            for (const container of altContainers) {
              const senderEl = container.querySelector(selectors.altSender);
              const messageEl = container.querySelector(selectors.altMessage);
              const sender = senderEl?.textContent?.trim() || '';
              const message = messageEl?.textContent?.trim() || '';

              if (sender && message) {
                results.push({ sender, message });
              }
            }
          }

          return results;
        },
        { selectors, platform: this.platform },
      );

      // Deduplicate and store new messages
      for (const msg of messages) {
        const key = `${msg.sender}|${msg.message}`;
        if (!this.seenMessageKeys.has(key)) {
          this.seenMessageKeys.add(key);
          const captured: CapturedChatMessage = {
            sender: msg.sender,
            message: msg.message,
            timestamp: new Date(),
            platform: this.platform,
          };
          this.capturedMessages.push(captured);
          logger.debug(`Chat captured: [${msg.sender}] ${msg.message.substring(0, 100)}`);
        }
      }
    } catch {
      // Page may be navigating or closed; non-fatal
    }
  }
}
