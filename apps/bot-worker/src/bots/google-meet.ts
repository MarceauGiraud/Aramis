import { BaseMeetingBot, BotConfig, BotOptions, ActiveSpeaker, ParticipantInfo } from './base';
import { logger } from '../lib/logger';
import { BOT_CONFIG } from '@aramis/shared';

// -- Page state detection --------------------------------------------------

type PageState =
  | 'PRE_JOIN'
  | 'IN_MEETING'
  | 'WAITING_ROOM'
  | 'LOGIN_REQUIRED'
  | 'ACCESS_DENIED'
  | 'ERROR_PAGE'
  | 'UNKNOWN';

// -- Error classification --------------------------------------------------

class JoinError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'JoinError';
  }
}

// -- Selector lists --------------------------------------------------------

const POPUP_SELECTORS = [
  'text=Got it',
  'text=OK',
  'text=Compris',
  '[aria-label="Dismiss"]',
  '[aria-label="Close"]',
  '[aria-label="Fermer"]',
  'button:has-text("Dismiss")',
  'button:has-text("Close")',
  'text=Allow',
  'text=Autoriser',
  'button:has-text("Allow")',
  'button:has-text("Block")',
];

const CAMERA_PROMPT_SELECTORS = [
  'text=Use your camera',
  'text=Utiliser votre caméra',
];

const NAME_INPUT_SELECTORS = [
  'input[placeholder="Your name"]',
  'input[aria-label="Your name"]',
  'input[placeholder="Votre nom"]',
  'input[aria-label="Votre nom"]',
  'input[data-placeholder="Your name"]',
];

const CAMERA_OFF_SELECTORS = [
  '[aria-label*="Turn off camera" i]',
  '[aria-label*="Désactiver la caméra" i]',
  '[aria-label*="camera" i][data-is-muted="false"]',
  '[data-is-muted="false"][aria-label*="video" i]',
  'button[aria-label*="camera" i]',
  '[role="button"][aria-label*="camera" i]',
  '[jsname="BOHaEe"]', // fallback — unstable
];

const MIC_OFF_SELECTORS = [
  '[aria-label*="Turn off microphone" i]',
  '[aria-label*="Désactiver le micro" i]',
  '[aria-label*="microphone" i][data-is-muted="false"]',
  '[data-is-muted="false"][aria-label*="mic" i]',
  'button[aria-label*="microphone" i]',
  '[role="button"][aria-label*="microphone" i]',
  '[jsname="Dg9Wp"]', // fallback — unstable
];

const JOIN_BUTTON_SELECTORS = [
  'button:has-text("Ask to join")',
  'button:has-text("Join now")',
  'button:has-text("Participer")',
  'button:has-text("Demander à rejoindre")',
  '[data-idom-class*="join"]',
  'button[data-mdc-dialog-action="join"]',
  '[jsname="Qx7uuf"]', // fallback — unstable
];

const ACCESS_DENIED_INDICATORS = [
  "text=You can't join this video call",
  'text=You cannot join this meeting',
  'text=Vous ne pouvez pas rejoindre cet appel vidéo',
  'text=This meeting is restricted',
  'text=The meeting has not started yet',
];

// Only match login pages, NOT the "Sign in" link in the top-right corner
const LOGIN_PAGE_INDICATORS = [
  'input[type="email"][name="identifier"]', // Google sign-in form
  'text=Sign in to Google',
  'text=Connectez-vous à Google',
];

const WAITING_ROOM_INDICATORS = [
  'text=Waiting for someone to let you in',
  'text=Asking to be let in',
  'text=Please wait until a meeting host brings you into the call',
  'text=Please wait until a meeting host',
  'text=En attente',
  'text=Demande en cours',
  'text=Veuillez patienter',
];

const MEETING_INDICATORS = [
  '[data-meeting-title]',
  '[data-self-name]',
  '[jscontroller="kAPMuc"]',
  '[data-participant-id]',
  '[aria-label*="Leave call"]',
  '[aria-label*="leave" i]',
  '[data-call-active="true"]',
  '[data-allocation-index]',
  '[data-requested-participant-id]',
];

