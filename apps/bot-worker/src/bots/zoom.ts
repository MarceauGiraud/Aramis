import { BaseMeetingBot, BotConfig, BotOptions } from './base';
import { logger } from '../lib/logger';

/**
 * Zoom Meeting Bot
 *
 * Joins Zoom meetings via web client and records audio/video
 * Uses the Zoom Web Client (app.zoom.us/wc) for browser-based joining
 */
export class ZoomBot extends BaseMeetingBot {
  private joinedSuccessfully = false;
  private joinedAt: Date | null = null;
  private lastKnownParticipantCount = 0;

  constructor(config: BotConfig, options?: BotOptions) {
    super({ ...config, platform: config.platform ?? 'ZOOM' }, options);
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

    // Wait for page to load with random delay (human-like)
    await this.sleep(2000 + Math.random() * 2000);
    await this.takeDebugScreenshot('01_page_loaded');

    // Handle "Join from Your Browser" flow
    await this.handleBrowserJoin();
    await this.takeDebugScreenshot('02_after_browser_join');

    // Wait for pre-join screen to load
    await this.sleep(2000 + Math.random() * 1000);

    // Enter name if required
    await this.enterName();
    await this.takeDebugScreenshot('03_name_entered');

    // Handle passcode if required
    await this.enterPasscode();

    // Turn off camera and microphone before joining
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

    // Handle audio join prompt
    await this.handleAudioPrompt();

    // Wait for admission if in waiting room
    await this.waitForAdmission();
    await this.takeDebugScreenshot('06_after_admission');

    // Verify we're in the meeting
    const inMeeting = await this.checkStillInMeeting();
    if (!inMeeting) {
      await this.takeDebugScreenshot('07_join_failed');
      throw new Error('Failed to join Zoom meeting');
    }

    this.joinedSuccessfully = true;
    this.joinedAt = new Date();
    logger.info('Successfully joined Zoom meeting');
    await this.takeDebugScreenshot('07_joined_successfully');

    // Start recording
    await this.startRecording();
  }

  /**
   * Handle the "Join from Your Browser" flow
   */
  private async handleBrowserJoin(): Promise<void> {
    if (!this.page) return;

    // Multiple ways Zoom presents the browser join option
    const browserJoinSelectors = [
      'text=Join from Your Browser',
      'text=Join from your browser',
      'text=join from your browser',
      'a:has-text("Join from Your Browser")',
      '#joinFromBrowser',
      '[data-reactid*="joinFromBrowser"]',
    ];

    for (const selector of browserJoinSelectors) {
      try {
        const element = await this.page.$(selector);
        if (element) {
          await this.humanClick(selector);
          logger.info(`Clicked browser join: ${selector}`);
          await this.sleep(2000 + Math.random() * 1000);
          return;
        }
      } catch {
        // Try next selector
      }
    }

    // Alternative: Look for "Launch Meeting" and wait for browser link
    const launchSelectors = [
      'text=Launch Meeting',
      'text=Open Zoom',
      '#launch-btn',
      '[data-launch]',
    ];

    for (const selector of launchSelectors) {
      try {
        const element = await this.page.$(selector);
        if (element) {
          // Wait for the browser join link to appear
          await this.sleep(2000);

          for (const browserSelector of browserJoinSelectors) {
            const browserElement = await this.page.$(browserSelector);
            if (browserElement) {
              await this.humanClick(browserSelector);
              logger.info(`Clicked browser join after launch: ${browserSelector}`);
              await this.sleep(2000 + Math.random() * 1000);
              return;
            }
          }
        }
      } catch {
        // Continue
      }
    }

    logger.info('No browser join button found (may already be in web client)');
  }

