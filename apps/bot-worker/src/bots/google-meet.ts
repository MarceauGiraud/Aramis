import { BaseMeetingBot, BotConfig } from './base';
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
  constructor(config: BotConfig) {
    super(config);
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

    // Enter name if required (for guests)
    const nameInput = await this.page.$('input[placeholder="Your name"], input[aria-label="Your name"]');
    if (nameInput) {
      await nameInput.fill(this.config.botName);
      logger.info(`Entered name: ${this.config.botName}`);
    }

    // Turn off camera
    await this.turnOffCamera();

    // Turn off microphone
    await this.turnOffMicrophone();

    // Click "Ask to join" or "Join now" button
    const joinBtn = await this.page.$('button:has-text("Ask to join"), button:has-text("Join now"), [data-idom-class*="join"]');
    if (joinBtn) {
      await joinBtn.click();
      logger.info('Clicked Join button');
    }

    // Wait to be admitted (if needed)
    await this.waitForAdmission();

    // Verify we're in the meeting
    const inMeeting = await this.checkStillInMeeting();
    if (!inMeeting) {
      throw new Error('Failed to join Google Meet');
    }

    logger.info('Successfully joined Google Meet');

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
      '[data-call-ended="true"]',
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
      '[data-meeting-title]', // Meeting title
      '[data-self-name]', // Self video
      '[jscontroller="kAPMuc"]', // Main meeting container
      '[data-participant-id]', // Any participant
      '[aria-label*="Leave call"]', // Leave button
    ];

    for (const indicator of meetingIndicators) {
      const element = await this.page.$(indicator);
      if (element) {
        return true;
      }
    }

    // Check URL - must still be on meet.google.com with a meeting code
    const url = this.page.url();
    return url.includes('meet.google.com/') && /\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url);
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
