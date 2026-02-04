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

    // Wait for page to load with random delay (human-like)
    await this.sleep(2000 + Math.random() * 2000);
    await this.takeDebugScreenshot('01_page_loaded');

    // Handle "Got it" button for any prompts
    if (await this.page.$('text=Got it')) {
      await this.humanClick('text=Got it');
      await this.sleep(500 + Math.random() * 500);
    }

    // Dismiss any other popups
    if (await this.page.$('[aria-label="Dismiss"]')) {
      await this.humanClick('[aria-label="Dismiss"]');
      await this.sleep(300 + Math.random() * 300);
    }

    await this.takeDebugScreenshot('02_after_popups');

    // Enter name if required (for guests) - type like a human
    const nameSelectors = [
      'input[placeholder="Your name"]',
      'input[aria-label="Your name"]',
      'input[aria-label="Votre nom"]',  // French
    ];

    for (const nameSelector of nameSelectors) {
      const nameInput = await this.page.$(nameSelector);
      if (nameInput) {
        // Click the input first
        await this.humanClick(nameSelector);
        await this.sleep(200 + Math.random() * 200);

        // Type the name with human-like delays
        await this.typeWithDelay(nameSelector, this.config.botName, 50 + Math.random() * 50);
        logger.info(`Entered name: ${this.config.botName}`);
        await this.takeDebugScreenshot('03_name_entered');
        break;
      }
    }

    // Turn off camera
    await this.turnOffCamera();
    await this.sleep(300 + Math.random() * 300);

    // Turn off microphone
    await this.turnOffMicrophone();
    await this.sleep(300 + Math.random() * 300);

    await this.takeDebugScreenshot('04_before_join');

    // Click "Ask to join" or "Join now" button - try multiple selectors with human-like click
    const joinSelectors = [
      'button:has-text("Ask to join")',
      'button:has-text("Join now")',
      'button:has-text("Participer")',           // French
      'button:has-text("Demander à rejoindre")', // French
      '[data-idom-class*="join"]',
      '[jsname="Qx7uuf"]',
      'button[data-mdc-dialog-action="join"]',
    ];

    let joinClicked = false;
    for (const selector of joinSelectors) {
      try {
        const joinBtn = await this.page.$(selector);
        if (joinBtn) {
          // Human-like click with mouse movement
          const clicked = await this.humanClick(selector);
          if (clicked) {
            logger.info(`Clicked Join button with selector: ${selector}`);
            await this.takeDebugScreenshot('05_join_clicked');
            joinClicked = true;
            break;
          }
        }
      } catch {
        // Try next selector
      }
    }

    if (!joinClicked) {
      logger.warn('Could not find Join button with any selector');
      await this.takeDebugScreenshot('05_no_join_button');

      // Check if we're blocked or need to sign in
      const pageContent = await this.page.content();
      if (pageContent.includes("can't join") || pageContent.includes('cannot join')) {
        throw new Error('Google Meet: Cannot join this meeting (access denied or meeting restrictions)');
      }
      if (await this.page.$('text=Sign in') || await this.page.$('text=Connexion')) {
        throw new Error('Google Meet requires sign-in for this meeting');
      }
    }

    // Wait a bit after clicking join (with randomness)
    await this.sleep(2000 + Math.random() * 2000);

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

    const cameraSelectors = [
      '[aria-label*="Turn off camera" i]',
      '[aria-label*="Désactiver la caméra" i]',  // French
      '[data-is-muted="false"][aria-label*="camera" i]',
      '[data-is-muted="false"][aria-label*="video" i]',
      '[jsname="BOHaEe"]',
    ];

    for (const selector of cameraSelectors) {
      try {
        const cameraBtn = await this.page.$(selector);
        if (cameraBtn) {
          await this.humanClick(selector);
          logger.info('Turned off camera');
          return;
        }
      } catch {
        // Try next selector
      }
    }
  }

  private async turnOffMicrophone(): Promise<void> {
    if (!this.page) return;

    const micSelectors = [
      '[aria-label*="Turn off microphone" i]',
      '[aria-label*="Désactiver le micro" i]',  // French
      '[data-is-muted="false"][aria-label*="microphone" i]',
      '[data-is-muted="false"][aria-label*="mic" i]',
      '[jsname="Dg9Wp"]',
    ];

    for (const selector of micSelectors) {
      try {
        const micBtn = await this.page.$(selector);
        if (micBtn) {
          await this.humanClick(selector);
          logger.info('Turned off microphone');
          return;
        }
      } catch {
        // Try next selector
      }
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

    // Only check for ended if we actually joined successfully
    if (!this.joinedSuccessfully) {
      return false;
    }

    // Check for meeting ended indicators
    const endedIndicators = [
      'text=You left the meeting',
      'text=The call has ended',
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
      'text=Meeting details',
      'text=Everyone will see',  // Screen share prompt (only in meeting)
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
