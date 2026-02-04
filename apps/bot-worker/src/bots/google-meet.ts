import { BaseMeetingBot, BotConfig, BotOptions } from './base';
import { logger } from '../lib/logger';

/**
 * Google Meet Bot
 *
 * Joins Google Meet meetings via web client and records audio/video
 *
 * Note: Google Meet may require authentication for some meetings.
 * This implementation handles public meetings and meetings where
 * guests are allowed to join.
 */
export class GoogleMeetBot extends BaseMeetingBot {
  private joinedSuccessfully = false;

  constructor(config: BotConfig, options: BotOptions = {}) {
    super(config, options);
  }

  async join(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    logger.info(`Joining Google Meet: ${this.config.meetingUrl}`);

    // Navigate to the meeting URL
    await this.page.goto(this.config.meetingUrl, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Wait for page to load
    await this.sleep(3000);
    await this.takeDebugScreenshot('01_page_loaded');

    // Handle "Got it" button for any prompts
    const gotItBtn = await this.page.$('text=Got it');
    if (gotItBtn) {
      await gotItBtn.click();
      await this.sleep(1000);
    }

    // Dismiss any other popups
    const dismissBtn = await this.page.$('[aria-label="Dismiss"]');
    if (dismissBtn) {
      await dismissBtn.click();
      await this.sleep(500);
    }

    await this.takeDebugScreenshot('02_after_popups');

    // Enter name if required (for guests)
    const nameInput = await this.page.$('input[placeholder="Your name"], input[aria-label="Your name"]');
    if (nameInput) {
      await nameInput.fill(this.config.botName);
      logger.info(`Entered name: ${this.config.botName}`);
      await this.takeDebugScreenshot('03_name_entered');
    }

    // Turn off camera
    await this.turnOffCamera();

    // Turn off microphone
    await this.turnOffMicrophone();

    await this.takeDebugScreenshot('04_before_join');

    // Click "Ask to join" or "Join now" button
    const joinBtn = await this.page.$('button:has-text("Ask to join"), button:has-text("Join now"), [data-idom-class*="join"]');
    if (joinBtn) {
      await joinBtn.click();
      logger.info('Clicked Join button');
      await this.takeDebugScreenshot('05_join_clicked');
    } else {
      logger.warn('Could not find Join button');
      await this.takeDebugScreenshot('05_no_join_button');
    }

    // Wait to be admitted (if needed)
    await this.waitForAdmission();
    await this.takeDebugScreenshot('06_after_admission');

    // Verify we're in the meeting
    const inMeeting = await this.checkStillInMeeting();
    if (!inMeeting) {
      await this.takeDebugScreenshot('07_join_failed');
      throw new Error('Failed to join Google Meet');
    }

    this.joinedSuccessfully = true;
    logger.info('Successfully joined Google Meet');
    await this.takeDebugScreenshot('07_joined_successfully');

    // Start recording
    await this.startRecording();
  }

  private async turnOffCamera(): Promise<void> {
    if (!this.page) return;

    // Find camera button - could have different states
    const cameraBtn = await this.page.$('[aria-label*="camera" i], [data-is-muted="false"][aria-label*="video" i]');
    if (cameraBtn) {
      const isMuted = await cameraBtn.getAttribute('data-is-muted');
      if (isMuted !== 'true') {
        await cameraBtn.click();
        logger.info('Turned off camera');
      }
    }

    // Alternative selector for pre-join screen
    const preJoinCamera = await this.page.$('[jsname="BOHaEe"], [aria-label*="Turn off camera"]');
    if (preJoinCamera) {
      await preJoinCamera.click();
      logger.info('Turned off camera (pre-join)');
    }
  }

  private async turnOffMicrophone(): Promise<void> {
    if (!this.page) return;

    // Find microphone button
    const micBtn = await this.page.$('[aria-label*="microphone" i], [data-is-muted="false"][aria-label*="mic" i]');
    if (micBtn) {
      const isMuted = await micBtn.getAttribute('data-is-muted');
      if (isMuted !== 'true') {
        await micBtn.click();
        logger.info('Turned off microphone');
      }
    }

    // Alternative selector for pre-join screen
    const preJoinMic = await this.page.$('[jsname="Dg9Wp"], [aria-label*="Turn off microphone"]');
    if (preJoinMic) {
      await preJoinMic.click();
      logger.info('Turned off microphone (pre-join)');
    }
  }

  private async waitForAdmission(): Promise<void> {
    if (!this.page) return;

    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check if we're in the meeting
      const inMeeting = await this.checkStillInMeeting();
      if (inMeeting) {
        return;
      }

      // Check if we're waiting to be admitted
      const waitingText = await this.page.$('text=Waiting for someone to let you in');
      if (!waitingText) {
        // Not waiting anymore
        return;
      }

      logger.info('Waiting to be admitted to the meeting...');
      await this.sleep(5000);
    }

    throw new Error('Timed out waiting to be admitted');
  }

