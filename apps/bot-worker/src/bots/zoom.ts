import { BaseMeetingBot, BotConfig, BotOptions } from './base';
import { logger } from '../lib/logger';

/**
 * Zoom Meeting Bot
 *
 * Joins Zoom meetings via web client and records audio/video
 */
export class ZoomBot extends BaseMeetingBot {
  constructor(config: BotConfig, options?: BotOptions) {
    super(config, options);
  }

  async join(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    logger.info(`Joining Zoom meeting: ${this.config.meetingUrl}`);

    // Navigate to the meeting URL
    await this.page.goto(this.config.meetingUrl, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Wait for page to load
    await this.sleep(3000);

    // Check if we need to join via browser
    const joinFromBrowserBtn = await this.page.$('text=Join from Your Browser');
    if (joinFromBrowserBtn) {
      await joinFromBrowserBtn.click();
      await this.sleep(2000);
    }

    // Alternative: Look for "Launch Meeting" and then "Join from Browser"
    const launchBtn = await this.page.$('text=Launch Meeting');
    if (launchBtn) {
      // Wait for "Join from Your Browser" link to appear
      await this.page.waitForSelector('text=Join from Your Browser', {
        timeout: 10000,
      });
      await this.page.click('text=Join from Your Browser');
      await this.sleep(2000);
    }

    // Enter name if required
    const nameInput = await this.page.$('#inputname, [placeholder*="name"]');
    if (nameInput) {
      await nameInput.fill(this.config.botName);
      logger.info(`Entered name: ${this.config.botName}`);
    }

    // Handle password if required
    const passwordInput = await this.page.$('#inputpasscode, [placeholder*="password"], [placeholder*="passcode"]');
    if (passwordInput) {
      logger.warn('Meeting requires password - not implemented');
      // Would need to get password from config
    }

    // Click Join button
    const joinBtn = await this.page.$('button:has-text("Join"), #joinBtn, .join-btn');
    if (joinBtn) {
      await joinBtn.click();
      logger.info('Clicked Join button');
    }

    // Wait for meeting to load
    await this.sleep(5000);

    // Handle audio/video prompts
    await this.handleMediaPrompts();

    // Verify we're in the meeting
    const inMeeting = await this.checkStillInMeeting();
    if (!inMeeting) {
      throw new Error('Failed to join Zoom meeting');
    }

    logger.info('Successfully joined Zoom meeting');

    // Start recording
    await this.startRecording();
  }

  private async handleMediaPrompts(): Promise<void> {
    if (!this.page) return;

    // Join audio with computer audio
    const joinAudioBtn = await this.page.$('button:has-text("Join Audio by Computer"), button:has-text("Join with Computer Audio")');
    if (joinAudioBtn) {
      await joinAudioBtn.click();
      await this.sleep(1000);
    }

    // Mute microphone if unmuted
    const muteBtn = await this.page.$('[aria-label*="mute"], .mute-button:not(.muted)');
    if (muteBtn) {
      await muteBtn.click();
      logger.info('Muted microphone');
    }

    // Turn off video if on
    const stopVideoBtn = await this.page.$('[aria-label*="Stop Video"], [aria-label*="stop video"]');
    if (stopVideoBtn) {
      await stopVideoBtn.click();
      logger.info('Turned off video');
    }
  }

  async checkMeetingEnded(): Promise<boolean> {
    if (!this.page) return true;

    // Check for meeting ended indicators
    const endedIndicators = [
      'text=This meeting has been ended',
      'text=The host has ended the meeting',
      'text=Meeting Ended',
      '.meeting-ended',
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
      '#wc-container-left', // Video container
      '.meeting-client', // Meeting client
      '.participants-ul', // Participants list
      '[class*="meeting"]', // Any meeting-related class
    ];

    for (const indicator of meetingIndicators) {
      const element = await this.page.$(indicator);
      if (element) {
        return true;
      }
    }

    // Also check URL
    const url = this.page.url();
    return url.includes('zoom.us/wc') || url.includes('zoom.us/j');
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    logger.info('Leaving Zoom meeting');

    // Click leave button
    const leaveBtn = await this.page.$('[aria-label*="Leave"], button:has-text("Leave")');
    if (leaveBtn) {
      await leaveBtn.click();
      await this.sleep(1000);

      // Confirm leave
      const confirmBtn = await this.page.$('button:has-text("Leave Meeting")');
      if (confirmBtn) {
        await confirmBtn.click();
      }
    }
  }
}
