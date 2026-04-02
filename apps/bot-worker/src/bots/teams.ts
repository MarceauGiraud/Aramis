import { BaseMeetingBot, BotConfig, BotOptions, JoinError } from './base';
import { BOT_CONFIG } from '@aramis/shared';
import { logger } from '../lib/logger';

// -- Popup / consent selectors (Teams-specific) ------------------------------

const TEAMS_POPUP_SELECTORS = [
  // Cookie consent banners (common on EU tenants)
  '[data-tid="cookie-banner"] button:has-text("Accept")',
  '[data-tid="cookie-banner"] button:has-text("Accepter")',
  'button:has-text("Accept all cookies")',
  'button:has-text("Accepter tous les cookies")',
  '#onetrust-accept-btn-handler',

  // Generic dismissible dialogs
  'button:has-text("Got it")',
  'button:has-text("Compris")',
  'button:has-text("OK")',
  'button:has-text("Dismiss")',
  'button:has-text("Ignorer")',
  'button:has-text("Close")',
  'button:has-text("Fermer")',

  // Allow / Block permission prompts
  'button:has-text("Allow")',
  'button:has-text("Autoriser")',
  'button:has-text("Block")',
  'button:has-text("Bloquer")',

  // Teams "Recording has started" / notification banners
  '[data-tid="banner-dismiss-button"]',
  '[data-tid="notification-dismiss"]',
  '[data-tid="close-button"]',
  '[aria-label="Dismiss" i]',
  '[aria-label="Fermer" i]',
  '[aria-label="Close" i]',
  '[aria-label="Close dialog" i]',
  '[aria-label="Close notification" i]',

  // Copilot / Gemini feature prompts
  'button:has-text("Maybe later")',
  'button:has-text("Plus tard")',
  'button:has-text("Not now")',
  'button:has-text("Pas maintenant")',
  'button:has-text("Skip")',
  'button:has-text("Passer")',
];

const TEAMS_CAMERA_PROMPT_SELECTORS = [
  // "Use your mic and camera" permission dialog
  'text=Use your mic and camera',
  'text=Utilisez votre micro et votre caméra',
  'text=Use your camera',
  'text=Utiliser votre caméra',
  // Browser notification permission prompts
  'text=Allow notifications',
  'text=Autoriser les notifications',
];

// -- Bot class ---------------------------------------------------------------

/**
 * Microsoft Teams Meeting Bot
 *
 * Joins Teams meetings via web client and records audio/video
 * Uses the Teams web client for browser-based joining
 */
export class TeamsBot extends BaseMeetingBot {
  private lastKnownParticipantCount = 0;


  constructor(config: BotConfig, options?: BotOptions) {
    super({ ...config, platform: config.platform ?? 'TEAMS' }, options);
  }