const MEETING_TEXT_INDICATORS = [
  'text=Present now',
  'text=Meeting details',
  'text=Everyone will see',
];

const POST_MEETING_INDICATORS = [
  'text=You left the meeting',
  'text=The call has ended',
  'text=Return to home screen',
  'text=Rejoin',
  'text=Vous avez quitté',
];

const ENDED_INDICATORS = [
  'text=You left the meeting',
  'text=The call has ended',
  "text=You've been removed from the meeting",
  'text=This meeting has ended',
  '[data-call-ended="true"]',
];

const KICKED_INDICATORS = [
  "text=You can't join this video call",
  'text=Vous ne pouvez pas rejoindre cet appel vidéo',
  "text=You've been removed from the meeting",
  'text=Vous avez été retiré de la réunion',
];

// -- Pre-join page selector (union for waitForSelector) --------------------

const PRE_JOIN_OR_ERROR_SELECTOR = [
  ...NAME_INPUT_SELECTORS,
  ...JOIN_BUTTON_SELECTORS.slice(0, 4), // text-based ones only
  ...LOGIN_PAGE_INDICATORS,
  "text=can't join",
].join(', ');

// --------------------------------------------------------------------------

/**
 * Google Meet Bot
 *
 * Joins Google Meet meetings via web client and records audio/video.
 * Uses a state-machine approach with per-step retry and full-flow retry
 * for maximum robustness against UI changes and transient failures.
 */
export class GoogleMeetBot extends BaseMeetingBot {
  private joinedSuccessfully = false;
  private joinedAt: Date | null = null;
  private lastKnownParticipantCount = 0;

  constructor(config: BotConfig, options: BotOptions = {}) {
    super(config, options);
  }

  // ========================================================================
  // JOIN (with retry loop)
  // ========================================================================

