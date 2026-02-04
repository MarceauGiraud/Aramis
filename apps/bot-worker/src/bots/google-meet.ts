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
  private joinedAt: Date | null = null;
  private lastKnownParticipantCount = 0;

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

    // Handle all popups and dialogs first
    await this.handlePopups();

    await this.takeDebugScreenshot('02_after_popups');

    // Turn off camera and microphone
    await this.turnOffCamera();
    await this.sleep(300 + Math.random() * 200);
    await this.turnOffMicrophone();
    await this.sleep(300 + Math.random() * 200);

    await this.takeDebugScreenshot('02b_media_off');

    // Enter name if required (for guests) - type like a human
    await this.enterName();

    // Double-check camera and mic are off after name entry
    await this.sleep(500);
    await this.turnOffCamera();
    await this.turnOffMicrophone();

    await this.takeDebugScreenshot('04_before_join');

    // Click "Ask to join" or "Join now" button
    const joinClicked = await this.clickJoinButton();

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
    this.joinedAt = new Date();
    logger.info('Successfully joined Google Meet');
    await this.takeDebugScreenshot('07_joined_successfully');

    // Start recording
    await this.startRecording();
  }

  /**
   * Handle all popups and permission dialogs
   */
  private async handlePopups(): Promise<void> {
    if (!this.page) return;

    // Common popup/dialog dismiss buttons
    const popupSelectors = [
      'text=Got it',
      'text=OK',
      'text=Compris',           // French "Got it"
      'text=Allow',
      'text=Autoriser',         // French "Allow"
      '[aria-label="Dismiss"]',
      '[aria-label="Close"]',
      '[aria-label="Fermer"]',  // French "Close"
      'button:has-text("Dismiss")',
      'button:has-text("Close")',
      // Camera/Mic permission dialogs
      'button:has-text("Allow")',
      'button:has-text("Block")',  // Click block to deny camera if needed
    ];

    for (const selector of popupSelectors) {
      try {
        const popup = await this.page.$(selector);
        if (popup) {
          await this.humanClick(selector);
          logger.info(`Dismissed popup: ${selector}`);
          await this.sleep(300 + Math.random() * 200);
        }
      } catch {
        // Continue to next selector
      }
    }

    // Handle Google's "Use camera" prompt by clicking outside or pressing Escape
    try {
      const cameraPrompt = await this.page.$('text=Use your camera');
      if (cameraPrompt) {
        await this.page.keyboard.press('Escape');
        logger.info('Escaped camera prompt');
        await this.sleep(500);
      }
    } catch {
      // Ignore
    }

    // Also check for French camera prompt
    try {
      const cameraPromptFr = await this.page.$('text=Utiliser votre caméra');
      if (cameraPromptFr) {
        await this.page.keyboard.press('Escape');
        logger.info('Escaped camera prompt (French)');
        await this.sleep(500);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Enter the bot name in the name field
   */
  private async enterName(): Promise<void> {
    if (!this.page) return;

    const nameSelectors = [
      'input[placeholder="Your name"]',
      'input[aria-label="Your name"]',
      'input[placeholder="Votre nom"]',
      'input[aria-label="Votre nom"]',
      'input[data-placeholder="Your name"]',
    ];

    for (const nameSelector of nameSelectors) {
      try {
        const nameInput = await this.page.$(nameSelector);
        if (nameInput) {
          // Click the input field first
          await nameInput.click();
          await this.sleep(200 + Math.random() * 100);

          // Clear any existing text
          await nameInput.fill('');
          await this.sleep(100);

          // Type with human-like delays
          for (const char of this.config.botName) {
            await nameInput.type(char, { delay: 40 + Math.random() * 60 });
          }

          logger.info(`Entered name: ${this.config.botName}`);
          await this.takeDebugScreenshot('03_name_entered');
          return;
        }
      } catch (e) {
        logger.warn(`Failed to enter name with selector ${nameSelector}: ${e}`);
      }
    }

    logger.warn('Could not find name input field');
  }

  /**
   * Click the join button
   */
  private async clickJoinButton(): Promise<boolean> {
    if (!this.page) return false;

    const joinSelectors = [
      'button:has-text("Ask to join")',
      'button:has-text("Join now")',
      'button:has-text("Participer")',
      'button:has-text("Demander à rejoindre")',
      '[data-idom-class*="join"]',
      '[jsname="Qx7uuf"]',
      'button[data-mdc-dialog-action="join"]',
    ];

    for (const selector of joinSelectors) {
      try {
        const joinBtn = await this.page.$(selector);
        if (joinBtn) {
          const clicked = await this.humanClick(selector);
          if (clicked) {
            logger.info(`Clicked Join button with selector: ${selector}`);
            await this.takeDebugScreenshot('05_join_clicked');
            return true;
          }
        }
      } catch {
        // Try next selector
      }
    }

    return false;
  }

  private async turnOffCamera(): Promise<void> {
    if (!this.page) return;

    // All possible camera button selectors - try each one
    const cameraSelectors = [
      '[aria-label*="Turn off camera" i]',
      '[aria-label*="Désactiver la caméra" i]',  // French
      '[aria-label*="camera" i][data-is-muted="false"]',
      '[data-is-muted="false"][aria-label*="video" i]',
      '[jsname="BOHaEe"]',  // Pre-join camera button
      'button[aria-label*="camera" i]',
      '[role="button"][aria-label*="camera" i]',
    ];

    for (const selector of cameraSelectors) {
      try {
        const cameraBtn = await this.page.$(selector);
        if (cameraBtn) {
          await this.humanClick(selector);
          logger.info(`Turned off camera with selector: ${selector}`);
          return;
        }
      } catch {
        // Try next selector
      }
    }

    // If no camera button found, that's okay - might already be off
    logger.info('No camera button found (may already be off)');
  }

  private async turnOffMicrophone(): Promise<void> {
    if (!this.page) return;

    // All possible microphone button selectors - try each one
    const micSelectors = [
      '[aria-label*="Turn off microphone" i]',
      '[aria-label*="Désactiver le micro" i]',  // French
      '[aria-label*="microphone" i][data-is-muted="false"]',
      '[data-is-muted="false"][aria-label*="mic" i]',
      '[jsname="Dg9Wp"]',  // Pre-join mic button
      'button[aria-label*="microphone" i]',
      '[role="button"][aria-label*="microphone" i]',
    ];

    for (const selector of micSelectors) {
      try {
        const micBtn = await this.page.$(selector);
        if (micBtn) {
          await this.humanClick(selector);
          logger.info(`Turned off microphone with selector: ${selector}`);
          return;
        }
      } catch {
        // Try next selector
      }
    }

    // If no mic button found, that's okay - might already be off
    logger.info('No microphone button found (may already be off)');
  }

  private async waitForAdmission(): Promise<void> {
    if (!this.page) return;

    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check if we've been kicked out or denied
      const kickedOutIndicators = [
        'text=You can\'t join this video call',
        'text=Vous ne pouvez pas rejoindre',
        'text=denied',
        'text=removed',
        'text=kicked',
      ];

      for (const indicator of kickedOutIndicators) {
        try {
          const kicked = await this.page.$(indicator);
          if (kicked) {
            throw new Error('Bot was denied entry or kicked from waiting room');
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('denied')) {
            throw e;
          }
          // Ignore selector errors
        }
      }

      // Check if we're in the meeting
      const inMeeting = await this.checkStillInMeeting();
      if (inMeeting) {
        logger.info('Successfully admitted to meeting');
        return;
      }

      // Check if we're waiting to be admitted (multiple languages)
      const waitingIndicators = [
        'text=Waiting for someone to let you in',
        'text=Asking to be let in',
        'text=En attente',
        'text=Demande en cours',
      ];

      let isWaiting = false;
      for (const indicator of waitingIndicators) {
        try {
          const waiting = await this.page.$(indicator);
          if (waiting) {
            isWaiting = true;
            break;
          }
        } catch {
          // Ignore
        }
      }

      if (!isWaiting) {
        // Not waiting anymore - either admitted or something else happened
        return;
      }

      logger.info('Waiting to be admitted to the meeting...');

      // Simulate human-like behavior while waiting (small random mouse movements)
      if (Math.random() > 0.7) {
        const viewport = this.page.viewportSize() || { width: 1920, height: 1080 };
        await this.page.mouse.move(
          viewport.width / 2 + (Math.random() - 0.5) * 100,
          viewport.height / 2 + (Math.random() - 0.5) * 100
        );
      }

      await this.sleep(3000 + Math.random() * 2000);
    }

    throw new Error('Timed out waiting to be admitted');
  }

  /**
   * Get the number of participants in the meeting
   */
  private async getParticipantCount(): Promise<number> {
    if (!this.page) return 0;

    try {
      // Try to find participant count from the UI
      // Google Meet shows participant count in various places

      // Method 1: Check the participant panel button text
      const participantBtnSelectors = [
        '[aria-label*="participant" i]',
        '[aria-label*="people" i]',
        '[data-participant-count]',
      ];

      for (const selector of participantBtnSelectors) {
        const btn = await this.page.$(selector);
        if (btn) {
          const text = await btn.textContent();
          const match = text?.match(/(\d+)/);
          if (match) {
            return parseInt(match[1], 10);
          }

          // Try aria-label
          const label = await btn.getAttribute('aria-label');
          const labelMatch = label?.match(/(\d+)/);
          if (labelMatch) {
            return parseInt(labelMatch[1], 10);
          }
        }
      }

      // Method 2: Count visible participant tiles
      const participantTiles = await this.page.$$('[data-participant-id], [data-requested-participant-id], [data-allocation-index]');
      if (participantTiles.length > 0) {
        return participantTiles.length;
      }

      // Method 3: If in meeting but can't count, assume at least 1 (self)
      return 1;
    } catch (error) {
      logger.warn(`Failed to get participant count: ${error}`);
      return 1;
    }
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

    // Only check participant count after being in the meeting for at least 60 seconds
    // This prevents false positives when the UI hasn't fully loaded participant info
    const minTimeInMeeting = 60 * 1000; // 60 seconds
    if (this.joinedAt) {
      const timeInMeeting = Date.now() - this.joinedAt.getTime();
      if (timeInMeeting < minTimeInMeeting) {
        logger.debug(`Skipping participant count check (only ${Math.floor(timeInMeeting / 1000)}s in meeting)`);
        return false;
      }
    }

    // Check if the bot is the only participant left
    const participantCount = await this.getParticipantCount();

    // Track the highest participant count we've seen
    if (participantCount > this.lastKnownParticipantCount) {
      this.lastKnownParticipantCount = participantCount;
      logger.info(`Participant count updated: ${participantCount}`);
    }

    // Only leave if:
    // 1. We've seen more than 1 participant at some point (others were present)
    // 2. Now there's only 1 participant (just the bot)
    if (participantCount <= 1 && this.lastKnownParticipantCount > 1) {
      logger.info(`Meeting ended: Bot is the only participant left (count: ${participantCount}, peak: ${this.lastKnownParticipantCount})`);
      // Leave the meeting gracefully
      await this.leave();
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