  async join(): Promise<void> {
    if (!this.page) {
      throw new JoinError('Page not initialized', false);
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
            await this.page.goto('about:blank', { timeout: 5000 });
          } catch {
            // ignore navigation errors during reset
          }
        }
        await this.sleep(2000 + Math.random() * 2000);
      }
    }
  }

  /**
   * Intercept WebSocket frames on the page to detect Teams-specific
   * meeting-end signals (conversationEnd, callEnd, participantRemoved,
   * meetingEnded).  These signals arrive faster and more reliably than DOM
   * changes, giving us near-instant meeting-end detection even when the
   * server terminates the call.
   *
   * Non-fatal: if interception fails the bot falls back to DOM-based
   * detection which still works.
   */
  private setupWebSocketInterception(): void {
    if (!this.page) return;

    try {
      this.page.on('websocket', (ws) => {
        const url = ws.url();
        logger.info(`WebSocket opened: ${url.substring(0, 120)}...`);

        ws.on('framereceived', (frame) => {
          // Only inspect text frames (skip binary media frames)
          if (typeof frame.payload !== 'string') return;

          const payload = frame.payload;

          // Teams signaling uses JSON messages.  We look for keywords that
          // indicate the meeting/call has ended or the bot was removed.
          // These strings appear in Teams Trouter / signaling WebSocket
          // frames and are stable across v1/v2 web client.
          const endSignals: Array<{ keyword: string; change: string }> = [
            { keyword: 'conversationEnd', change: 'meeting_ended' },
            { keyword: 'callEnd', change: 'meeting_ended' },
            { keyword: 'meetingEnded', change: 'meeting_ended' },
            { keyword: 'participantRemoved', change: 'request_to_join_denied' },
          ];

          for (const { keyword, change } of endSignals) {
            if (payload.includes(keyword)) {
              // Ignore participantRemoved before the bot has joined —
              // this fires when OTHER participants leave/join while we
              // are still in the lobby, causing a premature exit.
              if (keyword === 'participantRemoved' && !this.joinedSuccessfully) {
                logger.info(
                  `Ignoring "${keyword}" WebSocket signal (bot not yet in meeting)`,
                );
                return;
              }
              logger.info(
                `WebSocket signal detected: "${keyword}" -> ${change} (ws: ${url.substring(0, 80)})`,
              );
              this.handleMeetingSignal({ type: 'MeetingStatusChange', change });
              return; // First match wins; avoid duplicate signals from the same frame
            }
          }

          // Parse roster/participant updates from Teams signaling.
          // Teams sends JSON frames with participant lists when people
          // join or leave. We extract the count and feed it to the base
          // class roster tracking so the zombie watchdog works.
          try {
            if (
              payload.includes('participants') ||
              payload.includes('roster') ||
              payload.includes('endpointDetails')
            ) {
              const data = JSON.parse(payload);
              const count = this.extractParticipantCountFromSignal(data);
              if (count !== null) {
                this.handleMeetingSignal({
                  type: 'RosterUpdate',
                  activeParticipantCount: count,
                });
              }
            }
          } catch {
            // Not valid JSON or no participant data — ignore
          }
        });

        ws.on('close', () => {
          logger.info(`WebSocket closed: ${url.substring(0, 120)}`);
        });
      });

      logger.info('WebSocket interception set up for Teams meeting-end detection');
    } catch (error) {
      logger.warn(`Failed to set up WebSocket interception: ${error}`);
    }
  }

  /**
   * Try to extract a participant count from a Teams WebSocket signaling frame.
   * Teams uses various JSON structures; we look for arrays of participants
   * or explicit count fields.
   */
  private extractParticipantCountFromSignal(data: any, depth = 0): number | null {
    if (depth > 3 || !data || typeof data !== 'object') return null;
    try {
      // Structure 1: { participants: [...] } or { roster: [...] }
      if (Array.isArray(data.participants)) {
        return data.participants.filter(
          (p: any) => p.state === 'Connected' || p.state === 'InLobby' || !p.state,
        ).length;
      }
      if (Array.isArray(data.roster)) {
        return data.roster.filter(
          (p: any) => p.state === 'Connected' || !p.state,
        ).length;
      }

      // Structure 2: { participantCount: N } or { activeParticipantCount: N }
      if (typeof data.participantCount === 'number') return data.participantCount;
      if (typeof data.activeParticipantCount === 'number') return data.activeParticipantCount;

      // Structure 3: Nested under body/content/resource
      const body = data.body || data.content || data.resource;
      if (body && typeof body === 'object') {
        return this.extractParticipantCountFromSignal(body, depth + 1);
      }

      // Structure 4: { endpointDetails: [...] } — each entry is a connected endpoint
      if (Array.isArray(data.endpointDetails)) {
        return data.endpointDetails.length;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Single join attempt — extracted so the retry loop stays clean.
   */
  private async attemptJoin(attempt: number): Promise<void> {
    if (!this.page) {
      throw new JoinError('Page not initialized', false);
    }

    // Transform the meeting URL to go directly to the Teams web client,
    // bypassing the launcher page and all language-dependent "Continue on
    // this browser" / "Join on the web instead" clicks.
    const webClientUrl = this.buildWebClientUrl(this.config.meetingUrl);
    logger.info(`Joining Teams meeting (attempt ${attempt}): ${this.config.meetingUrl}`);
    logger.info(`Direct web client URL: ${webClientUrl}`);

    // Use 'domcontentloaded' instead of 'networkidle' — Teams SPA keeps making
    // API calls (401s for anonymous user) which delays networkidle by 30-40s.
    // The SPA initializes fine with domcontentloaded; we poll for pre-join after.
    await this.page.goto(webClientUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Set up WebSocket interception early so we capture Teams signaling frames
    // even during the pre-join / lobby phase.
    this.setupWebSocketInterception();

    await this.takeDebugScreenshot('01_page_loaded');

    // Fail fast on error states (captcha, login form, sign-in required, etc.)
    await this.checkForErrorStates();

    // If we ended up on a launcher/interstitial/error page, handle it
    const currentUrl = this.page.url();
    const pageTitle = await this.page.title().catch(() => 'unknown');
    logger.info(`Current URL: ${currentUrl}`);
    logger.info(`Page title: ${pageTitle}`);

    if (currentUrl.includes('launcher.html') || currentUrl.includes('/error/')) {
      logger.info(`Landed on interstitial page: ${currentUrl}, attempting web join flow`);
      await this.handleWebJoin();
      await this.takeDebugScreenshot('02_after_web_join');
    }

    // If the page shows a "not found" error, try the v2 SPA fallback
    if (pageTitle.toLowerCase().includes("couldn't find") || pageTitle.toLowerCase().includes('something went wrong')) {
      logger.warn(`Error page detected: "${pageTitle}", trying v2 SPA fallback`);
      const meetPath = new URL(this.config.meetingUrl).pathname + new URL(this.config.meetingUrl).search;
      const v2Url = this.buildV2Url(meetPath);
      logger.info(`Navigating to v2 SPA: ${v2Url}`);
      await this.page.goto(v2Url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this.sleep(3000);
      await this.takeDebugScreenshot('02_v2_fallback');
      const newTitle = await this.page.title().catch(() => 'unknown');
      logger.info(`After v2 fallback - URL: ${this.page.url()}, title: ${newTitle}`);
    }

    // Wait for pre-join screen
    await this.waitForPreJoinScreen();
    await this.sleep(1000 + Math.random() * 1000);

    // Dismiss popups (cookie consent, permission prompts, etc.)
    await this.handlePopups();

    // Enter name
    await this.enterName();
    await this.takeDebugScreenshot('03_name_entered');

    // Turn off camera and microphone
    await this.turnOffCamera();
    await this.sleep(300 + Math.random() * 200);
    await this.turnOffMicrophone();
    await this.sleep(300 + Math.random() * 200);

    await this.takeDebugScreenshot('04_media_off');

    // Dismiss any popups triggered by media toggle or name entry
    await this.handlePopups();

    // Click Join button
    const joinClicked = await this.clickJoinButton();
    if (!joinClicked) {
      logger.warn('Could not find Join button');
      await this.takeDebugScreenshot('05_no_join_button');
      throw new JoinError('Could not find Join button', true);
    }

    await this.takeDebugScreenshot('05_join_clicked');

    // Wait for the pre-join screen to disappear or lobby to appear.
    // After clicking Join, Teams either:
    //   a) Goes directly into the meeting (pre-join disappears)
    //   b) Shows lobby screen ("Someone will let you in shortly")
    //   c) Stays on pre-join (join failed, needs retry)
    const joinResult = await this.waitForJoinTransition();
    await this.takeDebugScreenshot('06_after_join_click');

    if (joinResult === 'lobby') {
      logger.info('Bot is in the lobby, waiting for admission...');
      await this.waitForAdmission();
      await this.takeDebugScreenshot('07_after_admission');
    } else if (joinResult === 'prejoin') {
      // Still on pre-join — join didn't work, but do NOT click again
      // (double-click breaks the WebRTC connection). Just wait a bit longer.
      logger.warn('Still on pre-join after clicking Join, waiting for transition...');
      await this.takeDebugScreenshot('06_still_on_prejoin');
      await this.sleep(10000);
      // Check one more time if we transitioned
      const retryResult = await this.waitForJoinTransition();
      if (retryResult === 'lobby') {
        logger.info('Bot entered lobby on second check');
        await this.waitForAdmission();
      } else if (retryResult === 'prejoin') {
        throw new JoinError('Join button click had no effect', true);
      }
    }
    // joinResult === 'meeting' means we're directly in

    // Verify we're in the meeting
    const inMeeting = await this.checkStillInMeeting();
    if (!inMeeting) {
      await this.takeDebugScreenshot('08_join_failed');
      // Check if we're on a "Rejoin" page (means we were kicked from lobby)
      const pageContent = await this.page.textContent('body').catch(() => '');
      if (pageContent?.includes('Rejoin')) {
        throw new JoinError('Bot was removed from lobby or meeting ended', true);
      }
      throw new JoinError('Failed to join Teams meeting', true);
    }

    this.joinedSuccessfully = true;
    this.joinedAt = new Date();
    logger.info('Successfully joined Teams meeting');
    await this.takeDebugScreenshot('07_joined_successfully');

    // Start recording immediately — FFmpeg x11grab captures the screen
    // regardless of what's on it, so it's safe to start early and trim later.
    // This avoids losing content while the UI setup steps run (~25s).
    await this.startRecording();

    // Wait for the meeting UI to be fully rendered.
    await this.waitForMeetingUIReady();

    // Clean up Teams UI for recording: blanket overlay hides all chrome
    // (chat, toolbar, banners) while promoting the video area on top.
    await this.setupRecordingUI();

    // Switch to speaker view for a cleaner recording
    await this.selectLayout('speaker');

    // Prevent Teams from going idle during recording
    await this.startFakeActivity();

    // Mark the content start AFTER UI is ready so the trim correctly
    // removes the setup period (toolbars, layout switching, etc.).
    this.meetingContentStartTime = Date.now();
    logger.info('Meeting content starts — UI ready, recording already running');
  }

  /**
   * Dismiss popups, consent banners, and permission prompts.
   *
   * Runs in a loop until no new popup is dismissed for POPUP_STABLE_MS.
   * All errors are caught so this never breaks the join flow.
   */
  private async handlePopups(): Promise<void> {
    if (!this.page) return;

    const stableThreshold = BOT_CONFIG.POPUP_STABLE_MS;
    let lastDismissedAt = Date.now();

    while (Date.now() - lastDismissedAt < stableThreshold) {
      let dismissed = false;

      // Try clicking dismiss buttons
      for (const selector of TEAMS_POPUP_SELECTORS) {
        try {
          const el = await this.page.$(selector);
          if (el) {
            await this.page.click(selector, { timeout: 2000 });
            logger.info(`Dismissed Teams popup: ${selector}`);
            await this.sleep(100);
            dismissed = true;
            lastDismissedAt = Date.now();
          }
        } catch {
          // continue
        }
      }

      // Handle camera/mic/notification permission prompts with Escape
      for (const selector of TEAMS_CAMERA_PROMPT_SELECTORS) {
        try {
          const el = await this.page.$(selector);
          if (el) {
            await this.page.keyboard.press('Escape');
            logger.info(`Escaped Teams prompt: ${selector}`);
            await this.sleep(200);
            dismissed = true;
            lastDismissedAt = Date.now();
          }
        } catch {
          // continue
        }
      }

      if (!dismissed) {
        await this.sleep(200);
      }
    }
  }

  /**
   * Select the Teams meeting layout (speaker or gallery view).
   * Uses Teams' native view mode controls for reliable layout switching.
   */
  private async selectLayout(view: 'speaker' | 'gallery'): Promise<void> {
    if (!this.page) return;

    try {
      // Click the view mode button to open the menu
      const viewBtnSelectors = [
        '#view-mode-button',
        '#custom-view-button',
        '[data-tid="calling-layout-button"]',
        'button[aria-label*="layout" i]',
        'button[aria-label*="view" i]',
      ];

      let clicked = false;
      for (const sel of viewBtnSelectors) {
        const btn = await this.page.$(sel);
        if (btn) {
          await btn.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        logger.info('Layout button not found — using default layout');
        return;
      }

      await this.sleep(500);

      // Select the desired view
      const viewSelectors =
        view === 'gallery'
          ? [
              '#custom-view-button-MixedGridButton',
              '#MixedGrid-button',
              '#MixedGridView-button',
              '[aria-label*="Gallery" i]',
            ]
          : ['#custom-view-button-SpeakerViewButton', '#SpeakerView-button', '[aria-label*="Speaker" i]'];

      for (const sel of viewSelectors) {
        const option = await this.page.$(sel);
        if (option) {
          await option.click();
          logger.info(`Layout set to ${view} via ${sel}`);
          return;
        }
      }

      // Close menu if we couldn't find the option
      await this.page.keyboard.press('Escape');
      logger.info(`Layout option for ${view} not found — keeping default`);
    } catch (error) {
      logger.warn(`Failed to set layout: ${error}`);
    }
  }

  /**
   * Dispatch fake mousemove events inside the page to prevent Teams
   * from going idle and kicking the bot for inactivity.
   */
  private async startFakeActivity(): Promise<void> {
    if (!this.page) return;
    await this.page.evaluate(() => {
      if ((window as any).__aramisFakeActivityInterval) return;
      (window as any).__aramisFakeActivityInterval = setInterval(() => {
        document.body.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: Math.random() * 500,
            clientY: Math.random() * 500,
          }),
        );
      }, 240000); // Every 4 minutes
    });
    logger.info('Fake user activity started (mousemove every 4 min)');
  }

  /**
   * Transform a Teams meeting URL into a direct web client URL.
   *
   * The /meet/<id> format redirects to a launcher page which often fails
   * in headless/Xvfb environments. Instead, we load the new Teams SPA
   * client directly via the /v2/ path prefix, which returns the React
   * app without going through the launcher at all.
   *
   * For /l/meetup-join/ URLs we add anti-launcher query params.
   * For launcher wrapper URLs we extract the embedded path first.
   */
  private buildWebClientUrl(originalUrl: string): string {
    try {
      const url = new URL(originalUrl);

      // Format: teams.microsoft.com/dl/launcher/launcher.html?url=...
      // → extract the embedded URL and navigate directly via the v2 SPA
      if (url.pathname.includes('/dl/launcher/')) {
        const embeddedUrl = url.searchParams.get('url');
        if (embeddedUrl) {
          const decoded = decodeURIComponent(embeddedUrl);
          const cleanPath = decoded.replace(/^\/?_#\//, '/');
          return this.buildV2Url(cleanPath);
        }
      }

      // Format: /v2/#/l/meetup-join/... → already v2, use as-is
      if (url.pathname.startsWith('/v2/')) {
        if (!url.searchParams.has('anon')) {
          url.searchParams.set('anon', 'true');
        }
        return url.toString();
      }

      // Format: /meet/<id>?p=<token> → load via v2 SPA directly
      // The /meet/ path without /v2/ prefix goes through the launcher
      // which fails in headless environments. The /v2/ prefix loads the
      // new Teams React SPA client which handles /meet/ natively.
      if (url.pathname.startsWith('/meet/')) {
        return this.buildV2Url(url.pathname + url.search);
      }

      // Format: /l/meetup-join/... → add anti-launcher params
      if (url.pathname.includes('/l/meetup-join/')) {
        this.addAntiLauncherParams(url);
        return url.toString();
      }

      // Unknown format — try v2 prefix as best effort
      return this.buildV2Url(url.pathname + url.search);
    } catch (error) {
      logger.warn(`Failed to parse Teams URL, using original: ${error}`);
      return originalUrl;
    }
  }

  /**
   * Build a URL that loads the new Teams v2 SPA client directly.
   * The /v2/ prefix returns the React app without going through
   * the launcher page.
   */
  private buildV2Url(path: string): string {
    // Ensure path starts with /
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`https://teams.microsoft.com/v2${cleanPath}`);
    if (!url.searchParams.has('anon')) {
      url.searchParams.set('anon', 'true');
    }
    return url.toString();
  }

  /**
   * Add query parameters that bypass the Teams launcher/desktop-app prompt.
   */
  private addAntiLauncherParams(url: URL): void {
    url.searchParams.set('msLaunch', 'false');
    url.searchParams.set('suppressPrompt', 'true');
    url.searchParams.set('directDl', 'true');
    url.searchParams.set('anon', 'true');
  }

  /**
   * Handle the launcher/interstitial page.
   *
   * The launcher's "Join on the web" button ([data-tid="joinOnWeb"]) points
   * to classic Teams (/_#/) which is dead. Instead of clicking it, we:
   *   1. Try clicking it and catching any new tab it opens
   *   2. If that fails, extract the meeting path from the launcher URL params
   *      and navigate directly
   */
  private async handleWebJoin(): Promise<void> {
    if (!this.page || !this.context) return;

    const currentUrl = this.page.url();
    if (!currentUrl.includes('launcher.html')) {
      logger.info('Not on launcher page, skipping web join flow');
      return;
    }

    logger.info('On launcher page, attempting to reach web client');

    // Strategy 1: Click [data-tid="joinOnWeb"] and catch the new tab
    const joinOnWebBtn = await this.page.$('[data-tid="joinOnWeb"]');
    if (joinOnWebBtn) {
      try {
        const [newPage] = await Promise.all([
          this.context.waitForEvent('page', { timeout: 5000 }),
          joinOnWebBtn.click(),
        ]);

        if (newPage) {
          logger.info(`New tab opened: ${newPage.url()}`);
          // Close old launcher tab, use the new one
          await this.page.close().catch(() => {});
          this.page = newPage;
          // Re-attach CDP settings and event listeners on the new page
          await this.reattachPageListeners();
          await this.page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
          await this.sleep(2000);

          // If the new tab also landed on an error/launcher, continue to strategy 2
          const newUrl = this.page.url();
          if (!newUrl.includes('launcher.html') && !newUrl.includes('/error/')) {
            logger.info(`Web client loaded in new tab: ${newUrl}`);
            return;
          }
          logger.info(`New tab is also interstitial: ${newUrl}, trying direct navigation`);
        }
      } catch {
        // No new tab opened within timeout — the button may have navigated in-place
        // or done nothing useful. Continue to strategy 2.
        logger.info('No new tab from joinOnWeb click, trying direct navigation');
      }
    }

    // Strategy 2: Extract meeting path from launcher URL and navigate via v2 SPA
    try {
      const launcherUrl = new URL(this.page.url());
      const embeddedUrl = launcherUrl.searchParams.get('url');

      if (embeddedUrl) {
        const decoded = decodeURIComponent(embeddedUrl);
        // Strip /_#/ prefix (classic Teams path)
        const cleanPath = decoded.replace(/^\/?_#\//, '/');
        // Build direct URL via the v2 SPA client (bypasses launcher)
        const directUrl = this.buildV2Url(cleanPath);

        logger.info(`Navigating directly to v2 SPA: ${directUrl}`);
        await this.page.goto(directUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await this.sleep(3000);
      }
    } catch (error) {
      logger.warn(`Direct navigation from launcher failed: ${error}`);
    }

    logger.info(`Web join flow completed, current URL: ${this.page.url()}`);
  }

  /**
   * Check for Teams error states that prevent joining.
   * Called during the join flow to fail fast instead of hanging.
   */
  private async checkForErrorStates(): Promise<void> {
    if (!this.page) return;

    const errorState = await this.page
      .evaluate(() => {
        const bodyText = document.body?.textContent || '';

        // Captcha
        if (
          bodyText.includes("Verify you're a real person") ||
          document.querySelector('iframe[src*="captcha"], #captcha, [data-tid="captcha"]')
        ) {
          return { error: 'captcha', retryable: false };
        }

        // Login form
        if (document.querySelector('input[name="loginfmt"][type="email"], input[type="email"][name="loginfmt"]')) {
          return { error: 'login_form_redirect', retryable: false };
        }

        // Sign-in required messages
        const signInMessages = [
          'Sign in to join',
          'You need to sign in',
          'We need to verify your info before you can join',
          'To join, sign in or use Teams on the web',
          'sign in again or select another account',
          'Due to org policy, you need to sign in',
        ];
        for (const msg of signInMessages) {
          if (bodyText.includes(msg)) return { error: 'sign_in_required: ' + msg, retryable: false };
        }

        // Connection failure (retryable)
        if (bodyText.includes("we couldn't connect you") || bodyText.includes("couldn't connect you")) {
          return { error: 'connection_failure', retryable: true };
        }

        return null;
      })
      .catch(() => null);

    if (errorState) {
      logger.warn(`Teams error state detected: ${errorState.error}`);
      throw new JoinError(`Teams error: ${errorState.error}`, errorState.retryable);
    }
  }

  /**
   * Wait for the pre-join screen to appear
   */
  private async waitForPreJoinScreen(): Promise<void> {
    if (!this.page) return;

    const preJoinSelectors = [
      '[data-tid="prejoin-display-name-input"]',
      '[placeholder*="Enter name" i]',
      '[placeholder*="Type your name" i]',
      '[placeholder*="Entrez votre nom" i]',
      '[placeholder*="Tapez votre nom" i]',
      '#username',
      '.calling-prejoin-screen',
      '[data-tid="prejoin-join-button"]',
      // New Teams v2 client selectors
      '[data-tid="prejoin-name-input"]',
      'input[data-tid*="name" i]',
      '[role="textbox"][aria-label*="name" i]',
      'button[data-tid*="join" i]',
      // Generic fallbacks for new Teams UI
      'input[type="text"][maxlength]',
    ] as const;

    // Teams v2 SPA is very heavy — wait up to 90 seconds for it to load
    const maxWait = 90000;
    const startTime = Date.now();
    let lastScreenshotAt = 0;

    while (Date.now() - startTime < maxWait) {
      if (await this.hasAnySelector(preJoinSelectors)) {
        logger.info('Pre-join screen loaded');
        return;
      }

      // Fail fast on error states instead of waiting the full 90s
      await this.checkForErrorStates();

      // Take periodic screenshots for debugging (every 15s)
      const elapsed = Date.now() - startTime;
      if (elapsed - lastScreenshotAt > 15000) {
        lastScreenshotAt = elapsed;
        await this.takeDebugScreenshot(`prejoin_wait_${Math.round(elapsed / 1000)}s`);
        // Log current page state for debugging
        const title = await this.page.title().catch(() => 'unknown');
        const splashVisible = await this.page.$('#splash-screen').catch(() => null);
        logger.info(
          `Waiting for pre-join (${Math.round(elapsed / 1000)}s): title="${title}", splash=${splashVisible ? 'visible' : 'gone'}`,
        );
      }

      await this.sleep(2000);
    }

    logger.warn('Pre-join screen not found within timeout (90s)');
    // Capture page HTML for debugging
    await this.captureMhtml('pre_join_timeout');
    await this.takeDebugScreenshot('prejoin_timeout_final');
    throw new JoinError('Pre-join screen not found within timeout (90s)', true);
  }

  /**
   * Wait for the join transition after clicking "Join now".
   * Returns the resulting state:
   *   - 'meeting': directly in the meeting (pre-join gone, meeting indicators present)
   *   - 'lobby': in the waiting room ("Someone will let you in")
   *   - 'prejoin': still on the pre-join screen (join had no effect)
   */
  private async waitForJoinTransition(): Promise<'meeting' | 'lobby' | 'prejoin'> {
    if (!this.page) return 'prejoin';

    const lobbyIndicators = [
      'text=Someone will let you in',
      'text=Someone in the meeting should let you in',
      'text=Waiting for others to let you in',
      'text=waiting to be let in',
      '[data-tid="lobby-screen"]',
      '.calling-lobby',
    ] as const;

    const meetingIndicators = [
      '[data-inp="hangup-button"]',
      '#hangup-button',
      '[data-tid="hangup-button"]',
      '[data-tid="calling-unified-bar"]',
      '[data-tid="roster-button"]',
    ] as const;

    const maxWait = 20000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      // Use page.evaluate for reliable text matching (bypasses Playwright visibility checks)
      const state = await this.page
        .evaluate(() => {
          const bodyText = document.body?.textContent || '';

          // Lobby detection — match any "let you in" variant
          const lobbyPhrases = [
            'will let you in',
            'should let you in',
            'Waiting for others to let you in',
            'waiting to be let in',
          ];
          for (const phrase of lobbyPhrases) {
            if (bodyText.includes(phrase)) return 'lobby';
          }
          if (document.querySelector('[data-tid="lobby-screen"], .calling-lobby')) return 'lobby';

          // Meeting detection — hangup button means we're in
          if (
            document.querySelector(
              '[data-inp="hangup-button"], #hangup-button, [data-tid="hangup-button"], [data-tid="calling-unified-bar"], [data-tid="roster-button"]',
            )
          ) {
            return 'meeting';
          }

          return 'unknown';
        })
        .catch(() => 'unknown');

      if (state === 'lobby') {
        logger.info('Detected lobby/waiting room');
        return 'lobby';
      }
      if (state === 'meeting') {
        logger.info('Directly admitted to meeting (no lobby)');
        return 'meeting';
      }

      // Fail fast on error states (e.g. connection failure after clicking Join)
      await this.checkForErrorStates();

      // Check if pre-join button is gone (transitioning)
      try {
        const preJoinBtn = await this.page.$('[data-tid="prejoin-join-button"]');
        if (!preJoinBtn) {
          // Pre-join gone but no meeting/lobby indicators yet — keep waiting
          logger.info('Pre-join screen disappeared, waiting for meeting or lobby...');
        }
      } catch {
        // Page navigating
        return 'meeting';
      }

      await this.sleep(1000);
    }

    // After timeout, check one final time
    if (await this.hasAnySelector(lobbyIndicators)) return 'lobby';
    if (await this.hasAnySelector(meetingIndicators)) return 'meeting';

    return 'prejoin';
  }

  /**
   * Wait for the meeting UI to be fully rendered on screen.
   *
   * After admission from the lobby (or direct join), the DOM transitions from
   * the pre-join / lobby view to the active meeting view. WebRTC may connect
   * before this transition completes, so we wait for concrete meeting UI
   * elements (participant tiles, toolbar, hangup button) to appear before
   * starting the recording. This ensures meetingContentStartTime is accurate
   * for video trimming.
   */
  private async waitForMeetingUIReady(): Promise<void> {
    if (!this.page) return;

    // Selectors for elements that only appear in the active meeting view
    // (not present on the pre-join or lobby screens).
    const meetingUISelector = [
      '[data-test-segment-type="central"]', // central video area
      '[data-stream-type="Video"]', // participant video streams
      '[data-cid="calling-participant-stream"]', // participant stream containers
      '[data-tid="calling-unified-bar"]', // meeting toolbar
      '[data-inp="hangup-button"]', // hangup button (v2)
      '#hangup-button', // hangup button (alt)
      '[data-tid="hangup-button"]', // hangup button (v1)
    ].join(', ');

    // Lobby / pre-join indicators that should be gone before we consider
    // the meeting UI ready.
    const waitingIndicators = [
      'text=Someone will let you in',
      'text=Someone in the meeting should let you in',
      'text=Waiting for others to let you in',
      'text=waiting to be let in',
      '[data-tid="lobby-screen"]',
      '[data-tid="prejoin-join-button"]',
    ] as const;

    const deadline = Date.now() + 15_000; // 15s timeout
    while (Date.now() < deadline) {
      try {
        const el = await this.page.$(meetingUISelector);
        if (el) {
          // Verify lobby / pre-join text is gone
          const stillWaiting = await this.hasAnySelector(waitingIndicators);
          if (stillWaiting) {
            await this.sleep(250);
            continue;
          }
          logger.info('Meeting UI is ready — video area / controls visible');
          // Brief settle for rendering to complete (video tile paint)
          await this.sleep(500);
          return;
        }
      } catch {
        // page may be navigating
      }
      await this.sleep(250);
    }

    // Timed out — non-fatal, add a safety delay so the transition can finish.
    logger.warn('Meeting UI ready timeout — adding 1.5s safety delay before recording');
    await this.sleep(1500);
  }

  /**
   * Set up the recording UI for a clean video capture (MeetingBaas approach).
   *
   * Instead of promoting `[data-test-segment-type="central"]` above a blanket
   * (which only shows the main speaker, not filmstrip thumbnails, and breaks
   * under CSS `contain: paint` on Teams v2 ancestors), we:
   *
   *   1. Hide the header toolbar via opacity (not display:none to avoid re-layout)
   *   2. Force the main content area to fill the viewport
   *   3. Cover any menus/overlays with black
   *   4. Remove voice level indicator borders
   *   5. Hide banners and notifications
   *
   * A blanket div is kept as fallback if `app-layout-area--main` is absent
   * (falls back to promoting the central segment like before).
   *
   * A rAF loop re-applies styles at ~1 FPS to survive Teams DOM re-renders.
   */
  private async setupRecordingUI(): Promise<void> {
    if (!this.page) return;

    try {
      await this.page.evaluate(() => {
        const styleId = '__aramis-recording-style';
        const blanketId = '__aramis-recording-ui';
        if (document.getElementById(styleId)) return;

        // 1. Inject CSS rules
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
          /* Hide the header toolbar (opacity keeps layout stable) */
          [data-tid="app-layout-area--header"] {
            opacity: 0 !important;
            height: 0 !important;
            overflow: hidden !important;
          }

          /* Force the main content area to fill the entire viewport */
          [data-tid="app-layout-area--main"] {
            position: fixed !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            z-index: 1999 !important;
          }

          /* Cover any menus/overlays with black */
          [role="menu"] {
            position: fixed !important;
            width: 100vw !important;
            height: 100vh !important;
            background: black !important;
            z-index: 9999 !important;
          }

          /* Remove voice level indicator borders */
          [data-tid="voice-level-stream-outline"]::before {
            border: 0px !important;
          }

          /* Hide banners and notifications */
          [data-tid="app-banner"],
          [role="banner"],
          [data-tid="notification-bar"] {
            display: none !important;
          }

          /* Hide self-view overlay (v1 + v2 selectors) */
          [data-tid="self-video"],
          [data-cid="calling-self-video"],
          .ts-calling-self-video,
          [data-tid="self-preview"],
          [data-tid="self-video-pip"],
          [data-cid="calling-self-video-pip"],
          [data-tid="calling-self-video"],
          [data-tid="self-video-tile"] {
            opacity: 0 !important;
            pointer-events: none !important;
          }

          /* Fallback: if main area approach works, central segment inherits.
             If main area is missing, we promote central via the rAF loop. */
          [data-test-segment-type="central"] {
            pointer-events: auto !important;
          }
        `;
        document.head.appendChild(style);

        // 2. Create blanket as fallback (only visible if main area is absent)
        const blanket = document.createElement('div');
        blanket.id = blanketId;
        Object.assign(blanket.style, {
          position: 'fixed',
          inset: '0',
          background: '#1a1a1a',
          zIndex: '1998',
          pointerEvents: 'none',
          display: 'none', // hidden by default; shown only in fallback mode
        });
        document.body.appendChild(blanket);
      });
      logger.info('Recording UI styles injected (MeetingBaas approach: header hidden, main area promoted)');

      // 3. Start a requestAnimationFrame loop throttled to ~1 FPS
      await this.page.evaluate(() => {
        if ((window as any).__aramisRecordingUIRunning) return;
        (window as any).__aramisRecordingUIRunning = true;

        (function aramisLoop(lastRun: number) {
          if (!(window as any).__aramisRecordingUIRunning) return;
          requestAnimationFrame((now) => {
            if (now - lastRun > 1000) {
              // Throttle to ~1 FPS
              const mainArea = document.querySelector('[data-tid="app-layout-area--main"]') as HTMLElement;

              if (mainArea) {
                // Primary approach: force main area to fill viewport
                mainArea.style.position = 'fixed';
                mainArea.style.inset = '0';
                mainArea.style.width = '100vw';
                mainArea.style.height = '100vh';
                mainArea.style.zIndex = '1999';

                // Hide header toolbar
                const header = document.querySelector('[data-tid="app-layout-area--header"]') as HTMLElement;
                if (header) {
                  header.style.opacity = '0';
                  header.style.height = '0';
                  header.style.overflow = 'hidden';
                }

                // Hide blanket in primary mode
                const blanket = document.getElementById('__aramis-recording-ui');
                if (blanket) blanket.style.display = 'none';
              } else {
                // Fallback: promote central segment above blanket (old approach)
                const central = document.querySelector('[data-test-segment-type="central"]') as HTMLElement;
                if (central) {
                  central.style.position = 'fixed';
                  central.style.inset = '0';
                  central.style.width = '100vw';
                  central.style.height = '100vh';
                  central.style.zIndex = '1999';
                }

                // Show blanket in fallback mode
                const blanket = document.getElementById('__aramis-recording-ui');
                if (blanket) {
                  blanket.style.display = 'block';
                } else {
                  // Re-create blanket if Teams cleared it
                  const newBlanket = document.createElement('div');
                  newBlanket.id = '__aramis-recording-ui';
                  Object.assign(newBlanket.style, {
                    position: 'fixed',
                    inset: '0',
                    background: '#1a1a1a',
                    zIndex: '1998',
                    pointerEvents: 'none',
                  });
                  document.body.appendChild(newBlanket);
                }
              }

              lastRun = now;
            }
            aramisLoop(lastRun);
          });
        })(0);
      });
    } catch (error) {
      logger.warn(`Failed to set up recording UI: ${error}`);
    }
  }

  /**
   * Enter the bot name
   */
  private async enterName(): Promise<void> {
    if (!this.page) return;

    const nameSelectors = [
      '[data-tid="prejoin-display-name-input"]',
      '[data-tid="prejoin-name-input"]',
      'input[placeholder*="Enter name" i]',
      'input[placeholder*="Type your name" i]',
      'input[placeholder*="name" i]',
      'input[placeholder*="Entrez votre nom" i]',
      'input[placeholder*="Tapez votre nom" i]',
      'input[aria-label*="name" i]',
      'input[data-tid*="name" i]',
      '[role="textbox"][aria-label*="name" i]',
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

    await this.takeDebugScreenshot('name_input_not_found');
    throw new JoinError('Could not find name input field on Teams pre-join screen', true);
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
          if (
            ariaLabel?.toLowerCase().includes('turn camera on') ||
            ariaLabel?.toLowerCase().includes('activer la caméra')
          ) {
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
          if (ariaLabel?.toLowerCase().includes('unmute') || ariaLabel?.toLowerCase().includes('activer le micro')) {
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
      // Structural selectors (language-independent)
      '[data-tid="prejoin-join-button"]',
      '#prejoin-join-button',
      'button[data-tid*="join" i]',
      '.calling-prejoin-join-button',
      // aria-based (labels may vary by language but data-tid is primary)
      '[aria-label*="Join" i]',
      // Text fallbacks (last resort)
      'button:has-text("Join now")',
      'button:has-text("Join")',
    ];

    for (const selector of joinSelectors) {
      try {
        const joinBtn = await this.page.$(selector);
        if (joinBtn) {
          // Make sure the button is enabled
          const disabled = await joinBtn.getAttribute('disabled');
          const ariaDisabled = await joinBtn.getAttribute('aria-disabled');

          if (disabled !== null || ariaDisabled === 'true') {
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

    const deniedIndicators = [
      'text=You were denied access',
      'text=cannot join',
      'text=removed from the meeting',
      'text=The meeting has ended',
      'text=Access denied',
      'text=Meetings are just one tool in our belt',
      '[data-tid="lobby-denied"]',
      '[data-tid="calling-retry-screen-title"]',
      'button:has-text("Rejoin")',
    ] as const;

    const lobbyIndicators = [
      'text=Someone will let you in shortly',
      'text=Someone in the meeting should let you in',
      'text=Waiting for others to let you in',
      'text=waiting to be let in',
      'text=En attente',
      '[data-tid="lobby-screen"]',
      '.calling-lobby',
      '[data-tid="prejoin-waiting-room"]',
    ] as const;

    while (Date.now() - startTime < maxWaitTime) {
      // Use page.evaluate for reliable text detection (bypasses Playwright visibility)
      const lobbyState = await this.page
        .evaluate(() => {
          const bodyText = document.body?.textContent || '';

          // Denied detection
          const deniedPhrases = [
            'denied access',
            'cannot join',
            'removed from the meeting',
            'The meeting has ended',
            'Access denied',
            'Meetings are just one tool in our belt',
          ];
          for (const phrase of deniedPhrases) {
            if (bodyText.includes(phrase)) return 'denied';
          }
          if (document.querySelector('[data-tid="lobby-denied"], [data-tid="calling-retry-screen-title"]'))
            return 'denied';

          // "Rejoin" button means we were kicked — but ONLY if there's an
          // actual Rejoin button AND no hangup button (otherwise the word
          // "Rejoin" may appear in other contexts while still in lobby).
          const hasRejoinBtn = Array.from(
            document.querySelectorAll('button, [role="button"]'),
          ).some((el) => {
            const txt = (el as HTMLElement).textContent?.trim().toLowerCase();
            return txt === 'rejoin' || txt === 'rejoindre';
          });
          const hasHangup = !!document.querySelector(
            '[data-inp="hangup-button"], #hangup-button, [data-tid="hangup-button"]',
          );
          if (hasRejoinBtn && !hasHangup) return 'denied';

          // Meeting detection (admitted)
          if (document.querySelector('[data-inp="hangup-button"], #hangup-button, [data-tid="hangup-button"]'))
            return 'meeting';

          // Still in lobby — cover multiple wordings and locales
          const lobbyPhrases = [
            'will let you in',
            'should let you in',
            'waiting to be let in',
            'let you in soon',
            'En attente',
            'va bientôt vous admettre',
            'vous admettre dans la réunion',
            'Warten auf Zulassung',
            'Esperando a que alguien',
            'Waiting for the organizer',
          ];
          for (const phrase of lobbyPhrases) {
            if (bodyText.includes(phrase)) return 'lobby';
          }
          if (
            document.querySelector(
              '[data-tid="lobby-screen"], .calling-lobby, [data-tid="prejoin-waiting-room"], [data-tid="lobby-waiting"]',
            )
          ) {
            return 'lobby';
          }

          return 'unknown';
        })
        .catch(() => 'unknown');

      if (lobbyState === 'denied') {
        throw new JoinError('Bot was denied entry to the meeting', false);
      }

      // Use the evaluate result instead of separate hasAnySelector calls
      if (lobbyState === 'meeting') {
        logger.info('Successfully admitted to meeting');
        return;
      }

      // If we're no longer in lobby and not in meeting, something changed.
      // This can happen when Teams DOM transitions between lobby → meeting
      // and neither set of selectors matches momentarily.  Keep waiting
      // instead of bailing out — the next iteration will re-evaluate.
      if (lobbyState === 'unknown') {
        // Quick sanity check: if we're actually in the meeting already,
        // accept it and return.
        const inMeeting = await this.checkStillInMeeting();
        if (inMeeting) {
          logger.info('Successfully admitted to meeting');
          return;
        }
        // Otherwise stay in the loop — we may still be transitioning.
        // Only bail if we've been in "unknown" for a long time (handled
        // by the outer while timeout).
        logger.info('Lobby state unknown, continuing to wait...');
      }

      logger.info('Waiting to be admitted from lobby...');

      // Human-like behavior
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

  /**
   * Get participant count.
   *
   * Uses JavaScript evaluation to bypass the recording UI blanket overlay
   * (which hides DOM elements visually but they're still queryable via JS).
   * Also uses WebRTC-based detection as a fallback — if there are active
   * remote audio tracks, there must be other participants.
   */
  protected getCaptureMode(): 'x11grab' | 'webrtc' {
    // Teams v2 SPA does not expose video tracks via RTCPeerConnection.getReceivers()
    // so MediaRecorder-based WebRTC capture doesn't work yet. Using x11grab (screen
    // capture via FFmpeg) which works reliably. The WebRTC infrastructure is in place
    // and can be enabled once Teams v2 video track routing is reverse-engineered.
    return 'x11grab';
  }

  protected async getParticipantCount(): Promise<number> {
    // Use persisted roster count if available (most reliable — comes from
    // Teams WebSocket signaling, not fragile DOM queries)
    if (this.lastRosterParticipantCount !== null) {
      return this.lastRosterParticipantCount;
    }

    if (!this.page) return 0;

    try {
      const count = await this.page.evaluate(() => {
        // Method 1: Roster button text/aria-label (works even under blanket)
        const rosterSelectors = [
          '[data-tid="roster-button"]',
          '[aria-label*="participant" i]',
          '[aria-label*="people" i]',
          '[data-tid="people-button"]',
          'button[id="roster-button"]',
          // Teams v2 additional selectors
          '[data-tid="calling-roster-button"]',
          '[aria-label*="personne" i]',
          '[aria-label*="teilnehmer" i]',
        ];
        for (const sel of rosterSelectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            const text = btn.textContent || '';
            const match = text.match(/(\d+)/);
            if (match) return parseInt(match[1], 10);

            const label = btn.getAttribute('aria-label') || '';
            const labelMatch = label.match(/(\d+)/);
            if (labelMatch) return parseInt(labelMatch[1], 10);
          }
        }

        // Method 2: Count participant video streams
        const streams = document.querySelectorAll(
          '[data-stream-type="Video"], [data-cid="calling-participant-stream"], [data-test-segment-type="central"] video',
        );
        if (streams.length > 0) return streams.length;

        // Method 3: Check WebRTC connections for active remote audio tracks.
        // Even when video is off, audio tracks indicate other participants.
        try {
          const entries = (window as any).__aramisPeerConnections as
            | Array<{ pc: RTCPeerConnection; createdAt: number }>
            | undefined;
          if (entries && entries.length > 0) {
            let remoteAudioTracks = 0;
            for (const entry of entries) {
              const pc = entry.pc;
              if (pc.connectionState === 'closed') continue;
              for (const receiver of pc.getReceivers()) {
                if (receiver.track?.kind === 'audio' && !receiver.track.muted) {
                  remoteAudioTracks++;
                }
              }
            }
            if (remoteAudioTracks > 0) return remoteAudioTracks;
            // All PCs exist but 0 remote audio tracks → we're alone
            if (entries.some((e) => e.pc.connectionState === 'connected')) {
              return 1;
            }
          }
        } catch {
          // WebRTC check failed — continue to fallback
        }

        // Method 4: Check "You're the only one here" or similar alone indicators
        const bodyText = document.body?.textContent || '';
        const alonePhrases = [
          "You're the only one here",
          'only one in the meeting',
          'Vous êtes le seul',
          'seul dans la réunion',
          'Waiting for others to join',
          'En attente des autres',
        ];
        for (const phrase of alonePhrases) {
          if (bodyText.includes(phrase)) return 1;
        }

        // Method 5: Check if hangup button exists (means we're in a meeting)
        const hangup = document.querySelector(
          '[data-inp="hangup-button"], #hangup-button, [data-tid="hangup-button"]',
        );
        if (!hangup) return 0; // Not in meeting at all

        // Hangup exists but couldn't determine count — return -1 to signal
        // "unknown" so the zombie watchdog doesn't false-trigger
        return -1;
      });

      return count;
    } catch (error) {
      logger.warn(`Failed to get participant count: ${error}`);
      return -1;
    }
  }

  async checkMeetingEnded(): Promise<boolean> {
    if (!this.page) return true;

    if (!this.joinedSuccessfully) {
      return false;
    }

    // 30s grace period after joining to prevent false positives during DOM transitions
    if (this.joinedAt) {
      const timeInMeeting = Date.now() - this.joinedAt.getTime();
      if (timeInMeeting < 30000) return false;
    }

    // Priority 1: Check WebSocket signals from Teams (instant detection, no DOM needed)
    if (this.meetingSignal?.type === 'MeetingStatusChange') {
      const change = this.meetingSignal.change;
      if (change === 'meeting_ended' || change === 'request_to_join_denied' || change === 'anonymous_join_disabled') {
        logger.info(`Meeting ended via WebSocket signal: ${change}`);
        return true;
      }
    }

    // Priority 2: Roster-based detection (instant, from Teams WebSocket)
    // If roster shows 0 participants, the meeting is over
    if (this.lastRosterParticipantCount !== null && this.lastRosterParticipantCount === 0) {
      logger.info('Meeting ended: roster shows 0 active participants');
      return true;
    }
    // If roster previously had >1 participant (humans were present) and now <=1 (only bot left)
    if (
      this.lastRosterParticipantCount !== null &&
      this.lastRosterParticipantCount <= 1 &&
      this.lastKnownParticipantCount > 1
    ) {
      logger.info(
        `Meeting ended: all participants left (roster=${this.lastRosterParticipantCount}, peak=${this.lastKnownParticipantCount})`,
      );
      return true;
    }
    // Track peak participant count from roster and set flag to skip DOM-based count
    const hasRosterData = this.lastRosterParticipantCount !== null;
    if (hasRosterData && this.lastRosterParticipantCount! > this.lastKnownParticipantCount) {
      this.lastKnownParticipantCount = this.lastRosterParticipantCount!;
    }

    // Use page.evaluate() to check meeting end indicators directly in DOM.
    // This bypasses Playwright's visibility checks which fail when the
    // recording blanket overlay covers the UI elements.
    const meetingEndState = await this.page
      .evaluate(() => {
        // Check for end-of-meeting screen text (Attendee-validated selectors)
        const bodyText = document.body?.textContent || '';
        const endPhrases = [
          'The meeting has ended',
          'You left the meeting',
          'Call ended',
          'La réunion est terminée',
          'Meetings are just one tool in our belt',
          'Return to home screen',
          "You've been removed",
        ];
        for (const phrase of endPhrases) {
          if (bodyText.includes(phrase)) return { ended: true, reason: phrase };
        }

        // Check for Teams-specific end selectors
        if (document.getElementById('calling-retry-screen-title')) {
          return { ended: true, reason: 'calling-retry-screen-title found' };
        }
        if (document.querySelector('[data-tid="call-ended"], [data-tid="meeting-ended"]')) {
          return { ended: true, reason: 'call-ended/meeting-ended tid found' };
        }

        // Check if hangup button still exists (means still in meeting)
        const hangup = document.querySelector('[data-inp="hangup-button"], #hangup-button, [data-tid="hangup-button"]');

        // Check for a "Rejoin" button specifically (not just text anywhere in body).
        // Only treat as meeting-ended when a Rejoin button is found AND the hangup
        // button is gone, to avoid false positives from transient UI states.
        const allButtons = document.querySelectorAll('button, [role="button"]');
        let hasRejoinButton = false;
        for (const btn of allButtons) {
          const btnText = btn.textContent?.trim() || '';
          if (btnText === 'Rejoin' || btnText === 'Rejoindre') {
            hasRejoinButton = true;
            break;
          }
        }
        if (hasRejoinButton && !hangup) {
          return { ended: true, reason: 'Rejoin button present and hangup button gone' };
        }

        return { ended: false, hasHangup: !!hangup };
      })
      .catch(() => ({ ended: false, hasHangup: false }));

    if (meetingEndState.ended) {
      logger.info(`Meeting ended: ${(meetingEndState as any).reason}`);
      return true;
    }

    // If hangup button disappeared after 30s in meeting, we're no longer in it
    if (!meetingEndState.hasHangup && this.joinedAt) {
      const timeInMeeting = Date.now() - this.joinedAt.getTime();
      if (timeInMeeting > 30000) {
        logger.info('Meeting ended: hangup button disappeared (no longer in meeting)');
        return true;
      }
    }

    // Check URL
    const url = this.page.url();
    if (!url.includes('teams.microsoft.com') && !url.includes('teams.live.com')) {
      logger.info(`Meeting ended: URL changed to ${url}`);
      return true;
    }

    // Only check participant count after 30 seconds
    if (this.joinedAt) {
      const timeInMeeting = Date.now() - this.joinedAt.getTime();
      if (timeInMeeting < 30000) {
        return false;
      }
    }

    // DOM-based participant count: skip when roster data is available to avoid
    // inconsistent overwrites between the two tracking sources
    if (!hasRosterData) {
      const participantCount = await this.getParticipantCount();

      if (participantCount > this.lastKnownParticipantCount) {
        this.lastKnownParticipantCount = participantCount;
        logger.info(`Participant count updated: ${participantCount}`);
      }

      // Signal that meeting is over if bot is the only one left (no side effects)
      if (participantCount <= 1 && this.lastKnownParticipantCount > 1) {
        logger.info(
          `Meeting ended: Bot is the only participant left (count: ${participantCount}, peak: ${this.lastKnownParticipantCount})`,
        );
        return true;
      }

      // If participant count is 0 (hangup button gone), meeting ended
      if (participantCount === 0) {
        logger.info('Meeting ended: no participants detected (count=0)');
        return true;
      }
    }

    return false;
  }

  async checkStillInMeeting(): Promise<boolean> {
    if (!this.page) return false;

    // If the pre-join screen is still visible, we are NOT in the meeting
    if (await this.hasAnySelector(['[data-tid="prejoin-join-button"]'])) {
      return false;
    }

    // Check for meeting-only indicators (elements that do NOT exist on pre-join).
    // Hangup selectors use Attendee-validated data-inp and id attributes.
    const meetingIndicators = [
      '[data-inp="hangup-button"]',
      '#hangup-button',
      '[data-tid="hangup-button"]',
      '[data-tid="calling-unified-bar"]',
      '[data-tid="roster-button"]',
      '[data-tid="people-button"]',
      '[data-tid="video-gallery"]',
      '[data-tid="participant-gallery"]',
      '[data-tid="call-controls"]',
      '[data-tid="calling-audio-btn"]',
      '[data-tid="calling-user-video-tile"]',
      '[data-tid="self-video"]',
      '[data-tid="leave-btn"]',
      '.ts-calling-screen',
      '.calling-screen',
      '.calling-container',
    ] as const;

    if (await this.hasAnySelector(meetingIndicators)) {
      return true;
    }

    // Check URL
    const url = this.page.url();
    const inTeamsMeeting =
      (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) &&
      (url.includes('meetup-join') ||
        url.includes('/meeting/') ||
        url.includes('/l/meetup-join') ||
        url.includes('/meet/'));

    if (this.joinedSuccessfully && inTeamsMeeting) {
      return true;
    }

    return false;
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    logger.info('Leaving Teams meeting');

    // Stop fake activity
    try {
      await this.page.evaluate(() => {
        if ((window as any).__aramisFakeActivityInterval) {
          clearInterval((window as any).__aramisFakeActivityInterval);
          (window as any).__aramisFakeActivityInterval = null;
        }
      });
    } catch {}

    // Stop recording UI loop
    try {
      await this.page.evaluate(() => {
        (window as any).__aramisRecordingUIRunning = false;
      });
    } catch {}

    // Click hangup/leave button (Attendee-validated selectors first)
    const leaveSelectors = [
      '[data-inp="hangup-button"]',
      '#hangup-button',
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