  /**
   * Enter the bot name
   */
  private async enterName(): Promise<void> {
    if (!this.page) return;

    const nameSelectors = [
      '#inputname',
      'input[placeholder*="name" i]',
      'input[placeholder*="Name" i]',
      'input[aria-label*="name" i]',
      '#displayName',
      'input[name="name"]',
      '.preview-name-input input',
    ];

    for (const selector of nameSelectors) {
      try {
        const nameInput = await this.page.$(selector);
        if (nameInput) {
          // Click the input field first
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
   * Enter passcode if required
   */
  private async enterPasscode(): Promise<void> {
    if (!this.page) return;

    const passcodeSelectors = [
      '#inputpasscode',
      'input[placeholder*="passcode" i]',
      'input[placeholder*="password" i]',
      'input[aria-label*="passcode" i]',
      'input[aria-label*="password" i]',
      '#meeting-passcode',
      'input[name="passcode"]',
    ];

    for (const selector of passcodeSelectors) {
      try {
        const passcodeInput = await this.page.$(selector);
        if (passcodeInput) {
          // Check if passcode is in the URL
          const url = this.page.url();
          const passcodeMatch = url.match(/[?&]pwd=([^&]+)/);

          if (passcodeMatch) {
            const passcode = decodeURIComponent(passcodeMatch[1]);
            await passcodeInput.fill(passcode);
            logger.info('Entered passcode from URL');
          } else {
            logger.warn('Meeting requires passcode but none provided');
          }
          return;
        }
      } catch {
        // Continue
      }
    }
  }

  /**
   * Turn off camera
   */
  private async turnOffCamera(): Promise<void> {
    if (!this.page) return;

    const cameraSelectors = [
      // Pre-join camera toggle
      '[aria-label*="Stop Video" i]',
      '[aria-label*="stop video" i]',
      '[aria-label*="Turn off video" i]',
      '[aria-label*="Désactiver la vidéo" i]',
      'button:has-text("Stop Video")',
      '#preview-video-control-button',
      '.video-preview-toggle:not(.disabled)',
      '[data-tooltip*="video" i]:not([aria-checked="false"])',
      // In-meeting camera toggle
      '.send-video-container button:not(.stop-video)',
      '[aria-label*="Stop my video" i]',
    ];

    for (const selector of cameraSelectors) {
      try {
        const cameraBtn = await this.page.$(selector);
        if (cameraBtn) {
          // Check if camera is currently on (need to turn it off)
          const ariaLabel = await cameraBtn.getAttribute('aria-label');
          const ariaPressed = await cameraBtn.getAttribute('aria-pressed');

          // If aria-label contains "start" or aria-pressed is "false", camera is already off
          if (ariaLabel?.toLowerCase().includes('start') || ariaPressed === 'false') {
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
      '[aria-label*="Mute" i]:not([aria-label*="Unmute" i])',
      '[aria-label*="mute" i]:not([aria-label*="unmute" i])',
      '[aria-label*="Désactiver le micro" i]',
      'button:has-text("Mute")',
      '#preview-audio-control-button',
      '.audio-preview-toggle:not(.muted)',
      // In-meeting mic toggle
      '.join-audio-container button:not(.muted)',
      '[aria-label*="Mute my microphone" i]',
    ];

    for (const selector of micSelectors) {
      try {
        const micBtn = await this.page.$(selector);
        if (micBtn) {
          // Check if mic is currently on
          const ariaLabel = await micBtn.getAttribute('aria-label');
          const ariaPressed = await micBtn.getAttribute('aria-pressed');

          if (ariaLabel?.toLowerCase().includes('unmute') || ariaPressed === 'false') {
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
      'button:has-text("Join")',
      '#joinBtn',
      '.join-btn',
      '[aria-label*="Join" i]',
      'button[type="submit"]',
      '#join-btn',
      '.join-meeting-btn',
      'button:has-text("Participer")',
      '.preview-join-button button',
    ];

    for (const selector of joinSelectors) {
      try {
        const joinBtn = await this.page.$(selector);
        if (joinBtn) {
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
   * Handle audio join prompt
   */
  private async handleAudioPrompt(): Promise<void> {
    if (!this.page) return;

    // Join with computer audio
    const audioSelectors = [
      'button:has-text("Join Audio by Computer")',
      'button:has-text("Join with Computer Audio")',
      'button:has-text("Join Audio")',
      '#joinWithComputerAudio',
      '.join-audio-by-voip',
      '[aria-label*="Join Audio" i]',
      'button:has-text("Rejoindre audio")',
    ];

    for (const selector of audioSelectors) {
      try {
        const audioBtn = await this.page.$(selector);
        if (audioBtn) {
          await this.humanClick(selector);
          logger.info(`Joined audio: ${selector}`);
          await this.sleep(1000);
          return;
        }
      } catch {
        // Continue
      }
    }

    logger.info('No audio prompt found');
  }

  /**
   * Wait for admission from waiting room
   */
  private async waitForAdmission(): Promise<void> {
    if (!this.page) return;

    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check if denied
      const deniedIndicators = [
        'text=The host has denied your request',
        'text=You cannot join this meeting',
        'text=removed from this meeting',
        'text=denied',
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

      // Check if in waiting room
      const waitingIndicators = [
        'text=Please wait, the meeting host will let you in soon',
        'text=Waiting for the host',
        'text=waiting room',
        '.waiting-room',
        '#waiting-room',
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
        return;
      }

      logger.info('Waiting to be admitted from waiting room...');

      // Human-like behavior while waiting
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
      // Method 1: Check participant panel button
      const participantBtnSelectors = [
        '[aria-label*="participant" i]',
        '[aria-label*="Participants" i]',
        '.participants-header',
        '#participants-count',
        '.footer-participants',
      ];

      for (const selector of participantBtnSelectors) {
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
      const videoTiles = await this.page.$$('.video-avatar, [data-user-id], .participants-item, .video-tile');
      if (videoTiles.length > 0) {
        return videoTiles.length;
      }

      // Method 3: Count in participants list
      const participantItems = await this.page.$$('.participants-ul li, .participants-list-item');
      if (participantItems.length > 0) {
        return participantItems.length;
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
      'text=This meeting has been ended',
      'text=The host has ended the meeting',
      'text=Meeting Ended',
      'text=You have been removed from the meeting',
      'text=The meeting has ended',
      '.meeting-ended',
      '#meeting-ended',
      '[data-meeting-ended="true"]',
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
    if (url.includes('zoom.us') && (url.includes('/postattendee') || url.includes('/leaveurl'))) {
      logger.info(`Meeting ended: URL indicates meeting over`);
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
      '#wc-container-left',
      '.meeting-client',
      '.participants-ul',
      '[class*="meeting"]',
      '.video-avatar',
      '#active-speaker-view',
      '.gallery-view',
      '.meeting-app',
      '.react-draggable',
      '#wc-content',
      '.meeting-info-container',
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
    const inZoomMeeting = url.includes('zoom.us/wc') ||
                          url.includes('zoom.us/j') ||
                          url.includes('zoom.us/s');

    if (this.joinedSuccessfully && inZoomMeeting) {
      return true;
    }

    return false;
  }

  /**
   * Check for breakout room invitation and auto-join
   */
  async checkForBreakoutRoom(): Promise<boolean> {
    if (!this.page) return false;

    try {
      // Zoom shows a dialog/banner when invited to a breakout room
      const breakoutSelectors = [
        'text=Join Breakout Room',
        'text=Breakout Rooms',
        'text=The host is inviting you to join Breakout Room',
        '[aria-label*="Breakout Room" i]',
        '.bo-room-invitation',
        '#bo-invite-dialog',
        '[data-tid="bo-invitation"]',
      ];

      for (const selector of breakoutSelectors) {
        const el = await this.page.$(selector);
        if (el) {
          logger.info('Breakout room invitation detected');

          // Pause recording during transition
          if (this.recordingOrchestrator?.isRecording()) {
            this.pauseRecording();
          }

          // Click join button
          const joinSelectors = [
            'button:has-text("Join")',
            'button:has-text("Join Breakout Room")',
            '.bo-room-invitation button',
          ];

          for (const joinSelector of joinSelectors) {
            const joinBtn = await this.page.$(joinSelector);
            if (joinBtn) {
              await this.humanClick(joinSelector);
              logger.info('Joined breakout room');

              // Wait for transition
              await this.sleep(3000);

              // Resume recording
              if (this.recordingOrchestrator?.isPaused()) {
                this.resumeRecording();
              }

              return true;
            }
          }
        }
      }
    } catch (error) {
      logger.debug(`Breakout room check error: ${error}`);
    }

    return false;
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    logger.info('Leaving Zoom meeting');

    // Click leave button
    const leaveSelectors = [
      '[aria-label*="Leave" i]',
      'button:has-text("Leave")',
      '.leave-btn',
      '#leaveBtn',
      '[aria-label*="Hang up" i]',
      '.footer-leave',
    ];

    for (const selector of leaveSelectors) {
      try {
        const leaveBtn = await this.page.$(selector);
        if (leaveBtn) {
          await this.humanClick(selector);
          await this.sleep(1000);

          // Confirm leave
          const confirmSelectors = [
            'button:has-text("Leave Meeting")',
            'button:has-text("Leave")',
            '.leave-meeting-btn',
            '#confirmLeave',
          ];

          for (const confirmSelector of confirmSelectors) {
            const confirmBtn = await this.page.$(confirmSelector);
            if (confirmBtn) {
              await this.humanClick(confirmSelector);
              logger.info('Confirmed leaving Zoom meeting');
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
