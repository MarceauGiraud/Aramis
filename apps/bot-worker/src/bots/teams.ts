import { BaseMeetingBot, BotConfig, BotOptions } from './base';
import { logger } from '../lib/logger';

/**
 * Microsoft Teams Meeting Bot
 *
 * Joins Teams meetings via web client and records audio/video
 * Uses the Teams web client for browser-based joining
 */
export class TeamsBot extends BaseMeetingBot {
  private joinedSuccessfully = false;
  private joinedAt: Date | null = null;
  private lastKnownParticipantCount = 0;

  constructor(config: BotConfig, options?: BotOptions) {
    super({ ...config, platform: config.platform ?? 'TEAMS' }, options);
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

    // Wait for page to load with random delay (human-like)
    await this.sleep(2000 + Math.random() * 2000);
    await this.takeDebugScreenshot('01_page_loaded');

    // Handle "Continue on this browser" / "Join on the web" flow
    await this.handleWebJoin();
    await this.takeDebugScreenshot('02_after_web_join');

    // Wait for pre-join screen
    await this.waitForPreJoinScreen();
    await this.sleep(1000 + Math.random() * 1000);

    // Enter name
    await this.enterName();
    await this.takeDebugScreenshot('03_name_entered');

    // Turn off camera and microphone
    await this.turnOffCamera();
    await this.sleep(300 + Math.random() * 200);
    await this.turnOffMicrophone();
    await this.sleep(300 + Math.random() * 200);

    await this.takeDebugScreenshot('04_media_off');

    // Click Join button
    const joinClicked = await this.clickJoinButton();
    if (!joinClicked) {
      logger.warn('Could not find Join button');
      await this.takeDebugScreenshot('05_no_join_button');
    }

    await this.takeDebugScreenshot('05_join_clicked');

    // Wait for meeting to load
    await this.sleep(3000 + Math.random() * 2000);

    // Wait for admission if in lobby
    await this.waitForAdmission();
    await this.takeDebugScreenshot('06_after_admission');

    // Verify we're in the meeting
    const inMeeting = await this.checkStillInMeeting();
    if (!inMeeting) {
      await this.takeDebugScreenshot('07_join_failed');
      throw new Error('Failed to join Teams meeting');
    }

    this.joinedSuccessfully = true;
    this.joinedAt = new Date();
    logger.info('Successfully joined Teams meeting');
    await this.takeDebugScreenshot('07_joined_successfully');

    // Start recording
    await this.startRecording();
  }

  /**
   * Handle "Continue on this browser" / "Join on the web" flow
   */
  private async handleWebJoin(): Promise<void> {
    if (!this.page) return;

    // Teams shows different options to join via browser
    const webJoinSelectors = [
      'text=Continue on this browser',
      'text=Join on the web instead',
      'text=Join on the web',
      'text=Use web instead',
      'a:has-text("Continue on this browser")',
      'a:has-text("Join on the web instead")',
      'button:has-text("Continue on this browser")',
      '[data-tid="joinOnWeb"]',
      '#openTeamsClientInBrowser',
      // French versions
      'text=Continuer sur ce navigateur',
      'text=Rejoindre sur le web',
    ];

    for (const selector of webJoinSelectors) {
      try {
        const element = await this.page.$(selector);
        if (element) {
          await this.humanClick(selector);
          logger.info(`Clicked web join: ${selector}`);
          await this.sleep(3000 + Math.random() * 2000);
          return;
        }
      } catch {
        // Try next selector
      }
    }

    // Sometimes Teams auto-redirects, check if we're already on the pre-join page
    const onPreJoin = await this.page.$('[data-tid="prejoin-display-name-input"], [placeholder*="Enter name" i]');
    if (onPreJoin) {
      logger.info('Already on pre-join page');
      return;
    }

    logger.info('No web join button found (may already be in web client)');
  }

  /**
   * Wait for the pre-join screen to appear
   */
  private async waitForPreJoinScreen(): Promise<void> {
    if (!this.page) return;

    const preJoinSelectors = [
      '[data-tid="prejoin-display-name-input"]',
      '[placeholder*="Enter name" i]',
      '[placeholder*="Entrez votre nom" i]',
      '#username',
      '.calling-prejoin-screen',
      '[data-tid="prejoin-join-button"]',
    ];

    const maxWait = 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      for (const selector of preJoinSelectors) {
        try {
          const element = await this.page.$(selector);
          if (element) {
            logger.info('Pre-join screen loaded');
            return;
          }
        } catch {
          // Continue
        }
      }

      await this.sleep(1000);
    }

