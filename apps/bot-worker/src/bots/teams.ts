import { BaseMeetingBot, BotConfig, BotOptions } from './base';
import { logger } from '../lib/logger';

/**
 * Microsoft Teams Meeting Bot
 *
 * Joins Teams meetings via web client and records audio/video
 */
export class TeamsBot extends BaseMeetingBot {
  constructor(config: BotConfig, options?: BotOptions) {
    super(config, options);
  }

  async join(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    logger.info(`Joining Teams meeting: ${this.config.meetingUrl}`);

    // Navigate to the meeting URL
    await this.page.goto(this.config.meetingUrl, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Wait for page to load
    await this.sleep(3000);

    // Click "Continue on this browser" or similar
    const continueOnBrowserBtn = await this.page.$('text=Continue on this browser');
    if (continueOnBrowserBtn) {
      await continueOnBrowserBtn.click();
      await this.sleep(2000);
    }

    // Alternative: "Join on the web instead"
    const joinWebBtn = await this.page.$('text=Join on the web instead');
    if (joinWebBtn) {
      await joinWebBtn.click();
      await this.sleep(2000);
    }

    // Wait for the pre-join screen
    await this.page.waitForSelector('[data-tid="prejoin-display-name-input"], [placeholder*="Enter name"]', {
      timeout: 30000,
    }).catch(() => {
      logger.warn('Pre-join name input not found');
    });

    // Enter name
    const nameInput = await this.page.$('[data-tid="prejoin-display-name-input"], [placeholder*="Enter name"], #username');
    if (nameInput) {
      await nameInput.fill(this.config.botName);
      logger.info(`Entered name: ${this.config.botName}`);
    }

    // Turn off camera
    const cameraToggle = await this.page.$('[data-tid="toggle-video"], [aria-label*="camera"], [aria-label*="Camera"]');
    if (cameraToggle) {
      const isOn = await cameraToggle.getAttribute('aria-checked');
      if (isOn === 'true') {
        await cameraToggle.click();
        logger.info('Turned off camera');
      }
    }

    // Turn off microphone
    const micToggle = await this.page.$('[data-tid="toggle-mute"], [aria-label*="microphone"], [aria-label*="Microphone"]');
    if (micToggle) {
      const isOn = await micToggle.getAttribute('aria-checked');
      if (isOn === 'true') {
        await micToggle.click();
        logger.info('Turned off microphone');
      }
    }

    // Click Join now button
    const joinBtn = await this.page.$('[data-tid="prejoin-join-button"], button:has-text("Join now")');
    if (joinBtn) {
      await joinBtn.click();
      logger.info('Clicked Join now button');
    }

    // Wait for meeting to load
    await this.sleep(5000);

    // Verify we're in the meeting
    const inMeeting = await this.checkStillInMeeting();
    if (!inMeeting) {
      throw new Error('Failed to join Teams meeting');
    }

    logger.info('Successfully joined Teams meeting');

    // Start recording
    await this.startRecording();
  }

  async checkMeetingEnded(): Promise<boolean> {
    if (!this.page) return true;

    // Check for meeting ended indicators
    const endedIndicators = [
      'text=The meeting has ended',
      'text=You left the meeting',
      'text=Call ended',
      '[data-tid="call-ended"]',
    ];

    for (const indicator of endedIndicators) {
      const element = await this.page.$(indicator);
      if (element) {
        return true;
      }
    }

    return false;
  }

  async checkStillInMeeting(): Promise<boolean> {
    if (!this.page) return false;

    // Check for meeting indicators
    const meetingIndicators = [
      '[data-tid="calling-unified-bar"]', // Control bar
      '[data-tid="roster-button"]', // Participants button
      '.ts-calling-screen', // Calling screen
      '[data-tid="video-gallery"]', // Video gallery
    ];

    for (const indicator of meetingIndicators) {
      const element = await this.page.$(indicator);
      if (element) {
        return true;
      }
    }

    // Check URL
    const url = this.page.url();
    return url.includes('teams.microsoft.com') && url.includes('meetup-join');
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    logger.info('Leaving Teams meeting');

    // Click hangup/leave button
    const leaveBtn = await this.page.$('[data-tid="hangup-button"], [aria-label*="Leave"], [aria-label*="Hang up"]');
    if (leaveBtn) {
      await leaveBtn.click();
      await this.sleep(1000);
    }
  }
}
