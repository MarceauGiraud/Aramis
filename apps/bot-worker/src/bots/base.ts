import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from '../lib/logger';
import { BOT_CONFIG, DEFAULT_BOT_KEYWORDS, RESOLUTION_MAP } from '@aramis/shared';
import type { RecordingConfig, RecordingView, MeetingPlatform } from '@aramis/shared';
import { RecordingOrchestrator, RecordingOrchestratorConfig, RecordingInfo } from '../lib/recording-orchestrator';
import { ChatCapturer, CapturedChatMessage } from '../lib/chat-capturer';
import { NativeSpeakerDetector, SpeakerEvent } from '../lib/native-speaker-detector';
import { PerParticipantAudioManager } from '../lib/per-participant-audio/manager';
import { PER_PARTICIPANT_AUDIO_SCRIPT } from '../lib/per-participant-audio/browser-inject';
import { uploadRecording } from '../lib/storage';
import { prisma } from '@aramis/database';

// Add stealth plugin to avoid bot detection
// Disable specific evasions that can cause issues
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

// -- Error classification --------------------------------------------------

export class JoinError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'JoinError';
    this.retryable = retryable;
  }
}

// -- Page state detection --------------------------------------------------

export type PageState =
  | 'PRE_JOIN'
  | 'IN_MEETING'
  | 'WAITING_ROOM'
  | 'LOGIN_REQUIRED'
  | 'ACCESS_DENIED'
  | 'ERROR_PAGE'
  | 'UNKNOWN';

// -- WebRTC state ----------------------------------------------------------

export interface WebRTCState {
  hasConnected: boolean;
  allDisconnected: boolean;
  remoteTrackCount: number;
}

export interface BotConfig {
  meetingId: string;
  meetingUrl: string;
  botName: string;
  platform?: MeetingPlatform;
  recordingConfig?: RecordingConfig;
  /** Xvfb display (e.g., ':99'). Allocated by DisplayAllocator. */
  display?: string;
  /** PulseAudio source for audio capture. Allocated by DisplayAllocator. */
  audioSource?: string;
}

export interface RecordingOptions {
  outputDir?: string;
  format?: 'webm' | 'mp4';
}

export interface BotOptions {
  headless?: boolean;
  debug?: boolean;
  screenshotDir?: string;
  /** Maximum recording duration in ms (overrides BOT_CONFIG.MAX_RECORDING_DURATION_MS) */
  maxRecordingDurationMs?: number;
  /** Silence timeout in ms before auto-leave (default: BOT_CONFIG.SILENCE_TIMEOUT_MS) */
  silenceTimeoutMs?: number;
  /** Waiting room timeout in ms (default: 5 min) */
  waitingRoomTimeoutMs?: number;
  /** Bot keywords to exclude from participant counts */
  botKeywords?: string[];
}

export abstract class BaseMeetingBot {
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected config: BotConfig;
  protected options: BotOptions;
  protected isRecording = false;
  protected recordingPath: string | null = null;
  protected startTime: Date | null = null;
  protected screenshotCounter = 0;
  protected recordingOrchestrator: RecordingOrchestrator | null = null;
  protected lastRecordingInfo: RecordingInfo | null = null;
  protected chatCapturer: ChatCapturer | null = null;
  protected speakerDetector: NativeSpeakerDetector | null = null;
  protected perParticipantManager: PerParticipantAudioManager | null = null;
  /** Timestamp (ms) when meeting content becomes visible (after waiting room transition) */
  protected meetingContentStartTime: number | null = null;
  /** Timestamp (ms) when the meeting end was detected (last participant left) */
  protected meetingEndDetectedTime: number | null = null;

  /** Set by subclasses once the bot has been admitted to the meeting */
  protected joinedSuccessfully = false;
  /** Set by subclasses when the bot joins the meeting */
  protected joinedAt: Date | null = null;

  // Auto-leave tracking
  protected lastAudioActivity: number = Date.now();

  // Zombie watchdog: track how long the bot has been alone
  private botAloneSince: number | null = null;
  private peakParticipantCount = 0;
  private static readonly ALONE_TIMEOUT_MS = 15 * 1000; // 15 seconds

  // Recording rotation: restart recording every 3 hours to avoid S3 file size limits
  private static readonly RECORDING_ROTATION_MS = 3 * 60 * 60 * 1000; // 3 hours
  private recordingSegmentIndex = 0;

  // Heartbeat interval
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  // Wakeup mechanism: allows WebSocket signals to interrupt the polling sleep
  private wakeupResolve: (() => void) | null = null;

  /** Accumulated Teams captions from WebSocket signals */
  protected captionSegments: Array<{ userId: string; text: string; timestamp: number; isFinal: boolean }> = [];

  // Latest meeting signal received from WebSocket (e.g., Teams CDN signals)
  protected meetingSignal: { type: string; change?: string; activeParticipantCount?: number } | null = null;
  // Persisted signal state (meetingSignal gets overwritten by each new signal)
  protected dominantSpeakerStreamId: number | null = null;
  protected lastRosterParticipantCount: number | null = null;

  constructor(config: BotConfig, options: BotOptions = {}) {
    this.config = config;
    this.options = {
      headless: options.headless ?? process.env.BOT_HEADLESS !== 'false',
      debug: options.debug ?? process.env.BOT_DEBUG === 'true',
      screenshotDir: options.screenshotDir ?? '/tmp/bot-screenshots',
      maxRecordingDurationMs: options.maxRecordingDurationMs,
      silenceTimeoutMs: options.silenceTimeoutMs ?? BOT_CONFIG.SILENCE_TIMEOUT_MS,
      waitingRoomTimeoutMs: options.waitingRoomTimeoutMs ?? 5 * 60 * 1000,
      botKeywords: options.botKeywords ?? [...DEFAULT_BOT_KEYWORDS],
    };
  }

  /**
   * Receive a meeting signal from the WebSocket server (e.g., Teams CDN signals).
   * Subclasses can inspect `this.meetingSignal` in checkMeetingEnded / getParticipantCount.
   */
  handleMeetingSignal(signal: { type: string; [key: string]: any }): void {
    this.meetingSignal = signal;
    if (signal.type === 'MeetingStatusChange') {
      logger.info(`Meeting signal: ${signal.change}`);
      this.triggerWakeup();
    } else if (signal.type === 'RosterUpdate') {
      this.lastRosterParticipantCount = signal.activeParticipantCount;
      if (signal.activeParticipantCount > this.peakParticipantCount) {
        this.peakParticipantCount = signal.activeParticipantCount;
      }
      logger.info(`Roster update: ${signal.activeParticipantCount} active (peak=${this.peakParticipantCount})`);
      this.triggerWakeup();
    } else if (signal.type === 'DominantSpeaker') {
      this.dominantSpeakerStreamId = signal.streamId;
      logger.info(`Dominant speaker: stream ${signal.streamId}`);
    } else if (signal.type === 'Caption') {
      if (signal.isFinal) {
        logger.info(`Caption [${signal.userId}]: ${signal.text}`);
      }
      if (signal.type === 'Caption' && signal.isFinal && signal.text) {
        this.captionSegments.push({
          userId: signal.userId || '',
          text: signal.text,
          timestamp: signal.timestamp || Date.now(),
          isFinal: true,
        });
      }
    } else if (signal.type === 'HumanSpeechDetected') {
      // Transcript received = humans are speaking in the meeting.
      // Only count after joinedSuccessfully to prevent lobby audio from
      // arming the zombie watchdog prematurely.
      if (this.peakParticipantCount < 2 && this.joinedSuccessfully) {
        this.peakParticipantCount = 2;
        logger.info('Human speech detected — peakParticipantCount set to 2');
      }
      return; // Don't overwrite meetingSignal with this internal signal
    }
    // Store all signals - subclasses access via this.meetingSignal
  }