  async join(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const maxAttempts = BOT_CONFIG.JOIN_MAX_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.attemptJoin(attempt);
        return; // success
      } catch (error) {
        // Non-retryable errors bubble up immediately
        if (error instanceof JoinError && !error.retryable) {
          throw error;
        }
        // Last attempt — give up
        if (attempt === maxAttempts) {
          throw error;
        }

        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Join attempt ${attempt}/${maxAttempts} failed: ${msg}. Retrying...`);
        await this.takeDebugScreenshot(`join_retry_${attempt}`);

        // Reset page for a fresh attempt
        if (this.page) {
          try {
            await this.page.goto('about:blank');
          } catch {
            // page may be crashed
          }
          await this.sleep(1000 + Math.random() * 1000);
        }
      }
    }
  }

  // ========================================================================
  // ATTEMPT JOIN (single attempt — the core flow)
  // ========================================================================

  private async attemptJoin(attempt: number): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    logger.info(`Joining Google Meet (attempt ${attempt}): ${this.config.meetingUrl}`);

    // Step 1: Navigate (domcontentloaded, not networkidle)
    await this.page.goto(this.config.meetingUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for a meaningful element to appear (pre-join screen or error)
    try {
      await this.page.waitForSelector(PRE_JOIN_OR_ERROR_SELECTOR, { timeout: 30000 });
    } catch {
      // Timeout is acceptable — we'll detect state next
    }

    await this.sleep(1500 + Math.random() * 1500);
    await this.takeDebugScreenshot('01_page_loaded');

    // Step 2: Detect page state and route
    const initialState = await this.detectPageState();
    logger.info(`Page state after navigation: ${initialState}`);

    switch (initialState) {
      case 'ACCESS_DENIED':
        throw new JoinError('Google Meet: Access denied — cannot join this meeting', false);
      case 'LOGIN_REQUIRED':
        throw new JoinError('Google Meet: Sign-in required for this meeting', false);
      case 'ERROR_PAGE':
        throw new JoinError('Google Meet: Error page — meeting may not exist', true);
      case 'IN_MEETING':
        // Rare but possible (e.g. rejoining)
        logger.info('Already in meeting — skipping join steps');
        this.joinedSuccessfully = true;
        this.joinedAt = new Date();
        await this.startRecording();
        return;
      case 'UNKNOWN':
        // Give it one more second, then re-check
        await this.sleep(2000);
        const recheck = await this.detectPageState();
        if (recheck === 'ACCESS_DENIED') throw new JoinError('Access denied', false);
        if (recheck === 'LOGIN_REQUIRED') throw new JoinError('Sign-in required', false);
        if (recheck !== 'PRE_JOIN' && recheck !== 'WAITING_ROOM') {
          throw new JoinError(`Unexpected page state: ${recheck}`, true);
        }
        break;
      // PRE_JOIN, WAITING_ROOM: continue below
    }

    // Step 3: Dismiss popups (adaptive loop)
    await this.handlePopups();
    await this.takeDebugScreenshot('02_after_popups');

    // Step 4: Turn off camera and microphone (with retry)
    await this.turnOffCamera();
    await this.sleep(300 + Math.random() * 200);
    await this.turnOffMicrophone();
    await this.sleep(300 + Math.random() * 200);
    await this.takeDebugScreenshot('02b_media_off');

    // Step 5: Enter bot name (with retry)
    await this.enterName();

    // Double-check media is off after name entry (Meet sometimes re-enables)
    await this.sleep(500);
    await this.turnOffCamera();
    await this.turnOffMicrophone();
    await this.takeDebugScreenshot('04_before_join');

    // Step 6: Click join button (with waitForSelector + retry)
    const joinClicked = await this.clickJoinButton();
    if (!joinClicked) {
      await this.takeDebugScreenshot('05_no_join_button');
      // Re-detect state to provide a meaningful error
      const state = await this.detectPageState();
      if (state === 'ACCESS_DENIED') throw new JoinError('Access denied', false);
      if (state === 'LOGIN_REQUIRED') throw new JoinError('Sign-in required', false);
      throw new JoinError('Could not find join button', true);
    }

    // Step 7: Wait for state transition (IN_MEETING or WAITING_ROOM)
    await this.waitForStateTransition();

    // Step 8: Wait for admission if in waiting room
    const postClickState = await this.detectPageState();
    if (postClickState === 'WAITING_ROOM') {
      await this.waitForAdmission();
    }
    await this.takeDebugScreenshot('06_after_admission');

    // Step 9: Final verification
    const finalState = await this.detectPageState();
    if (finalState !== 'IN_MEETING') {
      // One last check with the detailed method
      const inMeeting = await this.checkStillInMeeting();
      if (!inMeeting) {
        await this.takeDebugScreenshot('07_join_failed');
        throw new JoinError(`Failed to join — final state: ${finalState}`, true);
      }
    }

    this.joinedSuccessfully = true;
    this.joinedAt = new Date();
    logger.info('Successfully joined Google Meet');
    await this.takeDebugScreenshot('07_joined_successfully');

    // Wait for WebRTC to fully connect and remote tracks to arrive
    // before starting recording — avoids capturing lobby/transition frames
    await this.waitForWebRTCReady();

    await this.startRecording();
  }

  // ========================================================================
  // PAGE STATE DETECTION
  // ========================================================================

  private async detectPageState(): Promise<PageState> {
    if (!this.page) return 'UNKNOWN';

    const url = this.page.url();

    // Priority 1: Pre-join screen (name input or join button visible)
    // Check this FIRST because the pre-join page also contains "Sign in" link
    // in the top-right corner, which would false-positive as LOGIN_REQUIRED.
    if (await this.hasAnySelector(NAME_INPUT_SELECTORS) || await this.hasAnySelector(JOIN_BUTTON_SELECTORS)) {
      return 'PRE_JOIN';
    }

    // Priority 2: Waiting room — check BEFORE IN_MEETING because the waiting
    // room has a toolbar with leave/mute buttons that match MEETING_INDICATORS.
    if (await this.hasAnySelector(WAITING_ROOM_INDICATORS)) {
      return 'WAITING_ROOM';
    }

    // Priority 3: In meeting (only if NOT in waiting room or post-meeting)
    if (await this.hasAnySelector(MEETING_INDICATORS) || await this.hasAnySelector(MEETING_TEXT_INDICATORS)) {
      if (!(await this.hasAnySelector(POST_MEETING_INDICATORS))) {
        return 'IN_MEETING';
      }
    }

    // Priority 4: Access denied (specific, full-sentence indicators only)
    if (await this.hasAnySelector(ACCESS_DENIED_INDICATORS)) {
      return 'ACCESS_DENIED';
    }

    // Priority 5: Login required (actual sign-in page, not just a link)
    if (url.includes('accounts.google.com')) {
      return 'LOGIN_REQUIRED';
    }
    if (await this.hasAnySelector(LOGIN_PAGE_INDICATORS)) {
      return 'LOGIN_REQUIRED';
    }

    // Priority 6: Error page
    if (await this.hasAnySelector(['text=not found', 'text=invalid link', 'text=Check your meeting code'])) {
      return 'ERROR_PAGE';
    }

    // URL-based fallback
    if (!url.includes('meet.google.com/') || url.includes('meet.google.com/?')) {
      return 'ERROR_PAGE';
    }

    return 'UNKNOWN';
  }

  private async hasAnySelector(selectors: readonly string[]): Promise<boolean> {
    if (!this.page) return false;
    for (const selector of selectors) {
      try {
        const el = await this.page.$(selector);
        if (el) return true;
      } catch {
        // continue
      }
    }
    return false;
  }

  // ========================================================================
  // POPUP HANDLING (adaptive loop)
  // ========================================================================

  private async handlePopups(): Promise<void> {
    if (!this.page) return;

    const stableThreshold = BOT_CONFIG.POPUP_STABLE_MS;
    let lastDismissedAt = Date.now();

    while (Date.now() - lastDismissedAt < stableThreshold) {
      let dismissed = false;

      // Try dismissing popups
      for (const selector of POPUP_SELECTORS) {
        try {
          const el = await this.page.$(selector);
          if (el) {
            await this.page.click(selector, { timeout: 2000 });
            logger.info(`Dismissed popup: ${selector}`);
            await this.sleep(300 + Math.random() * 200);
            dismissed = true;
            lastDismissedAt = Date.now();
          }
        } catch {
          // continue
        }
      }

      // Handle camera/mic permission prompts with Escape
      for (const selector of CAMERA_PROMPT_SELECTORS) {
        try {
          const el = await this.page.$(selector);
          if (el) {
            await this.page.keyboard.press('Escape');
            logger.info(`Escaped prompt: ${selector}`);
            await this.sleep(500);
            dismissed = true;
            lastDismissedAt = Date.now();
          }
        } catch {
          // continue
        }
      }

      if (!dismissed) {
        await this.sleep(500);
      }
    }
  }

  // ========================================================================
  // MEDIA CONTROLS (with clickWithRetry)
  // ========================================================================

  private async turnOffCamera(): Promise<void> {
    if (!this.page) return;

    for (const selector of CAMERA_OFF_SELECTORS) {
      try {
        // Check existence first to avoid 30s Playwright click timeout
        const el = await this.page.$(selector);
        if (!el) continue;
        await this.humanClick(selector);
        logger.info(`Turned off camera: ${selector}`);
        return;
      } catch {
        // try next selector
      }
    }

    logger.info('No camera button found (may already be off)');
  }

  private async turnOffMicrophone(): Promise<void> {
    if (!this.page) return;

    for (const selector of MIC_OFF_SELECTORS) {
      try {
        const el = await this.page.$(selector);
        if (!el) continue;
        await this.humanClick(selector);
        logger.info(`Turned off microphone: ${selector}`);
        return;
      } catch {
        // try next selector
      }
    }

    logger.info('No microphone button found (may already be off)');
  }

  // ========================================================================
  // NAME ENTRY (with retry)
  // ========================================================================

  private async enterName(): Promise<void> {
    if (!this.page) return;

    const maxRetries = BOT_CONFIG.JOIN_STEP_RETRIES;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      for (const selector of NAME_INPUT_SELECTORS) {
        try {
          const nameInput = await this.page.$(selector);
          if (nameInput) {
            await nameInput.click();
            await this.sleep(200 + Math.random() * 100);

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
          logger.warn(`Failed to enter name with selector ${selector}: ${e}`);
        }
      }

      // No selector matched — wait and retry
      if (attempt < maxRetries - 1) {
        logger.info(`Name input not found, retrying (${attempt + 1}/${maxRetries})...`);
        await this.sleep(1000);
      }
    }

    logger.warn('Could not find name input field (may not be required for this meeting)');
  }

  // ========================================================================
  // JOIN BUTTON (waitForSelector + clickWithRetry)
  // ========================================================================

  private async clickJoinButton(): Promise<boolean> {
    if (!this.page) return false;

    // Wait for any join button to render
    const combinedSelector = JOIN_BUTTON_SELECTORS.join(', ');
    try {
      await this.page.waitForSelector(combinedSelector, { timeout: 10000 });
    } catch {
      logger.warn('No join button appeared within 10s');
      return false;
    }

    for (const selector of JOIN_BUTTON_SELECTORS) {
      const clicked = await this.clickWithRetry(selector, {
        retries: 2,
        humanLike: true,
      });
      if (clicked) {
        logger.info(`Clicked join button: ${selector}`);
        await this.takeDebugScreenshot('05_join_clicked');
        return true;
      }
    }

    return false;
  }

  // ========================================================================
  // POST-JOIN STATE TRANSITION
  // ========================================================================

  private async waitForStateTransition(): Promise<void> {
    if (!this.page) return;

    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      // Primary: WebRTC connected = truly in meeting
      const rtcState = await this.getWebRTCState();
      if (rtcState.hasConnected && rtcState.remoteTrackCount > 0) {
        logger.info(`In meeting via WebRTC (${rtcState.remoteTrackCount} remote tracks)`);
        return;
      }

      // Secondary: DOM-based state
      const state = await this.detectPageState();
      if (state === 'IN_MEETING' || state === 'WAITING_ROOM') {
        return;
      }
      if (state === 'ACCESS_DENIED') {
        throw new JoinError('Access denied after clicking join', false);
      }
      await this.sleep(1000);
    }

    // Timeout is okay — we'll verify in the next steps
    logger.info('State transition timeout — will verify in next step');
  }

  // ========================================================================
  // ADMISSION WAITING
  // ========================================================================

  private async waitForAdmission(): Promise<void> {
    if (!this.page) return;

    const maxWaitTime = BOT_CONFIG.ADMISSION_TIMEOUT_MS;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Primary: WebRTC tracks arriving = admitted to meeting
      const rtcState = await this.getWebRTCState();
      if (rtcState.hasConnected && rtcState.remoteTrackCount > 0) {
        logger.info(`Admitted via WebRTC signal (${rtcState.remoteTrackCount} remote tracks)`);
        return;
      }

      // Secondary: DOM-based state
      const state = await this.detectPageState();

      switch (state) {
        case 'ACCESS_DENIED':
          throw new JoinError('Bot was denied entry to the meeting', false);
        case 'IN_MEETING':
          logger.info('Successfully admitted to meeting (DOM)');
          return;
        case 'WAITING_ROOM':
          // Still waiting — continue
          break;
        default:
          // No longer waiting and not in meeting — check if something changed
          if (state !== 'UNKNOWN') {
            logger.info(`Admission wait ended with state: ${state}`);
            return;
          }
          break;
      }

      logger.info('Waiting to be admitted to the meeting...');

      // Simulate human-like behavior while waiting
      if (Math.random() > 0.7) {
        const viewport = this.page.viewportSize() || { width: 1920, height: 1080 };
        await this.page.mouse.move(
          viewport.width / 2 + (Math.random() - 0.5) * 100,
          viewport.height / 2 + (Math.random() - 0.5) * 100,
        );
      }

      await this.sleep(3000 + Math.random() * 2000);
    }

    throw new JoinError('Timed out waiting to be admitted', true);
  }

  // ========================================================================
  // MEETING STATUS (checkStillInMeeting, checkMeetingEnded, leave)
  // ========================================================================

  async checkStillInMeeting(): Promise<boolean> {
    if (!this.page) return false;

    // Primary signal: WebRTC connection state (most reliable)
    const rtcState = await this.getWebRTCState();
    if (rtcState.hasConnected && !rtcState.allDisconnected) {
      return true; // WebRTC connections still active = in meeting
    }
    if (rtcState.hasConnected && rtcState.allDisconnected) {
      logger.info('Not in meeting: all WebRTC connections disconnected');
      return false;
    }

    // Fallback: DOM-based detection (for edge cases)
    if (await this.hasAnySelector(POST_MEETING_INDICATORS)) {
      logger.info('Not in meeting: post-meeting screen detected');
      return false;
    }

    const url = this.page.url();
    if (!url.includes('meet.google.com/') || url.includes('meet.google.com/?')) {
      logger.info(`Not in meeting: redirected to ${url}`);
      return false;
    }

    if (await this.hasAnySelector(MEETING_INDICATORS) || await this.hasAnySelector(MEETING_TEXT_INDICATORS)) {
      return true;
    }

    // If we joined before, give benefit of the doubt (UI may be loading)
    if (this.joinedSuccessfully) {
      return true;
    }

    logger.info(`Not in meeting: no indicators found, url=${url}`);
    return false;
  }

  async checkMeetingEnded(): Promise<boolean> {
    if (!this.page) return true;

    if (!this.joinedSuccessfully) {
      return false;
    }

    // Primary signal: WebRTC all disconnected (most reliable)
    const rtcState = await this.getWebRTCState();
    if (rtcState.hasConnected && rtcState.allDisconnected) {
      logger.info('Meeting ended: all WebRTC connections disconnected');
      return true;
    }

    // Secondary: explicit DOM indicators
    if (await this.hasAnySelector(ENDED_INDICATORS)) {
      logger.info('Meeting ended: explicit indicator found');
      return true;
    }

    // Kicked indicators
    if (await this.hasAnySelector(KICKED_INDICATORS)) {
      logger.info('Meeting ended: bot was removed');
      return true;
    }

    // URL check
    const url = this.page.url();
    if (!url.includes('meet.google.com/') || url.includes('meet.google.com/?')) {
      logger.info(`Meeting ended: URL changed to ${url}`);
      return true;
    }

    // Check "alone" indicators from Google Meet UI
    const aloneIndicators = [
      "text=You're the only one here",
      'text=Vous êtes le seul participant',
      "text=No one else is here",
    ];
    const isAloneUI = await this.hasAnySelector(aloneIndicators);

    // Participant count check (after 15s in meeting — reduced from 60s)
    const minTimeInMeeting = 15 * 1000;
    if (this.joinedAt) {
      const timeInMeeting = Date.now() - this.joinedAt.getTime();
      if (timeInMeeting < minTimeInMeeting) {
        return false;
      }
    }

    const participantCount = await this.getParticipantCount();

    if (participantCount > this.lastKnownParticipantCount) {
      this.lastKnownParticipantCount = participantCount;
      logger.info(`Participant count updated: ${participantCount}`);
    }

    // Detect being alone: participant count <= 1 after having had other participants,
    // OR no live audio tracks after being connected, OR Google Meet "alone" UI
    if (participantCount <= 1 && this.lastKnownParticipantCount > 1) {
      logger.info(`Meeting ended: bot is the only participant left (count: ${participantCount}, peak: ${this.lastKnownParticipantCount})`);
      return true;
    }

    if (isAloneUI) {
      logger.info('Meeting ended: Google Meet shows bot is alone');
      return true;
    }

    if (rtcState.hasConnected && rtcState.liveAudioTracks === 0 && this.lastKnownParticipantCount > 1) {
      logger.info(`Meeting ended: no live audio tracks remaining (peak participants: ${this.lastKnownParticipantCount})`);
      return true;
    }

    return false;
  }

  private async getParticipantCount(): Promise<number> {
    if (!this.page) return 0;

    try {
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
          if (match) return parseInt(match[1], 10);

          const label = await btn.getAttribute('aria-label');
          const labelMatch = label?.match(/(\d+)/);
          if (labelMatch) return parseInt(labelMatch[1], 10);
        }
      }

      const participantTiles = await this.page.$$('[data-participant-id], [data-requested-participant-id], [data-allocation-index]');
      if (participantTiles.length > 0) {
        return participantTiles.length;
      }

      return 1;
    } catch (error) {
      logger.warn(`Failed to get participant count: ${error}`);
      return 1;
    }
  }

  /**
   * Detect the currently active speaker from Google Meet's UI.
   *
   * Google Meet highlights the speaking participant's tile with a colored border
   * and shows their name. This method reads the DOM to find who's speaking.
   * Works with any UI language since we read the visual indicator, not text.
   */
  async detectActiveSpeaker(): Promise<ActiveSpeaker | null> {
    if (!this.page) return null;

    try {
      return await this.page.evaluate(() => {
        // Strategy 1: Find participant tiles with a speaking indicator.
        // Google Meet adds a colored outline (blue/teal) to the tile of the
        // participant who is currently speaking.
        const tiles = document.querySelectorAll('[data-participant-id]');
        for (const tile of tiles) {
          const container = tile.closest('[data-allocation-index]') || tile;
          const style = getComputedStyle(container);

          // Speaking tiles have a non-transparent, non-black outline or border
          const outline = style.outlineColor || '';
          const border = style.borderColor || '';

          const isColored = (color: string) => {
            if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return false;
            if (color === 'rgb(0, 0, 0)' || color.startsWith('rgba(0, 0, 0')) return false;
            return true;
          };

          if (isColored(outline) || isColored(border)) {
            // Found speaking tile — extract the participant's name
            // Try multiple selectors for the name label
            const nameEl =
              container.querySelector('[data-self-name]') ||
              container.querySelector('[data-tooltip]') ||
              container.querySelector('[class*="name" i]') ||
              container.querySelector('span');

            const name = nameEl?.textContent?.trim();
            if (name && name !== 'You' && name !== 'Vous') {
              // Try to extract email from tooltip or aria-label
              const tooltip = (nameEl as HTMLElement)?.getAttribute?.('data-tooltip') || '';
              const email = tooltip.includes('@') ? tooltip : undefined;
              return { name, email };
            }
          }
        }

        // Strategy 2: Check the "dominant speaker" in spotlight/main view.
        // When someone speaks, Google Meet may show their name in the main tile.
        const mainTile = document.querySelector('[data-allocation-index="0"]');
        if (mainTile) {
          const nameEl =
            mainTile.querySelector('[data-self-name]') ||
            mainTile.querySelector('[data-tooltip]') ||
            mainTile.querySelector('span');
          const name = nameEl?.textContent?.trim();
          if (name && name !== 'You' && name !== 'Vous') {
            const tooltip = (nameEl as HTMLElement)?.getAttribute?.('data-tooltip') || '';
            const email = tooltip.includes('@') ? tooltip : undefined;
            return { name, email };
          }
        }

        // Strategy 3: Check captions if enabled (most reliable for name).
        // Captions show "Speaker Name" above or next to the text.
        const captionContainers = document.querySelectorAll(
          '[class*="caption" i], [class*="subtitle" i], [data-message-text]'
        );
        for (const cap of captionContainers) {
          // Look for a speaker name element near the caption text
          const speakerEl = cap.querySelector('[class*="name" i], [class*="sender" i]');
          if (speakerEl) {
            const name = speakerEl.textContent?.trim();
            if (name) return { name };
          }
        }

        return null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Extract participant details from Google Meet's DOM.
   *
   * Tries multiple strategies:
   * 1. Open the participant panel and read names from the list
   * 2. Fall back to reading participant tiles in the meeting view
   */
  async extractParticipants(): Promise<ParticipantInfo[]> {
    if (!this.page) return [];

    try {
      // Try to open the participants panel by clicking the people button
      const peopleBtnSelectors = [
        '[aria-label*="participant" i]',
        '[aria-label*="people" i]',
        '[aria-label*="personnes" i]',
        '[data-panel-id="5"]', // Google Meet people panel ID
      ];

      for (const selector of peopleBtnSelectors) {
        try {
          const btn = await this.page.$(selector);
          if (btn) {
            await btn.click();
            await this.sleep(1000);
            break;
          }
        } catch {
          // try next
        }
      }

      // Extract participants from the DOM
      const participants = await this.page.evaluate(() => {
        const results: Array<{ name: string; email?: string; isHost?: boolean }> = [];
        const seen = new Set<string>();

        // Strategy 1: Participant list panel items
        // Google Meet renders participant names in a panel with role="list"
        const listItems = document.querySelectorAll(
          '[data-participant-id], [role="listitem"], [data-tooltip]'
        );

        for (const item of listItems) {
          // Try to get name from various attributes and child elements
          const nameEl =
            item.querySelector('[data-self-name]') ||
            item.querySelector('[class*="name" i]') ||
            item.querySelector('span');
          let name = nameEl?.textContent?.trim() || '';

          // Also try the element's own tooltip/aria-label
          if (!name) {
            name = (item as HTMLElement).getAttribute('data-tooltip')?.trim() || '';
          }
          if (!name) {
            name = (item as HTMLElement).getAttribute('aria-label')?.trim() || '';
          }

          if (!name || name === 'You' || name === 'Vous' || seen.has(name)) {
            continue;
          }
          seen.add(name);

          // Try to extract email from tooltip
          const tooltip = (item as HTMLElement).getAttribute('data-tooltip') || '';
          const email = tooltip.includes('@') ? tooltip : undefined;

          // Check if host (Google Meet shows "Meeting host" or organizer badge)
          const itemText = item.textContent || '';
          const isHost =
            itemText.toLowerCase().includes('meeting host') ||
            itemText.toLowerCase().includes('organiser') ||
            itemText.toLowerCase().includes('organisateur');

          results.push({ name, email, isHost });
        }

        // Strategy 2: Video tiles (fallback)
        if (results.length === 0) {
          const tiles = document.querySelectorAll('[data-participant-id]');
          for (const tile of tiles) {
            const container = tile.closest('[data-allocation-index]') || tile;
            const nameEl =
              container.querySelector('[data-self-name]') ||
              container.querySelector('[data-tooltip]') ||
              container.querySelector('[class*="name" i]') ||
              container.querySelector('span');

            const name = nameEl?.textContent?.trim();
            if (!name || name === 'You' || name === 'Vous' || seen.has(name)) {
              continue;
            }
            seen.add(name);

            const tooltip = (nameEl as HTMLElement)?.getAttribute?.('data-tooltip') || '';
            const email = tooltip.includes('@') ? tooltip : undefined;

            results.push({ name, email, isHost: false });
          }
        }

        return results;
      });

      // Close the participants panel
      for (const selector of peopleBtnSelectors) {
        try {
          const btn = await this.page.$(selector);
          if (btn) {
            await btn.click();
            await this.sleep(300);
            break;
          }
        } catch {
          // ignore
        }
      }

      logger.info(`Extracted ${participants.length} participants from Google Meet`);
      return participants;
    } catch (error) {
      logger.warn(`Failed to extract participants: ${error}`);
      return [];
    }
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    logger.info('Leaving Google Meet');

    // Restore toolbar visibility so leave button is clickable
    if (this.meetUIController) {
      await this.meetUIController.restoreForLeave();
      await this.sleep(300);
    }

    const leaveBtn = await this.page.$('[aria-label*="Leave call"], [aria-label*="leave" i], [jsname="CQylAd"]');
    if (leaveBtn) {
      await leaveBtn.click();
      await this.sleep(1000);
    }
  }
}