  async checkMeetingEnded(): Promise<boolean> {
    if (!this.page) return true;

    // Check for meeting ended indicators
    const endedIndicators = [
      'text=You left the meeting',
      'text=The call has ended',
      'text=Return to home screen',
      'text=You\'ve been removed from the meeting',
      'text=This meeting has ended',
      '[data-call-ended="true"]',
    ];

    for (const indicator of endedIndicators) {
      try {
        const element = await this.page.$(indicator);
        if (element) {
          logger.info(`Meeting ended: found indicator ${indicator}`);
          return true;
        }
      } catch {
        // Ignore selector errors
      }
    }

    // Check if we're no longer on a meeting URL
    const url = this.page.url();
    if (!url.includes('meet.google.com/') || url.includes('meet.google.com/?')) {
      // Redirected away from meeting
      logger.info(`Meeting ended: URL changed to ${url}`);
      return true;
    }

    return false;
  }

  async checkStillInMeeting(): Promise<boolean> {
    if (!this.page) return false;

    // Check for meeting indicators - these indicate we're in the actual meeting
    const meetingIndicators = [
      '[data-meeting-title]', // Meeting title
      '[data-self-name]', // Self video
      '[jscontroller="kAPMuc"]', // Main meeting container
      '[data-participant-id]', // Any participant
      '[aria-label*="Leave call"]', // Leave button
      '[aria-label*="leave" i]', // Alternative leave button
      '[data-call-active="true"]', // Active call indicator
      // Video grid indicators
      '[data-allocation-index]', // Participant tiles
      '[data-requested-participant-id]', // Participant in grid
    ];

    for (const indicator of meetingIndicators) {
      try {
        const element = await this.page.$(indicator);
        if (element) {
          logger.info(`In meeting: found indicator ${indicator}`);
          return true;
        }
      } catch {
        // Ignore selector errors
      }
    }

    // Check for common meeting UI elements using text content
    const textIndicators = [
      'text=Present now',
      'text=You',
      'text=Meeting details',
    ];

    for (const indicator of textIndicators) {
      try {
        const element = await this.page.$(indicator);
        if (element) {
          logger.info(`In meeting: found text indicator ${indicator}`);
          return true;
        }
      } catch {
        // Ignore selector errors
      }
    }

    // Check URL - must still be on meet.google.com with a meeting code
    const url = this.page.url();
    const urlMatch = url.includes('meet.google.com/') && /\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url);

    // If we've joined successfully before, trust the URL check
    if (this.joinedSuccessfully && urlMatch) {
      return true;
    }

    logger.info(`Not in meeting: no indicators found, url=${url}`);
    return false;
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    logger.info('Leaving Google Meet');

    // Click leave/hangup button
    const leaveBtn = await this.page.$('[aria-label*="Leave call"], [aria-label*="leave" i], [jsname="CQylAd"]');
    if (leaveBtn) {
      await leaveBtn.click();
      await this.sleep(1000);
    }
  }
}