  private createWakeupPromise(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeupResolve = resolve;
    });
  }

  private triggerWakeup(): void {
    if (this.wakeupResolve) {
      this.wakeupResolve();
      this.wakeupResolve = null;
    }
  }

  getCaptionSegments(): Array<{ userId: string; text: string; timestamp: number; isFinal: boolean }> {
    return this.captionSegments;
  }

  /**
   * Initialize the browser with stealth settings
   */
  async initialize(): Promise<void> {
    logger.info(`Initializing bot for meeting: ${this.config.meetingId}`);
    logger.info(`Bot options: headless=${this.options.headless}, debug=${this.options.debug}`);

    // Determine resolution from config
    const resolutionPreset = this.config.recordingConfig?.resolution ?? '720p';
    const resolution = RESOLUTION_MAP[resolutionPreset];

    // Set DISPLAY for Chromium to use the allocated Xvfb display
    const display = this.config.display || process.env.DISPLAY || ':99';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.browser = await (chromium as any).launch({
      headless: this.options.headless,
      // Use Google Chrome on x86_64 for H.264/AAC codec support.
      // On ARM64, Chrome for Testing is not available; we use the bundled
      // Chromium with chromium-codecs-ffmpeg-extra installed in Docker.
      ...(process.arch === 'x64' ? { channel: 'chrome' as const } : {}),
      env: {
        ...process.env,
        DISPLAY: display,
        // Force Chrome to output audio to this bot's dedicated PulseAudio sink,
        // avoiding the race condition where pactl set-default-sink is global.
        PULSE_SINK: this.config.audioSource?.replace('.monitor', '') || `virtual_speaker_${display.replace(':', '')}`,
        // Prevent Chrome from using any real microphone input (avoids feedback loop).
        // The source name must match what DisplayAllocator creates: virtual_silence_<N>
        PULSE_SOURCE: `virtual_silence_${display.replace(':', '')}`,
      },
      args: [
        '--incognito',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        // Auto-accept media permission prompts (camera/mic) without user interaction
        '--use-fake-ui-for-media-stream',
        // Do NOT use --use-fake-device-for-media-stream — it creates a recognizable
        // color-bar test pattern that Google Meet uses to flag the client as a bot.
        // Instead, we rely on the real (virtual) PulseAudio device from DisplayAllocator.
        // Do NOT use --disable-gpu — it causes black screenshots on Xvfb with SwiftShader
        '--enable-unsafe-swiftshader',
        // Use ANGLE with SwiftShader backend for better WebGL canvas rendering
        // (Google Meet renders video tiles via WebGL — plain SwiftShader can produce black canvases)
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
        '--autoplay-policy=no-user-gesture-required',
        // Kiosk mode removes ALL browser chrome (address bar, tabs, borders)
        // so FFmpeg captures only the page content when grabbing the Xvfb display.
        // Unlike --start-fullscreen, kiosk mode works reliably in Xvfb without a WM.
        '--kiosk',
        // Window size matches Xvfb (1280x830). The extra 110px height accommodates
        // Chrome's toolbar plus a safety margin. FFmpeg crops the measured chrome
        // height for clean output.
        `--window-size=${resolution.width},${resolution.height + 110}`,
        '--window-position=0,0',
        '--disable-infobars',
        // Disable CSP to allow our binary WebSocket (ws://localhost:8765)
        // for per-participant audio transport. Without this, Teams and Meet
        // block WebSocket connections to localhost via Content-Security-Policy.
        '--disable-features=IsolateOrigins,BlockInsecurePrivateNetworkRequests,AudioServiceSandbox',
        // Teams v2 SPA requires SharedArrayBuffer for its multi-threaded architecture.
        // Enable it without requiring cross-origin isolation headers.
        '--enable-features=SharedArrayBuffer',
        // PulseAudio integration for Teams audio capture
        '--use-pulseaudio',
        '--enable-webrtc-capture-audio',
        '--audio-buffer-size=2048',
        '--disable-background-timer-throttling',
        '--disable-external-intent-requests',
        // Do NOT use --disable-web-security — Google Meet detects it.
      ],
    });

    // Ensure recordings directory exists
    const recordingsDir = '/tmp/recordings';
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    // Use incognito context (video recording is now handled by FFmpeg/RecordingOrchestrator)
    this.context = await this.browser!.newContext({
      permissions: ['microphone', 'camera'],
      viewport: { width: resolution.width, height: resolution.height },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
    });

    this.page = await this.context.newPage();

    // Strip Content-Security-Policy headers to allow our binary WebSocket
    // (ws://localhost:8765) for per-participant audio transport.
    // IMPORTANT: Only intercept document/script responses, NOT WebSocket upgrades.
    await this.context.route('**/*', async (route) => {
      const resourceType = route.request().resourceType();
      // Skip WebSocket, media, and other non-document requests
      if (resourceType === 'websocket' || resourceType === 'media' || resourceType === 'eventsource') {
        await route.continue();
        return;
      }
      try {
        const response = await route.fetch();
        const headers = { ...response.headers() };
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        await route.fulfill({ response, headers });
      } catch {
        // If fetch fails (e.g., for blob: URLs), just continue normally
        await route.continue();
      }
    });

    // Disable external protocol handlers (msteams://, zoommtg://, etc.)
    // This prevents meeting platforms from redirecting to desktop app launchers.
    // Similar to Attendee's BrowserSwitcher Chrome policy approach.
    try {
      const cdpSession = await this.page.context().newCDPSession(this.page);
      await cdpSession.send('Browser.grantPermissions', {
        origin: '',
        permissions: ['audioCapture', 'videoCapture', 'displayCapture'],
      });
      // Bypass Content-Security-Policy entirely via CDP.
      // This is more reliable than stripping CSP headers via route interception,
      // which does not affect WebSocket upgrade requests. Without this, meeting
      // platforms (Meet, Teams) block ws://localhost:8765 connections.
      await cdpSession.send('Page.setBypassCSP', { enabled: true });
      logger.info('CSP bypass enabled via CDP Page.setBypassCSP');
    } catch (error) {
      logger.warn(`CDP permission grant failed (non-fatal): ${error}`);
    }

    // Log browser console messages for diagnostics.
    // Teams SPA produces many expected errors (401 for anonymous users, missing APIs)
    // that are normal and should not pollute our logs.
    const ignoredPatterns = [
      '401',
      'Unauthorized',
      'sensitivity',
      'SensitivityLabel',
      'pinnedChannels',
      'PinnedChannels',
      'AppsUsage',
      'getAppsUsage',
      'RemoteOperationFailed',
      'RequireStatusFailed',
      'store not initialized',
      'Discover::regionGtm',
      'consumerLicenses',
      'groupsServiceV2',
      'searchService',
      'TransformFailed',
      'Unexpected end of JSON',
      // Generic Teams SPA noise (anonymous user, missing APIs)
      '{"isTrusted":true}',
      "reading 'slice'",
      'unsupported MIME type',
      'ExpLoader',
      'sw registration fail',
    ];
    this.page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('[ARAMIS]')) {
        logger.info(`[WebRTC] ${text}`);
        // CSRC signals prove a human is speaking in the meeting.
        // Only count CSRC after the bot has actually joined — during lobby,
        // WebRTC audio tracks may already be active but the bot isn't in the
        // meeting yet. Setting peakParticipantCount=2 during lobby causes the
        // zombie watchdog to false-trigger as soon as recording starts.
        if (text.includes('New CSRC source:') && this.peakParticipantCount < 2 && this.joinedSuccessfully) {
          this.peakParticipantCount = 2;
          logger.info('CSRC detected — human in meeting (peak=2)');
        }
      } else if (msg.type() === 'error') {
        // Filter out expected Teams SPA errors
        if (!ignoredPatterns.some((p) => text.includes(p))) {
          logger.warn(`[Browser Console Error] ${text}`);
        }
      }
    });
    this.page.on('pageerror', (err) => {
      // Filter out expected Teams SPA page errors
      if (!ignoredPatterns.some((p) => err.message.includes(p))) {
        logger.warn(`[Browser Page Error] ${err.message}`);
      }
    });

    // Expose callback for per-participant audio chunks from browser (Google Meet only)
    if (this.config.platform === 'GOOGLE_MEET') {
      await this.page.exposeFunction('__aramisPerParticipantAudio', (csrcId: string, pcmBase64: string) => {
        // Receiving per-participant audio proves humans are in the meeting.
        // Guard with joinedSuccessfully to avoid arming zombie watchdog during lobby.
        if (this.peakParticipantCount < 2 && this.joinedSuccessfully) {
          this.peakParticipantCount = 2;
        }
        if (this.perParticipantManager) {
          this.perParticipantManager.handleAudioChunk(csrcId, pcmBase64);
        }
      });
    }

    // Comprehensive stealth scripts to avoid detection
    await this.page.addInitScript(() => {
      // Override webdriver detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Override plugins with realistic Chrome 133+ plugins
      // (Native Client was removed in Chrome 117)
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          ];
          return Object.assign(plugins, { length: plugins.length });
        },
      });

      // Override userAgentData (Chrome 133+ exposes this API, Google Meet checks it)
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: [
            { brand: 'Chromium', version: '133' },
            { brand: 'Not(A:Brand', version: '99' },
            { brand: 'Google Chrome', version: '133' },
          ],
          mobile: false,
          platform: 'macOS',
          getHighEntropyValues: (hints: string[]) =>
            Promise.resolve({
              brands: [
                { brand: 'Chromium', version: '133' },
                { brand: 'Not(A:Brand', version: '99' },
                { brand: 'Google Chrome', version: '133' },
              ],
              mobile: false,
              platform: 'macOS',
              platformVersion: '15.0.0',
              architecture: 'x86',
              bitness: '64',
              model: '',
              uaFullVersion: '133.0.6943.98',
              fullVersionList: [
                { brand: 'Chromium', version: '133.0.6943.98' },
                { brand: 'Not(A:Brand', version: '99.0.0.0' },
                { brand: 'Google Chrome', version: '133.0.6943.98' },
              ],
            }),
        }),
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Override hardware concurrency (CPU cores)
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
      });

      // Override device memory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
      });

      // Override platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'MacIntel',
      });

      // Override maxTouchPoints
      Object.defineProperty(navigator, 'maxTouchPoints', {
        get: () => 0,
      });

      // Override connection
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
        }),
      });

      // Remove automation indicators from window
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

      // Override chrome object
      (window as any).chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };

      // Override permissions query (must bind to preserve `this` context,
      // otherwise Google Meet gets "Illegal invocation" which breaks its JS)
      const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);

      // Override WebGL vendor and renderer
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
        if (parameter === 37445) {
          return 'Intel Inc.';
        }
        if (parameter === 37446) {
          return 'Intel Iris OpenGL Engine';
        }
        return getParameter.call(this, parameter);
      };

      // Track RTCPeerConnection instances for meeting state detection.
      // Must be injected before page load to capture all connections.
      // We store metadata per connection so callers can distinguish real
      // meeting connections from pre-join preview / analytics connections.
      (window as any).__aramisPeerConnections = [] as Array<{
        pc: RTCPeerConnection;
        connectionState: string;
        iceConnectionState: string;
        remoteTrackCount: number;
        hasRemoteAudio: boolean;
        hasRemoteVideo: boolean;
      }>;
      const OriginalRTCPeerConnection = window.RTCPeerConnection;
      (window as any).RTCPeerConnection = function (...args: any[]) {
        const pc = new OriginalRTCPeerConnection(...args);
        const entry = {
          pc,
          connectionState: pc.connectionState || 'new',
          iceConnectionState: pc.iceConnectionState || 'new',
          remoteTrackCount: 0,
          hasRemoteAudio: false,
          hasRemoteVideo: false,
        };
        (window as any).__aramisPeerConnections.push(entry);

        // Track connection state changes
        pc.addEventListener('connectionstatechange', () => {
          entry.connectionState = pc.connectionState;
        });
        pc.addEventListener('iceconnectionstatechange', () => {
          entry.iceConnectionState = pc.iceConnectionState;
        });

        // Track remote tracks added via ontrack
        pc.addEventListener('track', (event: RTCTrackEvent) => {
          entry.remoteTrackCount++;
          if (event.track.kind === 'audio') {
            entry.hasRemoteAudio = true;
            // Log audio track details for per-participant audio validation
            console.log(
              '[ARAMIS] Audio track received:',
              JSON.stringify({
                trackId: event.track.id,
                streamId: event.streams?.[0]?.id || 'no-stream',
                label: event.track.label,
                readyState: event.track.readyState,
                receiverTrackId: event.receiver?.track?.id,
              }),
            );

            // Store audio track reference for per-participant capture
            if (!(window as any).__aramisAudioTracks) {
              (window as any).__aramisAudioTracks = [];
            }
            (window as any).__aramisAudioTracks.push({
              track: event.track,
              receiver: event.receiver,
              streamId: event.streams?.[0]?.id,
              pc: pc,
            });
          }
          if (event.track.kind === 'video') entry.hasRemoteVideo = true;
        });

        return pc;
      };
      (window as any).RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

      // Intercept getContributingSources() to track CSRC → speaker mapping
      const origGetCS = RTCRtpReceiver.prototype.getContributingSources;
      RTCRtpReceiver.prototype.getContributingSources = function () {
        const result = origGetCS.call(this);
        if (result.length > 0) {
          if (!(window as any).__aramisCSRCMap) {
            (window as any).__aramisCSRCMap = {};
            (window as any).__aramisCSRCLog = [];
          }
          for (const source of result) {
            const key = String(source.source);
            const prev = (window as any).__aramisCSRCMap[key];
            (window as any).__aramisCSRCMap[key] = source.audioLevel;
            // Log new CSRC sources (only first occurrence)
            if (prev === undefined) {
              const logEntry = { csrc: source.source, audioLevel: source.audioLevel, timestamp: Date.now() };
              (window as any).__aramisCSRCLog.push(logEntry);
              console.log('[ARAMIS] New CSRC source:', JSON.stringify(logEntry));
            }
          }
        }
        return result;
      };
    });

    // Inject per-participant audio capture script (Google Meet only).
    // The script intercepts WebRTC CSRC sources and uses MediaStreamTrackProcessor
    // to extract per-speaker audio. This relies on Google Meet's protobuf data
    // channels for participant names and crashes on other platforms (Teams, Zoom).
    if (this.config.platform === 'GOOGLE_MEET') {
      await this.page.addInitScript(PER_PARTICIPANT_AUDIO_SCRIPT);
      await this.page.addInitScript(`window.__aramisMeetingId = '${this.config.meetingId}';`);
    }

    // Initialize the recording orchestrator (uses FFmpeg for video/audio capture)
    const recordingConfig = this.config.recordingConfig;
    this.recordingOrchestrator = new RecordingOrchestrator({
      meetingId: this.config.meetingId,
      display: this.config.display || process.env.DISPLAY || ':99',
      audioSource: this.config.audioSource || process.env.PULSE_SOURCE || 'default',
      tempDir: recordingsDir,
      resolution: { width: resolution.width, height: resolution.height },
      frameRate: 24,
      enableLiveUpload: true,
      format: recordingConfig?.format ?? 'mp4',
      resolutionPreset: recordingConfig?.resolution ?? '720p',
      captureMode: this.getCaptureMode(),
    });

    // Set up recording event handlers
    this.setupRecordingEventHandlers();
  }

  /**
   * Set up event handlers for the recording orchestrator
   */
  private setupRecordingEventHandlers(): void {
    if (!this.recordingOrchestrator) return;

    this.recordingOrchestrator.on('chunk-uploaded', (event) => {
      logger.info(`Chunk uploaded: ${event.s3Url} (${event.size} bytes, type: ${event.type})`);
    });

    this.recordingOrchestrator.on('recording-complete', (event) => {
      logger.info(`Recording complete: ${event.duration}s (format: ${event.format})`);
      if (event.videoUrl) logger.info(`  Video: ${event.videoUrl}`);
      if (event.audioUrl) logger.info(`  Audio: ${event.audioUrl}`);
      if (event.mergedUrl) logger.info(`  Merged: ${event.mergedUrl}`);
    });

    this.recordingOrchestrator.on('error', (event) => {
      logger.error(`Recording error in ${event.phase}: ${event.error.message}`);
      if (!event.recoverable) {
        logger.error('Non-recoverable recording error - recording may be incomplete');
      }
    });
  }

  // ========================================================================
  // SHARED UTILITIES (available to all platform bots)
  // ========================================================================

  /**
   * Check if any of the given selectors matches an element on the page.
   */
  protected async hasAnySelector(selectors: readonly string[]): Promise<boolean> {
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

  /**
   * Query WebRTC peer connection state from the page context.
   * Uses the `window.__aramisPeerConnections` array installed by addInitScript.
   */
  protected async getWebRTCState(): Promise<WebRTCState> {
    if (!this.page) return { hasConnected: false, allDisconnected: false, remoteTrackCount: 0 };

    try {
      return await this.page.evaluate(() => {
        const entries = (window as any).__aramisPeerConnections as
          | Array<{
              pc: RTCPeerConnection;
              connectionState: string;
              iceConnectionState: string;
              remoteTrackCount: number;
              hasRemoteAudio: boolean;
              hasRemoteVideo: boolean;
            }>
          | undefined;
        if (!entries || entries.length === 0) {
          return { hasConnected: false, allDisconnected: false, remoteTrackCount: 0 };
        }

        let remoteTrackCount = 0;
        let hasConnectedConnection = false;
        let allDisconnected = true;

        for (const entry of entries) {
          const pc = entry.pc;
          const state = entry.connectionState || pc.connectionState;

          // A connection is only "meeting-ready" if it is connected AND
          // has received remote media tracks via the ontrack event.
          const isConnected = state === 'connected';
          const hasRemoteTracks = entry.remoteTrackCount > 0;

          if (isConnected && hasRemoteTracks) {
            hasConnectedConnection = true;
            // Count actual live receivers with non-null tracks for accuracy
            const receivers = pc.getReceivers ? pc.getReceivers() : [];
            remoteTrackCount += receivers.filter(
              (r: RTCRtpReceiver) => r.track && r.track.readyState === 'live',
            ).length;
          }

          // Track whether ALL connections are dead (for disconnect detection)
          if (state !== 'disconnected' && state !== 'closed' && state !== 'failed') {
            allDisconnected = false;
          }
        }

        return {
          hasConnected: hasConnectedConnection,
          allDisconnected,
          remoteTrackCount,
        };
      });
    } catch {
      return { hasConnected: false, allDisconnected: false, remoteTrackCount: 0 };
    }
  }

  /**
   * Wait for at least one WebRTC connection with remote tracks to be ready.
   * The RTCPeerConnection hook is already installed via addInitScript;
   * this method just polls the existing state.
   */
  protected async waitForWebRTCReady(): Promise<void> {
    if (!this.page) return;

    // Wait up to 10s for a truly connected connection with remote tracks
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await this.getWebRTCState();
      if (state.hasConnected && state.remoteTrackCount > 0) {
        logger.info(`WebRTC ready: ${state.remoteTrackCount} remote tracks`);
        return;
      }
      await this.sleep(250);
    }
    logger.warn('WebRTC ready timeout - proceeding anyway');
  }

  /**
   * Join the meeting - implemented by each platform bot
   */
  abstract join(): Promise<void>;

  /**
   * Start recording the meeting using FFmpeg via RecordingOrchestrator.
   * If noRecording mode is enabled, only starts chat capturer and speaker tracking.
   */
  async startRecording(options: RecordingOptions = {}): Promise<void> {
    const noRecording = this.config.recordingConfig?.noRecording === true;

    // Start chat capturer regardless of recording mode
    if (this.page && this.config.platform) {
      this.chatCapturer = new ChatCapturer(this.page, this.config.platform);
      this.chatCapturer.start();
    }

    // Start speaker detection (non-fatal if it fails)
    if (this.page && this.config.platform) {
      try {
        this.speakerDetector = new NativeSpeakerDetector(this.page, this.config.platform);
        await this.speakerDetector.start();

        // Use speaker changes as audio activity signal for silence detection
        this.speakerDetector.on('speakerChange', () => {
          this.updateAudioActivity();
        });

        logger.info('Speaker detection started');
      } catch (error) {
        logger.warn(`Failed to start speaker detector (non-fatal): ${error}`);
        this.speakerDetector = null;
      }
    }

    if (noRecording) {
      logger.info(`No-recording mode: skipping recording for meeting ${this.config.meetingId}`);
      this.isRecording = false;
      this.startTime = new Date();
      return;
    }

    if (!this.recordingOrchestrator) {
      throw new Error('Recording orchestrator not initialized');
    }

    logger.info(`Starting recording for meeting: ${this.config.meetingId}`);

    // Measure the exact browser chrome height (address bar, tabs) so FFmpeg
    // can crop it precisely. This is dynamic and works across Chrome versions.
    if (this.page) {
      try {
        const metrics = await this.page.evaluate(() => {
          return {
            outerHeight: window.outerHeight,
            innerHeight: window.innerHeight,
            screenY: window.screenY,
            chromeHeight: window.outerHeight - window.innerHeight,
          };
        });
        logger.info(
          `Browser metrics: outerH=${metrics.outerHeight}, innerH=${metrics.innerHeight}, screenY=${metrics.screenY}, chromeH=${metrics.chromeHeight}px`,
        );
        // Use screenY if available (more accurate — gives exact Y offset of viewport in display).
        // Add a small offset (+5px) to compensate for sub-pixel rendering and matchbox WM
        // borders that cause a few pixels of browser chrome to leak into the recording.
        const CROP_SAFETY_OFFSET = 5;
        const baseCropHeight = metrics.screenY > 0 ? metrics.screenY : metrics.chromeHeight;
        const cropHeight = baseCropHeight + CROP_SAFETY_OFFSET;
        if (cropHeight > 0 && cropHeight < 200) {
          this.recordingOrchestrator.setChromeHeight(cropHeight);
          logger.info(`Using crop height: ${cropHeight}px (base=${baseCropHeight}, offset=+${CROP_SAFETY_OFFSET})`);
        }
      } catch {}
    }

    await this.recordingOrchestrator.start();

    this.isRecording = true;
    this.startTime = new Date();
    this.lastAudioActivity = Date.now();

    // Start per-participant audio capture (Google Meet only).
    // Other platforms use mixed audio transcription via FFmpeg/PulseAudio.
    if (this.config.platform === 'GOOGLE_MEET')
      try {
        this.perParticipantManager = new PerParticipantAudioManager({
          meetingId: this.config.meetingId,
          language: (this.config.recordingConfig as any)?.language,
        });
        await this.perParticipantManager.start(this.page!);
        logger.info('Per-participant audio capture started');
      } catch (error) {
        logger.warn(`Per-participant audio capture failed (falling back to mixed): ${error}`);
        this.perParticipantManager = null;
      }

    // Start heartbeat
    this.startHeartbeat();

    logger.info('Recording started');
  }

  /**
   * Stop recording and save the file
   */
  async stopRecording(): Promise<string | null> {
    if (!this.isRecording || !this.recordingOrchestrator) {
      return null;
    }

    logger.info('Stopping recording...');

    // Stop speaker detector before stopping recording
    if (this.speakerDetector) {
      try {
        await this.speakerDetector.stop();
      } catch (error) {
        logger.warn(`Failed to stop speaker detector: ${error}`);
      }
    }

    // Stop per-participant audio manager before stopping recording
    if (this.perParticipantManager) {
      try {
        await this.perParticipantManager.stop();
      } catch (error) {
        logger.warn(`Failed to stop per-participant audio manager: ${error}`);
      }
      this.perParticipantManager = null;
    }

    // Calculate trim: remove waiting room frames from the start of the recording.
    // The recording starts immediately at admission, but the meeting content
    // (participant tiles visible) may appear a few seconds later.
    let trimStartSeconds: number | undefined;
    if (this.meetingContentStartTime && this.recordingOrchestrator.getStartTime()) {
      const recordingStartMs = this.recordingOrchestrator.getStartTime()!.getTime();
      const trimMs = this.meetingContentStartTime - recordingStartMs;
      if (trimMs > 1000) {
        // Only trim if > 1 second of waiting room
        trimStartSeconds = trimMs / 1000;
        logger.info(`Will trim ${trimStartSeconds.toFixed(1)}s of waiting room from recording start`);
      }
    }

    // Fallback: if meetingContentStartTime was never set (UI detection timed out),
    // use the gap between recording start and startTime (when bot joined the meeting)
    if (!trimStartSeconds && this.startTime && this.recordingOrchestrator.getStartTime()) {
      const recordingStartMs = this.recordingOrchestrator.getStartTime()!.getTime();
      const joinMs = this.startTime.getTime();
      const fallbackTrimMs = joinMs - recordingStartMs;
      if (fallbackTrimMs > 500) {
        trimStartSeconds = fallbackTrimMs / 1000;
        logger.info(`Using fallback trim of ${trimStartSeconds.toFixed(1)}s (startTime - recordingStart)`);
      }
    }

    // Calculate end trim: remove frames after the last participant left.
    let trimEndSeconds: number | undefined;
    if (this.meetingEndDetectedTime && this.recordingOrchestrator.getStartTime()) {
      const recordingStartMs = this.recordingOrchestrator.getStartTime()!.getTime();
      const contentDurationMs = this.meetingEndDetectedTime - recordingStartMs;
      // Apply start trim to get the actual content duration
      const startTrimMs = (trimStartSeconds ?? 0) * 1000;
      const trimmedDurationMs = contentDurationMs - startTrimMs;
      if (trimmedDurationMs > 1000) {
        trimEndSeconds = trimmedDurationMs / 1000;
        logger.info(`Will trim end of recording at ${trimEndSeconds.toFixed(1)}s (meeting ended)`);
      }
    }

    // Guard: prevent over-trimming short recordings
    if (trimStartSeconds !== undefined || trimEndSeconds !== undefined) {
      const recordingStartMs = this.recordingOrchestrator.getStartTime()!.getTime();
      const totalRecordingDurationSec = (Date.now() - recordingStartMs) / 1000;

      // If start trim would remove 80%+ of the recording, skip it
      if (trimStartSeconds !== undefined && trimStartSeconds > totalRecordingDurationSec * 0.8) {
        logger.warn(
          `Skipping start trim: ${trimStartSeconds.toFixed(1)}s exceeds 80% of total recording (${totalRecordingDurationSec.toFixed(1)}s)`,
        );
        trimStartSeconds = undefined;
      }

      // Compute effective duration after trimming.
      // trimEndSeconds is already the duration AFTER start trim
      // (contentDurationMs - startTrimMs) / 1000, so don't subtract again.
      let effectiveDuration: number;
      if (trimEndSeconds !== undefined) {
        effectiveDuration = trimEndSeconds;
      } else {
        effectiveDuration = totalRecordingDurationSec - (trimStartSeconds ?? 0);
      }

      if (effectiveDuration < 5) {
        logger.warn(
          `Skipping trim: resulting duration would be too short (${effectiveDuration.toFixed(1)}s), keeping full recording`,
        );
        trimStartSeconds = undefined;
        trimEndSeconds = undefined;
      }
    }

    // Stop the orchestrator with merge, trim, and upload
    this.lastRecordingInfo = await this.recordingOrchestrator.stop({
      merge: true,
      upload: true,
      cleanup: true,
      trimStartSeconds,
      trimEndSeconds,
    });

    this.isRecording = false;

    // Return the best available URL (S3 merged > S3 video > local path)
    this.recordingPath =
      this.lastRecordingInfo.s3MergedUrl ??
      this.lastRecordingInfo.s3VideoUrl ??
      this.lastRecordingInfo.mergedPath ??
      this.lastRecordingInfo.videoPath;

    logger.info(`Recording saved: ${this.recordingPath}`);

    return this.recordingPath;
  }

  /**
   * Pause the recording
   */
  pauseRecording(): void {
    if (!this.recordingOrchestrator) {
      logger.warn('Cannot pause: no recording orchestrator');
      return;
    }

    this.recordingOrchestrator.pause();
  }

  /**
   * Resume the recording
   */
  resumeRecording(): void {
    if (!this.recordingOrchestrator) {
      logger.warn('Cannot resume: no recording orchestrator');
      return;
    }

    this.recordingOrchestrator.resume();
  }

  /**
   * Rotate recording: stop current segment, save it, and start a new one.
   * This prevents hitting S3 file size limits on long meetings.
   */
  async rotateRecording(): Promise<RecordingInfo | null> {
    const currentSegment = this.recordingSegmentIndex;
    logger.info(`Recording rotation: saving segment ${currentSegment}, starting segment ${currentSegment + 1}`);

    // Stop current recording segment
    await this.stopRecording();
    const segmentInfo = this.lastRecordingInfo;

    this.recordingSegmentIndex++;

    // Reset orchestrator state so it can be started again
    if (this.recordingOrchestrator) {
      this.recordingOrchestrator.reset();
    }

    // Brief pause to ensure clean separation between segments
    await this.sleep(2000);

    // Start new recording segment
    await this.startRecording();

    logger.info(`Recording rotation: segment ${currentSegment} saved, started segment ${currentSegment + 1}`);
    return segmentInfo;
  }

  /**
   * Wait for the meeting to end with enhanced auto-leave conditions
   */
  async waitForEnd(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const maxDuration = this.options.maxRecordingDurationMs ?? BOT_CONFIG.MAX_RECORDING_DURATION_MS;
    const checkInterval = BOT_CONFIG.RECORDING_CHECK_INTERVAL_MS;
    const startTime = Date.now();

    while (Date.now() - startTime < maxDuration) {
      // Check if meeting has ended (platform-specific)
      const ended = await this.checkMeetingEnded();
      if (ended) {
        this.meetingEndDetectedTime = Date.now();
        logger.info('Meeting has ended');
        break;
      }

      // Check if we're still in the meeting
      const inMeeting = await this.checkStillInMeeting();
      if (!inMeeting) {
        this.meetingEndDetectedTime = Date.now();
        logger.info('Bot is no longer in meeting');
        break;
      }

      // Zombie watchdog: auto-leave if alone for too long.
      // Only activates AFTER at least one human was in the meeting and left.
      const participantCount = await this.getHumanParticipantCount();
      if (participantCount > 1) {
        // Humans present — reset timer and record that we had humans
        if (this.botAloneSince !== null) {
          logger.info('Zombie watchdog: other participants detected, resetting timer');
        }
        this.botAloneSince = null;
        this.peakParticipantCount = Math.max(this.peakParticipantCount, participantCount);
      } else if (participantCount >= 0 && participantCount <= 1 && this.peakParticipantCount > 1) {
        // participantCount === -1 means "unknown" — skip watchdog to avoid false triggers
        // Was >1 before, now <=1 — humans left, start/check timer
        if (this.botAloneSince === null) {
          this.botAloneSince = Date.now();
          logger.info(
            `Zombie watchdog: all humans left (count=${participantCount}, peak=${this.peakParticipantCount}), starting ${BaseMeetingBot.ALONE_TIMEOUT_MS / 1000}s timer`,
          );
        } else if (Date.now() - this.botAloneSince > BaseMeetingBot.ALONE_TIMEOUT_MS) {
          this.meetingEndDetectedTime = this.botAloneSince;
          logger.info(`Zombie watchdog: bot alone for ${BaseMeetingBot.ALONE_TIMEOUT_MS / 1000}s, auto-leaving`);
          break;
        }
      }
      // If peakParticipantCount <= 1, nobody has joined yet — don't start timer

      // Recording rotation: save and restart recording every 3 hours
      if (this.isRecording && this.startTime) {
        const recordingDuration = Date.now() - this.startTime.getTime();
        if (recordingDuration >= BaseMeetingBot.RECORDING_ROTATION_MS) {
          logger.info(`Recording rotation triggered after ${Math.round(recordingDuration / 60000)} minutes`);
          await this.rotateRecording();
        }
      }

      // Max uptime check
      if (Date.now() - startTime >= maxDuration) {
        logger.info(`Max recording duration reached (${Math.floor(maxDuration / 1000)}s), leaving`);
        break;
      }

      // NOTE: Silence-based auto-leave has been disabled.
      // The NativeSpeakerDetector relies on fragile DOM selectors that frequently
      // break when Google Meet updates its UI, causing false "silence" detection
      // even when participants are actively speaking (Deepgram transcribes speech
      // but the DOM speaker detector reports 0 speakers).
      // The checkMeetingEnded() method already handles all legitimate leave
      // conditions: WebRTC disconnection, participant count dropping to 1,
      // "alone" UI indicators, kicked indicators, and URL changes.

      const wakeup = this.createWakeupPromise();
      await Promise.race([this.sleep(checkInterval), wakeup]);
    }
  }

  /**
   * Update the last audio activity timestamp.
   * Should be called by speaker detectors or audio monitors.
   */
  updateAudioActivity(): void {
    this.lastAudioActivity = Date.now();
  }

  /**
   * Check if a participant name matches a known bot keyword
   */
  protected isKnownBot(participantName: string): boolean {
    const botKeywords = this.options.botKeywords ?? [...DEFAULT_BOT_KEYWORDS];
    const lowerName = participantName.toLowerCase();
    return botKeywords.some((keyword) => lowerName.includes(keyword.toLowerCase()));
  }

  /**
   * Return the current participant count for zombie watchdog.
   * Returns -1 by default (unknown). Platform bots should override this.
   */
  protected async getParticipantCount(): Promise<number> {
    return -1;
  }

  /**
   * Get participant count excluding known recording bots.
   * Used by the zombie watchdog to detect when only bots remain.
   */
  protected getHumanParticipantCount(): Promise<number> {
    // Default: same as getParticipantCount (subclasses can override)
    return this.getParticipantCount();
  }

  /**
   * Check if the meeting has ended - implemented by each platform bot
   */
  abstract checkMeetingEnded(): Promise<boolean>;

  /**
   * Check if still in meeting - implemented by each platform bot
   */
  abstract checkStillInMeeting(): Promise<boolean>;

  /**
   * Save the recording and return the path/URL
   * The orchestrator handles S3 upload, so this returns the S3 URL if available
   */
  async saveRecording(): Promise<string> {
    await this.stopRecording();

    if (!this.recordingPath) {
      throw new Error('No recording available');
    }

    return this.recordingPath;
  }

  /**
   * Check if the bot is currently recording.
   * Public accessor for the protected isRecording flag.
   */
  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Get the full recording info (includes separate audio URL for transcription)
   */
  getRecordingInfo(): RecordingInfo | null {
    return this.lastRecordingInfo;
  }

  /**
   * Get captured chat messages
   */
  getChatMessages(): CapturedChatMessage[] {
    return this.chatCapturer?.getMessages() ?? [];
  }

  /**
   * Get DOM-detected speaker history for reconciliation with transcription diarization
   */
  getSpeakerHistory(): SpeakerEvent[] {
    return this.speakerDetector?.getSpeakerHistory() ?? [];
  }

  /** Get the capture mode for video recording. Override in platform bots. */
  protected getCaptureMode(): 'x11grab' | 'webrtc' {
    return 'x11grab'; // Default for Meet and other platforms
  }

  /**
   * Get the recording orchestrator instance.
   */
  getRecordingOrchestrator(): RecordingOrchestrator | null {
    return this.recordingOrchestrator;
  }

  /**
   * Get the per-participant audio manager (for speaker-attributed transcription)
   */
  getPerParticipantManager(): PerParticipantAudioManager | null {
    return this.perParticipantManager;
  }

  /**
   * Extract participant details from the meeting platform's DOM.
   * Override in platform-specific bots to provide richer data.
   * Falls back to speaker history names if not overridden.
   */
  async extractParticipants(): Promise<{ name: string; email?: string; isHost?: boolean }[]> {
    // Default implementation: derive from speaker history
    const history = this.getSpeakerHistory();
    const seen = new Set<string>();
    const participants: { name: string; email?: string; isHost?: boolean }[] = [];
    for (const event of history) {
      if (!seen.has(event.speaker)) {
        seen.add(event.speaker);
        participants.push({ name: event.speaker, isHost: false });
      }
    }
    return participants;
  }

  /**
   * Leave the meeting
   */
  abstract leave(): Promise<void>;

  /**
   * Start heartbeat interval for bot session tracking
   */
  private startHeartbeat(): void {
    // Heartbeat is managed by the worker, but we expose a hook
    // The interval is started in index.ts after startRecording
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up bot resources');

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Stop chat capturer
    if (this.chatCapturer) {
      this.chatCapturer.stop();
      this.chatCapturer = null;
    }

    // Stop speaker detector
    if (this.speakerDetector) {
      try {
        await this.speakerDetector.stop();
      } catch {
        /* ignore */
      }
      this.speakerDetector = null;
    }

    // Stop per-participant audio manager
    if (this.perParticipantManager) {
      try {
        await this.perParticipantManager.stop();
      } catch {
        /* ignore */
      }
      this.perParticipantManager = null;
    }

    // Gracefully stop recording first (merge/upload chunks) before force-killing FFmpeg
    if (this.isRecording) {
      try {
        await this.stopRecording();
      } catch (error) {
        logger.warn(`Error during graceful stopRecording: ${error}`);
      }
    }

    // Force cleanup recording orchestrator as a safety net (kills any remaining FFmpeg processes)
    if (this.recordingOrchestrator?.isRecording() || this.recordingOrchestrator?.isPaused()) {
      try {
        await this.recordingOrchestrator.forceCleanup();
      } catch (error) {
        logger.warn(`Error during recording force cleanup: ${error}`);
      }
    }

    // Page may already be closed by stopRecording
    if (this.page) {
      try {
        await this.page.close();
      } catch {
        // Page already closed
      }
      this.page = null;
    }

    if (this.context) {
      await this.context.close().catch(() => {});
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
    }

    this.page = null;
    this.context = null;
    this.browser = null;
  }

  /**
   * Capture a screenshot, upload to S3, and store URL in BotLog.
   * Used for debugging join failures and other errors.
   */
  async captureScreenshot(reason: string = 'debug'): Promise<string | null> {
    if (!this.page) return null;

    try {
      const timestamp = Date.now();
      const filename = `screenshot_${this.config.meetingId}_${timestamp}_${reason}.png`;
      const localPath = path.join('/tmp/recordings', filename);

      await this.page.screenshot({ path: localPath, fullPage: true });
      logger.info(`Screenshot captured: ${localPath}`);

      // Upload to S3 if configured
      let s3Url: string | null = null;
      try {
        s3Url = await uploadRecording(localPath, this.config.meetingId);
      } catch {
        logger.warn('Could not upload screenshot to S3');
      }

      // Store in BotLog if bot session exists
      try {
        const session = await prisma.botSession.findUnique({
          where: { meetingId: this.config.meetingId },
        });
        if (session) {
          await prisma.botLog.create({
            data: {
              botSessionId: session.id,
              level: 'INFO',
              message: `Screenshot captured: ${reason}`,
              metadata: {
                screenshotUrl: s3Url || localPath,
                reason,
                timestamp: new Date().toISOString(),
              },
            },
          });
        }
      } catch {
        // Best effort logging
      }

      return s3Url || localPath;
    } catch (error) {
      logger.warn(`Failed to capture screenshot: ${error}`);
      return null;
    }
  }

  /**
   * Capture MHTML page content, upload to S3, and store URL in BotLog.
   */
  async captureMhtml(reason: string = 'debug'): Promise<string | null> {
    if (!this.page) return null;

    try {
      const timestamp = Date.now();
      const filename = `page_${this.config.meetingId}_${timestamp}_${reason}.html`;
      const localPath = path.join('/tmp/recordings', filename);

      const content = await this.page.content();
      fs.writeFileSync(localPath, content, 'utf8');
      logger.info(`Page content captured: ${localPath}`);

      // Upload to S3 if configured
      let s3Url: string | null = null;
      try {
        s3Url = await uploadRecording(localPath, this.config.meetingId);
      } catch {
        logger.warn('Could not upload page content to S3');
      }

      // Store in BotLog
      try {
        const session = await prisma.botSession.findUnique({
          where: { meetingId: this.config.meetingId },
        });
        if (session) {
          await prisma.botLog.create({
            data: {
              botSessionId: session.id,
              level: 'INFO',
              message: `Page content captured: ${reason}`,
              metadata: {
                contentUrl: s3Url || localPath,
                reason,
                timestamp: new Date().toISOString(),
              },
            },
          });
        }
      } catch {
        // Best effort logging
      }

      return s3Url || localPath;
    } catch (error) {
      logger.warn(`Failed to capture page content: ${error}`);
      return null;
    }
  }

  /**
   * Helper to sleep for a given time
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Take a debug screenshot (only if debug mode is enabled).
   *
   * If the Playwright screenshot is suspiciously small (< 10 KB, typically a
   * solid-black frame), we also capture the raw X11 framebuffer via
   * ImageMagick's `import` command as a fallback.  Additionally, we log the
   * visible page text so that even black screenshots give us useful debug data.
   */
  protected async takeDebugScreenshot(name: string): Promise<void> {
    if (!this.options.debug || !this.page) return;

    try {
      const dir = this.options.screenshotDir!;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.screenshotCounter++;
      const prefix = `${this.config.meetingId}_${this.screenshotCounter.toString().padStart(3, '0')}_${name}`;
      const filepath = path.join(dir, `${prefix}.png`);

      await this.page.screenshot({ path: filepath, fullPage: true });

      const stats = fs.statSync(filepath);
      logger.info(`Screenshot saved: ${filepath} (${stats.size} bytes)`);

      // If the screenshot is suspiciously small (< 10 KB = likely solid black),
      // capture the raw Xvfb framebuffer as a fallback and log page text.
      if (stats.size < 10_000) {
        logger.warn(
          `Screenshot "${name}" is only ${stats.size} bytes — likely a black frame. ` +
            'Capturing Xvfb framebuffer fallback and page text.',
        );

        // Capture Xvfb framebuffer via ImageMagick import
        try {
          const display = this.config.display || process.env.DISPLAY || ':99';
          const xvfbPath = path.join(dir, `${prefix}_xvfb.png`);
          execSync(`import -display ${display} -window root ${xvfbPath}`, { timeout: 5000 });
          const xvfbStats = fs.statSync(xvfbPath);
          logger.info(`Xvfb framebuffer screenshot saved: ${xvfbPath} (${xvfbStats.size} bytes)`);
        } catch (xvfbError) {
          logger.warn(`Xvfb framebuffer capture failed: ${xvfbError}`);
        }

        // Log the visible page text for debugging even when the screenshot is black
        try {
          const bodyText = await this.page.evaluate(() => {
            return document.body?.innerText?.substring(0, 500) || '(empty body)';
          });
          logger.info(`Page text at "${name}": ${bodyText.replace(/\n/g, ' | ')}`);
        } catch (evalError) {
          logger.warn(`Failed to read page text: ${evalError}`);
        }

        // Also log the current URL and title
        try {
          const url = this.page.url();
          const title = await this.page.title();
          logger.info(`Page URL at "${name}": ${url}`);
          logger.info(`Page title at "${name}": ${title}`);
        } catch {
          // best effort
        }
      }
    } catch (error) {
      logger.warn(`Failed to take screenshot: ${error}`);
    }
  }

  /**
   * Re-attach page-level listeners and CDP settings after a page swap.
   * Call this whenever `this.page` is replaced (e.g., Teams new-tab flow).
   * Context-level setup (route interception) survives page swaps and is NOT re-applied here.
   */
  protected async reattachPageListeners(): Promise<void> {
    if (!this.page) return;

    // Re-apply CDP permissions and CSP bypass on the new page
    try {
      const cdpSession = await this.page.context().newCDPSession(this.page);
      await cdpSession.send('Browser.grantPermissions', {
        origin: '',
        permissions: ['audioCapture', 'videoCapture', 'displayCapture'],
      });
      await cdpSession.send('Page.setBypassCSP', { enabled: true });
      logger.info('CDP permissions and CSP bypass re-applied on new page');
    } catch (error) {
      logger.warn(`CDP re-attach failed (non-fatal): ${error}`);
    }

    // Re-attach console and pageerror listeners
    const ignoredPatterns = [
      '401',
      'Unauthorized',
      'sensitivity',
      'SensitivityLabel',
      'pinnedChannels',
      'PinnedChannels',
      'AppsUsage',
      'getAppsUsage',
      'RemoteOperationFailed',
      'RequireStatusFailed',
      'store not initialized',
      'Discover::regionGtm',
      'consumerLicenses',
      'groupsServiceV2',
      'searchService',
      'TransformFailed',
      'Unexpected end of JSON',
      '{"isTrusted":true}',
      "reading 'slice'",
      'unsupported MIME type',
      'ExpLoader',
      'sw registration fail',
    ];
    this.page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('[ARAMIS]')) {
        logger.info(`[WebRTC] ${text}`);
        if (text.includes('New CSRC source:') && this.peakParticipantCount < 2) {
          this.peakParticipantCount = 2;
          logger.info('CSRC detected — human in meeting (peak=2)');
        }
      } else if (msg.type() === 'error') {
        if (!ignoredPatterns.some((p) => text.includes(p))) {
          logger.warn(`[Browser Console Error] ${text}`);
        }
      }
    });
    this.page.on('pageerror', (err) => {
      if (!ignoredPatterns.some((p) => err.message.includes(p))) {
        logger.warn(`[Browser Page Error] ${err.message}`);
      }
    });

    logger.info('Page listeners re-attached after page swap');
  }

  /**
   * Move mouse in a human-like way to an element before clicking
   */
  protected async humanMove(selector: string): Promise<void> {
    if (!this.page) return;

    try {
      const element = await this.page.$(selector);
      if (!element) return;

      const box = await element.boundingBox();
      if (!box) return;

      // Get current mouse position (default to center of viewport)
      const viewport = this.page.viewportSize() || { width: 1920, height: 1080 };
      let currentX = viewport.width / 2;
      let currentY = viewport.height / 2;

      // Target position with some randomness
      const targetX = box.x + box.width / 2 + (Math.random() - 0.5) * 10;
      const targetY = box.y + box.height / 2 + (Math.random() - 0.5) * 10;

      // Move in steps with slight randomness (simulating human movement)
      const steps = 10 + Math.floor(Math.random() * 10);
      for (let i = 0; i <= steps; i++) {
        const progress = i / steps;
        // Ease-out function for more natural movement
        const eased = 1 - Math.pow(1 - progress, 3);

        const x = currentX + (targetX - currentX) * eased + (Math.random() - 0.5) * 2;
        const y = currentY + (targetY - currentY) * eased + (Math.random() - 0.5) * 2;

        await this.page.mouse.move(x, y);
        await this.sleep(10 + Math.random() * 20);
      }
    } catch (error) {
      // Silently ignore mouse movement errors
    }
  }

  /**
   * Click an element with human-like behavior
   */
  protected async humanClick(selector: string): Promise<boolean> {
    if (!this.page) return false;

    try {
      // First move to the element
      await this.humanMove(selector);

      // Small delay before clicking
      await this.sleep(50 + Math.random() * 100);

      // Click the element (short timeout to avoid 30s Playwright default)
      await this.page.click(selector, { timeout: 3000 });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Helper to click an element with retry
   */
  protected async clickWithRetry(
    selector: string,
    options: { timeout?: number; retries?: number; humanLike?: boolean } = {},
  ): Promise<boolean> {
    const { timeout = 5000, retries = 3, humanLike = true } = options;

    for (let i = 0; i < retries; i++) {
      try {
        if (humanLike) {
          const success = await this.humanClick(selector);
          if (success) return true;
        } else {
          await this.page?.click(selector, { timeout });
          return true;
        }
      } catch (error) {
        if (i === retries - 1) {
          logger.warn(`Failed to click ${selector} after ${retries} attempts`);
          return false;
        }
        await this.sleep(1000);
      }
    }
    return false;
  }

  /**
   * Helper to type text with human-like delays
   */
  protected async typeWithDelay(selector: string, text: string, delay: number = 50): Promise<void> {
    await this.page?.fill(selector, '');
    for (const char of text) {
      await this.page?.type(selector, char, { delay });
    }
  }
}