    logger.warn('Pre-join screen not found within timeout');
  }

  /**
   * Enter the bot name
   */
  private async enterName(): Promise<void> {
    if (!this.page) return;

    const nameSelectors = [
      '[data-tid="prejoin-display-name-input"]',
      'input[placeholder*="Enter name" i]',
      'input[placeholder*="name" i]',
      'input[placeholder*="Entrez votre nom" i]',
      'input[aria-label*="name" i]',
      '#username',
      '#displayName',
      '.calling-prejoin-display-name-input',
    ];

    for (const selector of nameSelectors) {
      try {
        const nameInput = await this.page.$(selector);
        if (nameInput) {
          // Click the input field
          await nameInput.click();
          await this.sleep(200 + Math.random() * 100);

          // Clear existing text
          await nameInput.fill('');
          await this.sleep(100);

          // Type with human-like delays
          for (const char of this.config.botName) {
            await nameInput.type(char, { delay: 40 + Math.random() * 60 });
          }

          logger.info(`Entered name: ${this.config.botName}`);
          return;
        }
      } catch {
        // Try next selector
      }
    }

    logger.warn('Could not find name input field');
  }

  /**
   * Turn off camera
   */
  private async turnOffCamera(): Promise<void> {
    if (!this.page) return;

    const cameraSelectors = [
      // Pre-join camera toggle
      '[data-tid="toggle-video"]',
      '[data-tid="prejoin-camera-toggle"]',
      '[aria-label*="Turn camera off" i]',
      '[aria-label*="Désactiver la caméra" i]',
      '[aria-label*="Camera" i][aria-pressed="true"]',
      '[aria-label*="camera" i][aria-checked="true"]',
      'button[aria-label*="video" i]:not([aria-pressed="false"])',
      // In-meeting
      '[data-tid="toggle-camera"]',
      '.ts-calling-video-off:not(.active)',
    ];

    for (const selector of cameraSelectors) {
      try {
        const cameraBtn = await this.page.$(selector);
        if (cameraBtn) {
          // Check current state
          const ariaPressed = await cameraBtn.getAttribute('aria-pressed');
          const ariaChecked = await cameraBtn.getAttribute('aria-checked');
          const ariaLabel = await cameraBtn.getAttribute('aria-label');

          // If camera is already off, skip
          if (ariaPressed === 'false' || ariaChecked === 'false') {
            logger.info('Camera is already off');
            return;
          }
          if (ariaLabel?.toLowerCase().includes('turn camera on') ||
              ariaLabel?.toLowerCase().includes('activer la caméra')) {
            logger.info('Camera is already off');
            return;
          }

          await this.humanClick(selector);
          logger.info(`Turned off camera: ${selector}`);
          return;
        }
      } catch {
        // Try next selector
      }
    }

    logger.info('No camera button found (may already be off)');
  }

  /**
   * Turn off microphone
   */
  private async turnOffMicrophone(): Promise<void> {
    if (!this.page) return;

    const micSelectors = [
      // Pre-join mic toggle
      '[data-tid="toggle-mute"]',
      '[data-tid="prejoin-mic-toggle"]',
      '[aria-label*="Mute microphone" i]',
      '[aria-label*="Désactiver le micro" i]',
      '[aria-label*="Microphone" i][aria-pressed="true"]',
      '[aria-label*="microphone" i][aria-checked="true"]',
      'button[aria-label*="mute" i]:not([aria-pressed="false"]):not([aria-label*="unmute" i])',
      // In-meeting
      '[data-tid="toggle-microphone"]',
      '.ts-calling-audio-off:not(.active)',
    ];

    for (const selector of micSelectors) {
      try {
        const micBtn = await this.page.$(selector);
        if (micBtn) {
          // Check current state
          const ariaPressed = await micBtn.getAttribute('aria-pressed');
          const ariaChecked = await micBtn.getAttribute('aria-checked');
          const ariaLabel = await micBtn.getAttribute('aria-label');

          // If mic is already muted, skip
          if (ariaPressed === 'false' || ariaChecked === 'false') {
            logger.info('Microphone is already muted');
            return;
          }
          if (ariaLabel?.toLowerCase().includes('unmute') ||
              ariaLabel?.toLowerCase().includes('activer le micro')) {
            logger.info('Microphone is already muted');
            return;
          }

          await this.humanClick(selector);
          logger.info(`Muted microphone: ${selector}`);
          return;
        }
      } catch {
        // Try next selector
      }
    }

    logger.info('No microphone button found (may already be muted)');
  }

  /**
   * Click the Join button
   */
  private async clickJoinButton(): Promise<boolean> {
    if (!this.page) return false;

    const joinSelectors = [
      '[data-tid="prejoin-join-button"]',
      'button:has-text("Join now")',
      'button:has-text("Join")',
      'button:has-text("Rejoindre maintenant")',
      'button:has-text("Rejoindre")',
      '[aria-label*="Join now" i]',
      '[aria-label*="Join" i]',
      '#prejoin-join-button',
      '.calling-prejoin-join-button',
      'button[data-tid*="join" i]',
    ];

    for (const selector of joinSelectors) {
      try {
        const joinBtn = await this.page.$(selector);
        if (joinBtn) {
          // Make sure the button is enabled
          const disabled = await joinBtn.getAttribute('disabled');
          const ariaDisabled = await joinBtn.getAttribute('aria-disabled');

          if (disabled === 'true' || ariaDisabled === 'true') {
            logger.info(`Join button is disabled: ${selector}`);
            continue;
          }

          const clicked = await this.humanClick(selector);
          if (clicked) {
            logger.info(`Clicked Join button: ${selector}`);
            return true;
          }
        }
      } catch {
        // Try next selector
      }
    }

    return false;
  }

  /**
   * Wait for admission from lobby
   */
  private async waitForAdmission(): Promise<void> {
    if (!this.page) return;

    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check if denied
      const deniedIndicators = [
        'text=You were denied access',
        'text=cannot join',
        'text=removed from the meeting',
        'text=The meeting has ended',
        'text=Access denied',
        '[data-tid="lobby-denied"]',
      ];

      for (const indicator of deniedIndicators) {
        try {
          const denied = await this.page.$(indicator);
          if (denied) {
            throw new Error('Bot was denied entry to the meeting');
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('denied')) {
            throw e;
          }
        }
      }

      // Check if in meeting
      const inMeeting = await this.checkStillInMeeting();
      if (inMeeting) {
        logger.info('Successfully admitted to meeting');
        return;
      }

      // Check if in lobby
      const lobbyIndicators = [
        'text=Someone in the meeting should let you in soon',
        'text=Waiting for others to let you in',
        'text=waiting to be let in',
        'text=En attente',
        '[data-tid="lobby-screen"]',
        '.calling-lobby',
        '[data-tid="prejoin-waiting-room"]',
      ];

      let inLobby = false;
      for (const indicator of lobbyIndicators) {
        try {
          const lobby = await this.page.$(indicator);
          if (lobby) {
            inLobby = true;
            break;
          }
        } catch {
          // Ignore
        }
      }

      if (!inLobby) {
        return;
      }

      logger.info('Waiting to be admitted from lobby...');

      // Human-like behavior
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
   * Get participant count
   */
  private async getParticipantCount(): Promise<number> {
    if (!this.page) return 0;

    try {
      // Method 1: Check roster button
      const rosterSelectors = [
        '[data-tid="roster-button"]',
        '[aria-label*="participant" i]',
        '[aria-label*="people" i]',
        '[data-tid="people-button"]',
      ];

      for (const selector of rosterSelectors) {
        const btn = await this.page.$(selector);
        if (btn) {
          const text = await btn.textContent();
          const match = text?.match(/(\d+)/);
          if (match) {
            return parseInt(match[1], 10);
          }

          const label = await btn.getAttribute('aria-label');
          const labelMatch = label?.match(/(\d+)/);
          if (labelMatch) {
            return parseInt(labelMatch[1], 10);
          }
        }
      }

      // Method 2: Count video tiles
      const videoTiles = await this.page.$$('[data-tid="video-gallery"] > div, .calling-user-video-tile, [data-tid*="participant"]');
      if (videoTiles.length > 0) {
        return videoTiles.length;
      }

      // Method 3: Count roster items
      const rosterItems = await this.page.$$('[data-tid="roster-participant"], .calling-roster-item, [data-tid*="roster-item"]');
      if (rosterItems.length > 0) {
        return rosterItems.length;
      }

      return 1;
    } catch (error) {
      logger.warn(`Failed to get participant count: ${error}`);
      return 1;
    }
  }

  async checkMeetingEnded(): Promise<boolean> {
    if (!this.page) return true;

    if (!this.joinedSuccessfully) {
      return false;
    }

    // Check for meeting ended indicators
    const endedIndicators = [
      'text=The meeting has ended',
      'text=You left the meeting',
      'text=Call ended',
      'text=La réunion est terminée',
      '[data-tid="call-ended"]',
      '[data-tid="meeting-ended"]',
      '.call-ended-screen',
    ];

    for (const indicator of endedIndicators) {
      try {
        const element = await this.page.$(indicator);
        if (element) {
          logger.info(`Meeting ended: found indicator ${indicator}`);
          return true;
        }
      } catch {
        // Ignore
      }
    }

    // Check URL
    const url = this.page.url();
    if (!url.includes('teams.microsoft.com') && !url.includes('teams.live.com')) {
      logger.info(`Meeting ended: URL changed to ${url}`);
      return true;
    }

    // Only check participant count after 60 seconds
    const minTimeInMeeting = 60 * 1000;
    if (this.joinedAt) {
      const timeInMeeting = Date.now() - this.joinedAt.getTime();
      if (timeInMeeting < minTimeInMeeting) {
        logger.debug(`Skipping participant count check (only ${Math.floor(timeInMeeting / 1000)}s in meeting)`);
        return false;
      }
    }

    // Check participant count
    const participantCount = await this.getParticipantCount();

    if (participantCount > this.lastKnownParticipantCount) {
      this.lastKnownParticipantCount = participantCount;
      logger.info(`Participant count updated: ${participantCount}`);
    }

    // Only leave if others have left
    if (participantCount <= 1 && this.lastKnownParticipantCount > 1) {
      logger.info(`Meeting ended: Bot is the only participant left (count: ${participantCount}, peak: ${this.lastKnownParticipantCount})`);
      await this.leave();
      return true;
    }

    return false;
  }

  async checkStillInMeeting(): Promise<boolean> {
    if (!this.page) return false;

    // Check for meeting indicators
    const meetingIndicators = [
      '[data-tid="calling-unified-bar"]',
      '[data-tid="roster-button"]',
      '.ts-calling-screen',
      '[data-tid="video-gallery"]',
      '[data-tid="hangup-button"]',
      '.calling-screen',
      '.calling-container',
      '[data-tid="call-controls"]',
      '[data-tid="participant-gallery"]',
      '[data-tid="calling-audio-btn"]',
      // Video indicators
      '[data-tid="calling-user-video-tile"]',
      '[data-tid="self-video"]',
    ];

    for (const indicator of meetingIndicators) {
      try {
        const element = await this.page.$(indicator);
        if (element) {
          return true;
        }
      } catch {
        // Continue
      }
    }

    // Check URL
    const url = this.page.url();
    const inTeamsMeeting = (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) &&
                           (url.includes('meetup-join') || url.includes('/meeting/') || url.includes('/l/meetup-join'));

    if (this.joinedSuccessfully && inTeamsMeeting) {
      return true;
    }

    return false;
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    logger.info('Leaving Teams meeting');

    // Click hangup/leave button
    const leaveSelectors = [
      '[data-tid="hangup-button"]',
      '[aria-label*="Leave" i]',
      '[aria-label*="Hang up" i]',
      '[aria-label*="Quitter" i]',
      'button:has-text("Leave")',
      'button:has-text("Hang up")',
      '.ts-calling-hangup',
      '[data-tid="leave-call-button"]',
    ];

    for (const selector of leaveSelectors) {
      try {
        const leaveBtn = await this.page.$(selector);
        if (leaveBtn) {
          await this.humanClick(selector);
          logger.info(`Clicked leave button: ${selector}`);
          await this.sleep(1000);

          // Confirm leave if dialog appears
          const confirmSelectors = [
            'button:has-text("Leave")',
            'button:has-text("Quitter")',
            '[data-tid="confirm-leave"]',
          ];

          for (const confirmSelector of confirmSelectors) {
            const confirmBtn = await this.page.$(confirmSelector);
            if (confirmBtn) {
              await this.humanClick(confirmSelector);
              logger.info('Confirmed leaving Teams meeting');
              return;
            }
          }
          return;
        }
      } catch {
        // Continue
      }
    }

    logger.warn('Could not find leave button');
  }
}
