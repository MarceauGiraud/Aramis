import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../lib/logger';

const execFileAsync = promisify(execFile);
import { BOT_CONFIG } from '@aramis/shared';
import {
  RecordingOrchestrator,
  RecordingOrchestratorConfig,
  RecordingInfo,
} from '../lib/recording-orchestrator';
import { ChunkUploader } from '../lib/chunk-uploader';
import { isS3Configured } from '../lib/s3-config';
import { MeetUIController } from '../lib/meet-ui-controller';

/**
 * Raw JavaScript for audio capture, injected via addScriptTag to avoid
 * tsx/esbuild's __name helper which doesn't exist in browser context.
 */
const AUDIO_CAPTURE_SCRIPT = `(function() {
  var g = window;
  var ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  var dest = ctx.createMediaStreamDestination();

  g.__aramisRec = { ctx: ctx, dest: dest, rec: null, observer: null, chunksSent: 0, errorCount: 0, lastError: null, info: null };

  var connectedIds = {};
  var webrtcTracks = 0, domSrcObjectTracks = 0, domCaptureTracks = 0;

  function tryConnect(track) {
    if (!track || track.readyState !== 'live') return false;
    if (connectedIds[track.id]) return false;
    try {
      var src = ctx.createMediaStreamSource(new MediaStream([track]));
      src.connect(dest);
      connectedIds[track.id] = true;
      return true;
    } catch(e) { return false; }
  }

  // Source 1: WebRTC tracks from init script
  var aramis = g.__aramis && g.__aramis.audio;
  if (aramis && aramis.trackMap) {
    var entries = Object.values(aramis.trackMap);
    for (var i = 0; i < entries.length; i++) {
      if (tryConnect(entries[i].track)) webrtcTracks++;
    }
  }

  // Source 2: srcObject on video/audio elements
  var mediaEls = document.querySelectorAll('video, audio');
  for (var i = 0; i < mediaEls.length; i++) {
    try {
      var srcObj = mediaEls[i].srcObject;
      if (srcObj && srcObj.getAudioTracks) {
        var tracks = srcObj.getAudioTracks();
        for (var j = 0; j < tracks.length; j++) {
          if (tryConnect(tracks[j])) domSrcObjectTracks++;
        }
      }
    } catch(e) {}
  }

  // Source 3: captureStream on video/audio elements
  for (var i = 0; i < mediaEls.length; i++) {
    try {
      var stream = mediaEls[i].captureStream ? mediaEls[i].captureStream() : null;
      if (!stream) continue;
      var tracks = stream.getAudioTracks();
      for (var j = 0; j < tracks.length; j++) {
        if (tryConnect(tracks[j])) domCaptureTracks++;
      }
    } catch(e) {}
  }

  // Source 4: RTCPeerConnection receivers
  var rtcConns = g.__aramis && g.__aramis.rtc && g.__aramis.rtc.connections;
  if (rtcConns) {
    for (var i = 0; i < rtcConns.length; i++) {
      try {
        var receivers = rtcConns[i].getReceivers();
        for (var j = 0; j < receivers.length; j++) {
          if (receivers[j].track && receivers[j].track.kind === 'audio') {
            if (tryConnect(receivers[j].track)) webrtcTracks++;
          }
        }
      } catch(e) {}
    }
  }

  // MutationObserver for dynamically added media elements
  g.__aramisRec.observer = new MutationObserver(function(mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      for (var n = 0; n < added.length; n++) {
        if (!(added[n] instanceof HTMLElement)) continue;
        var node = added[n];
        var els = node.matches && node.matches('video, audio') ? [node] : (node.querySelectorAll ? Array.from(node.querySelectorAll('video, audio')) : []);
        for (var e = 0; e < els.length; e++) {
          try {
            var so = els[e].srcObject;
            if (so && so.getAudioTracks) { var t = so.getAudioTracks(); for (var k = 0; k < t.length; k++) tryConnect(t[k]); }
            var cs = els[e].captureStream ? els[e].captureStream() : null;
            if (cs) { var t2 = cs.getAudioTracks(); for (var k2 = 0; k2 < t2.length; k2++) tryConnect(t2[k2]); }
          } catch(ex) {}
        }
      }
    }
  });
  g.__aramisRec.observer.observe(document.body, { childList: true, subtree: true });

  // Start MediaRecorder
  var mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
           : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  var rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
  g.__aramisRec.rec = rec;

  rec.ondataavailable = function(e) {
    if (e.data.size > 0) {
      e.data.arrayBuffer().then(function(buf) {
        try {
          var bytes = new Uint8Array(buf);
          var bin = '';
          for (var i = 0; i < bytes.length; i += 8192) {
            bin += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + 8192)));
          }
          window.__aramisAudioData(btoa(bin));
          g.__aramisRec.chunksSent++;
        } catch(err) {
          g.__aramisRec.lastError = String(err);
          g.__aramisRec.errorCount++;
        }
      });
    }
  };
  rec.start(1000);

  // Per-track recorders: one MediaRecorder per WebRTC audio track
  var perTrackRecorders = {};
  g.__aramisRec.perTrackRecorders = perTrackRecorders;

  function toBase64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + 8192)));
    }
    return btoa(bin);
  }

  function startTrackRecorder(trackEntry) {
    if (!trackEntry || !trackEntry.track || trackEntry.track.readyState !== 'live') return;
    var trackIndex = trackEntry.index;
    if (trackIndex === undefined || perTrackRecorders[trackIndex]) return;
    try {
      var trackStream = new MediaStream([trackEntry.track]);
      var trackRec = new MediaRecorder(trackStream, mime ? { mimeType: mime } : undefined);
      perTrackRecorders[trackIndex] = trackRec;
      trackRec.ondataavailable = function(ev) {
        if (ev.data.size > 0) {
          ev.data.arrayBuffer().then(function(ab) {
            try {
              window.__aramisTrackData(trackIndex, toBase64(ab));
            } catch(err) { /* ignore */ }
          });
        }
      };
      trackRec.start(1000);
    } catch(e) { /* ignore tracks that cannot be recorded */ }
  }

  // Start per-track recorders for existing WebRTC tracks
  if (aramis && aramis.trackMap) {
    var trackEntries = Object.values(aramis.trackMap);
    for (var t = 0; t < trackEntries.length; t++) {
      startTrackRecorder(trackEntries[t]);
    }
  }

  // Watch for new tracks added after recording starts
  g.__aramisRec._startTrackRecorder = startTrackRecorder;

  var totalConnected = Object.keys(connectedIds).length;
  g.__aramisRec.info = {
    ctxState: ctx.state,
    webrtcTracks: webrtcTracks,
    domSrcObjectTracks: domSrcObjectTracks,
    domCaptureTracks: domCaptureTracks,
    totalConnected: totalConnected,
    mediaElementCount: mediaEls.length,
    recorderState: rec.state,
    perTrackCount: Object.keys(perTrackRecorders).length
  };
})();`;

// Add stealth plugin to avoid bot detection
// Disable specific evasions that can cause issues
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

export interface BotConfig {
  meetingId: string;
  meetingUrl: string;
  botName: string;
}

export interface RecordingOptions {
  outputDir?: string;
  format?: 'webm' | 'mp4';
}

export interface BotOptions {
  headless?: boolean;
  debug?: boolean;
  screenshotDir?: string;
}

/** Active speaker detected from the meeting UI */
export interface ActiveSpeaker {
  name: string;
  email?: string;
}

/** Participant extracted from the meeting UI */
export interface ParticipantInfo {
  name: string;
  email?: string;
  isHost?: boolean;
}

/** A segment in the speaker timeline */
export interface SpeakerSegment {
  speaker: string;
  email?: string;
  startTime: number; // seconds from recording start
  endTime: number;
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
  protected meetUIController: MeetUIController | null = null;
  protected lastRecordingInfo: RecordingInfo | null = null;
  /** True when using Playwright recordVideo instead of FFmpeg (macOS/non-Docker) */
  protected usePlaywrightRecording = false;
  /** Live chunk uploader for Playwright recording mode */
  private chunkUploader: ChunkUploader | null = null;
  /** Audio file path for browser audio capture */
  private audioFilePath: string | null = null;
  /** Write stream for audio chunks from browser */
  private audioWriteStream: fs.WriteStream | null = null;
  /** Timestamp when the browser context was created (video recording starts here) */
  private contextCreatedAt: number = 0;
  /** Speaker timeline: who spoke when during the recording */
  private speakerTimeline: SpeakerSegment[] = [];
  /** Interval for polling the active speaker from the UI */
  private speakerTrackingInterval: NodeJS.Timeout | null = null;
  /** Last detected speaker name (for change detection) */
  private lastDetectedSpeaker: string | null = null;
  /** Last detected speaker email */
  private lastDetectedSpeakerEmail: string | undefined = undefined;
  /** When the last speaker change was detected */
  private lastSpeakerChangeTime: number = 0;
  /** Path to the saved speaker timeline JSON */
  private speakerTimelinePath: string | null = null;
  /** Timestamp when browser audio capture started (audio recording begins here) */
  private audioStartTimestamp: number = 0;
  /** Per-track audio write streams (one per WebRTC participant) */
  private perTrackStreams: Map<number, fs.WriteStream> = new Map();
  /** Per-track audio file paths */
  private perTrackPaths: Map<number, string> = new Map();
  /** Last extracted participants (cached so they survive page close) */
  private cachedParticipants: ParticipantInfo[] = [];

  constructor(config: BotConfig, options: BotOptions = {}) {
    this.config = config;
    this.options = {
      headless: options.headless ?? (process.env.BOT_HEADLESS !== 'false'),
      debug: options.debug ?? (process.env.BOT_DEBUG === 'true'),
      screenshotDir: options.screenshotDir ?? '/tmp/bot-screenshots',
    };
  }

  /**
   * Check if FFmpeg x11grab recording is available (Linux with DISPLAY set)
   */
  private canUseFFmpegRecording(): boolean {
    const isLinux = process.platform === 'linux';
    const hasDisplay = !!process.env.DISPLAY;
    return isLinux && hasDisplay;
  }

  /**
   * Initialize the browser with stealth settings
   */
  async initialize(): Promise<void> {
    logger.info(`Initializing bot for meeting: ${this.config.meetingId}`);
    logger.info(`Bot options: headless=${this.options.headless}, debug=${this.options.debug}`);

    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: [
        '--incognito',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        // Use fake media devices to avoid permission popups
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Use a black/silent fake device instead of default green
        '--use-file-for-fake-video-capture=/dev/null',
        '--use-file-for-fake-audio-capture=/dev/null',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    // Ensure recordings directory exists
    const recordingsDir = '/tmp/recordings';
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    // Detect recording mode
    this.usePlaywrightRecording = !this.canUseFFmpegRecording();
    if (this.usePlaywrightRecording) {
      logger.info('FFmpeg x11grab not available - using Playwright recordVideo fallback');
    }

    // Create browser context with optional Playwright video recording
    const contextOptions: Parameters<Browser['newContext']>[0] = {
      permissions: ['microphone', 'camera'],
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
    };

    if (this.usePlaywrightRecording) {
      contextOptions.recordVideo = {
        dir: recordingsDir,
        size: { width: 1920, height: 1080 },
      };
    }

    this.context = await this.browser.newContext(contextOptions);
    this.contextCreatedAt = Date.now();

    this.page = await this.context.newPage();

    // Initialize UI controller for clean video recording
    this.meetUIController = new MeetUIController(this.page);

    // Register an init script that injects the black overlay on EVERY navigation.
    // This ensures the overlay persists when page.goto(meetingUrl) navigates away
    // from the initial blank page. Removed later in startRecording().
    if (this.usePlaywrightRecording) {
      await this.page.addInitScript(`
        var overlay = document.createElement('div');
        overlay.id = '__aramis-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:999999;pointer-events:none';
        document.documentElement.appendChild(overlay);
      `);
      // Also inject on the current blank page so recording starts with black
      await this.meetUIController.injectBlackOverlay();
    }

    // Single combined init script: stealth patches + WebRTC audio interception.
    // IMPORTANT: This MUST be a single addInitScript call so the RTCPeerConnection
    // patch is installed atomically before any page JavaScript executes.
    // Splitting into multiple addInitScript calls risks a race where the meeting
    // platform initializes WebRTC between script injections.
    await this.page.addInitScript(() => {
      // --- Stealth patches ---

      // Override webdriver detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Override plugins with realistic Chrome plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
          return Object.assign(plugins, { length: plugins.length });
        },
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
        loadTimes: function() {},
        csi: function() {},
        app: {},
      };

      // Override permissions query
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);

      // Override WebGL vendor and renderer
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter: number) {
        if (parameter === 37445) {
          return 'Intel Inc.';
        }
        if (parameter === 37446) {
          return 'Intel Iris OpenGL Engine';
        }
        return getParameter.call(this, parameter);
      };

      // --- WebRTC interception: audio capture + state detection ---
      //
      // We intercept RTCPeerConnection to:
      // 1. Capture incoming audio tracks for recording
      // 2. Track connection state (connected/disconnected) for meeting detection
      // 3. Attach AnalyserNodes per track for volume-based speaker detection
      //
      // This is far more robust than DOM/CSS detection because:
      // - Connection state tells us if we're truly in a meeting (vs waiting room)
      // - Audio volume analysis tells us who's speaking (vs CSS border heuristics)
      // - Works identically across Google Meet, Teams, Zoom

      const g = window as any;
      g.__aramis = {
        // Audio recording state
        audio: {
          trackMap: {} as Record<string, any>,
          nextTrackIndex: 0,
          ctx: null as AudioContext | null,
          dest: null as MediaStreamAudioDestinationNode | null,
          rec: null as MediaRecorder | null,
          on: false,
        },
        // WebRTC connection state tracking
        rtc: {
          connections: [] as RTCPeerConnection[],
          remoteTrackCount: 0,
          hasConnected: false,        // true once any connection reached 'connected'
          allDisconnected: false,      // true when all connections are disconnected/closed
          lastStateChange: 0,
        },
      };

      // Backwards compatibility alias
      g.__aramisAudio = g.__aramis.audio;

      const OrigRTC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OrigRTC {
        constructor(...args: any[]) {
          super(...args);
          const rtc = g.__aramis.rtc;
          rtc.connections.push(this as any);

          // Track ICE connection state changes
          this.addEventListener('iceconnectionstatechange', () => {
            const state = this.iceConnectionState;
            rtc.lastStateChange = Date.now();

            if (state === 'connected' || state === 'completed') {
              rtc.hasConnected = true;
              rtc.allDisconnected = false;
            }

            // Check if ALL connections are now disconnected/closed/failed
            if (state === 'disconnected' || state === 'closed' || state === 'failed') {
              const activeConns = rtc.connections.filter((c: RTCPeerConnection) => {
                const s = c.iceConnectionState;
                return s === 'connected' || s === 'completed' || s === 'checking' || s === 'new';
              });
              if (activeConns.length === 0 && rtc.hasConnected) {
                rtc.allDisconnected = true;
              }
            }
          });

          // Track incoming media tracks
          this.addEventListener('track', (ev: RTCTrackEvent) => {
            rtc.remoteTrackCount++;

            if (ev.track.kind === 'audio') {
              const a = g.__aramis.audio;
              a.trackMap[ev.track.id] = { track: ev.track, analyser: null, source: null, index: a.nextTrackIndex++ };

              // Clean up dead tracks to prevent memory leaks
              ev.track.onended = () => {
                rtc.remoteTrackCount = Math.max(0, rtc.remoteTrackCount - 1);
                const entry = a.trackMap[ev.track.id];
                if (entry?.source) {
                  try { entry.source.disconnect(); } catch { /* already disconnected */ }
                }
                delete a.trackMap[ev.track.id];
              };

              if (a.on && a.ctx && a.dest) {
                try {
                  const source = a.ctx.createMediaStreamSource(new MediaStream([ev.track]));
                  source.connect(a.dest);
                  a.trackMap[ev.track.id].source = source;

                  // Attach AnalyserNode for volume detection (speaker identification)
                  const analyser = a.ctx.createAnalyser();
                  analyser.fftSize = 256;
                  source.connect(analyser);
                  a.trackMap[ev.track.id].analyser = analyser;
                } catch (e) { /* ignore */ }

                // Start per-track recorder if recording is already active
                const aramisRec = (g as any).__aramisRec;
                if (aramisRec && aramisRec._startTrackRecorder) {
                  try { aramisRec._startTrackRecorder(a.trackMap[ev.track.id]); } catch { /* ignore */ }
                }
              }
            }
          });
        }
      } as any;
      Object.defineProperty(window.RTCPeerConnection, 'name', { value: 'RTCPeerConnection' });
    });

    // NOTE: exposeFunction is registered in startRecording(), not here.
    // Registering here would bind to the initial blank page context, which is
    // lost when the page navigates to the meeting URL.

    // Initialize the recording orchestrator only when FFmpeg is available
    if (!this.usePlaywrightRecording) {
      this.recordingOrchestrator = new RecordingOrchestrator({
        meetingId: this.config.meetingId,
        display: process.env.DISPLAY || ':99',
        audioSource: process.env.PULSE_SOURCE || 'default',
        tempDir: recordingsDir,
        resolution: { width: 1920, height: 1080 },
        frameRate: 30,
        enableLiveUpload: true,
      });

      // Set up recording event handlers
      this.setupRecordingEventHandlers();
    }
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
      logger.info(`Recording complete: ${event.duration}s`);
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

  /**
   * Join the meeting - implemented by each platform bot
   */
  abstract join(): Promise<void>;

  // ========================================================================
  // WebRTC-based state detection (cross-platform, more robust than DOM)
  // ========================================================================

  /**
   * Query the WebRTC connection state from the browser.
   * Returns: { hasConnected, allDisconnected, remoteTrackCount, liveAudioTracks }
   *
   * This is far more reliable than DOM selectors because:
   * - Waiting room: hasConnected=false, remoteTrackCount=0
   * - In meeting: hasConnected=true, remoteTrackCount>0
   * - Meeting ended: allDisconnected=true (all peer connections closed)
   */
  protected async getWebRTCState(): Promise<{
    hasConnected: boolean;
    allDisconnected: boolean;
    remoteTrackCount: number;
    liveAudioTracks: number;
  }> {
    if (!this.page) {
      return { hasConnected: false, allDisconnected: false, remoteTrackCount: 0, liveAudioTracks: 0 };
    }
    try {
      return await this.page.evaluate(() => {
        const r = (window as any).__aramis?.rtc;
        const a = (window as any).__aramis?.audio;
        if (!r) {
          return { hasConnected: false, allDisconnected: false, remoteTrackCount: 0, liveAudioTracks: 0 };
        }
        // Count live (non-ended) audio tracks
        const liveAudioTracks = a
          ? Object.values(a.trackMap).filter((t: any) => t.track.readyState === 'live').length
          : 0;
        return {
          hasConnected: r.hasConnected as boolean,
          allDisconnected: r.allDisconnected as boolean,
          remoteTrackCount: r.remoteTrackCount as number,
          liveAudioTracks,
        };
      });
    } catch {
      return { hasConnected: false, allDisconnected: false, remoteTrackCount: 0, liveAudioTracks: 0 };
    }
  }

  /**
   * Check if the bot is truly in a meeting (WebRTC connected + remote tracks present).
   * Works across all platforms — no DOM selectors needed.
   */
  protected async isInMeetingViaWebRTC(): Promise<boolean> {
    const state = await this.getWebRTCState();
    return state.hasConnected && !state.allDisconnected && state.remoteTrackCount > 0;
  }

  /**
   * Check if the meeting has ended via WebRTC signals.
   * Returns true when connections were established but are now all disconnected.
   */
  protected async isMeetingEndedViaWebRTC(): Promise<boolean> {
    const state = await this.getWebRTCState();
    return state.hasConnected && state.allDisconnected;
  }

  /**
   * Detect which audio track is loudest right now (volume-based speaker detection).
   * Returns the track index with the highest RMS volume, or -1 if silence.
   * Platform bots can correlate this with participant names from the DOM.
   */
  protected async getLoudestAudioTrack(): Promise<{ trackId: string; volume: number } | null> {
    if (!this.page) return null;
    try {
      return await this.page.evaluate(() => {
        const a = (window as any).__aramis?.audio;
        if (!a?.ctx) return null;

        let loudestId = '';
        let loudestVol = 0;

        for (const [trackId, info] of Object.entries(a.trackMap) as [string, any][]) {
          if (!info.analyser || info.track.readyState !== 'live') continue;
          const data = new Uint8Array(info.analyser.frequencyBinCount);
          info.analyser.getByteFrequencyData(data);
          // RMS volume
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          const rms = Math.sqrt(sum / data.length);
          if (rms > loudestVol && rms > 10) { // threshold to ignore noise
            loudestVol = rms;
            loudestId = trackId;
          }
        }

        return loudestId ? { trackId: loudestId, volume: loudestVol } : null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Wait until WebRTC is connected with remote tracks before starting recording.
   * This avoids capturing lobby/transition frames in the recording.
   */
  protected async waitForWebRTCReady(): Promise<void> {
    const deadline = Date.now() + 10000; // 10s max

    while (Date.now() < deadline) {
      const rtcState = await this.getWebRTCState();
      if (rtcState.hasConnected && rtcState.remoteTrackCount > 0) {
        logger.info(`WebRTC ready: ${rtcState.remoteTrackCount} remote tracks, ${rtcState.liveAudioTracks} audio`);
        // Brief pause for UI to stabilize after WebRTC connects
        await this.sleep(1500);
        return;
      }
      await this.sleep(500);
    }

    logger.warn('WebRTC readiness timeout — starting recording anyway');
  }

  /**
   * Start recording the meeting
   * Uses FFmpeg via RecordingOrchestrator (Docker/Linux) or Playwright recordVideo (macOS)
   */
  async startRecording(options: RecordingOptions = {}): Promise<void> {
    logger.info(`Starting recording for meeting: ${this.config.meetingId}`);

    if (this.usePlaywrightRecording) {
      logger.info('Recording via Playwright recordVideo (video active since context creation)');

      // Start browser audio capture — self-contained, no dependency on init script.
      // The addInitScript patches can be lost if Google Meet navigates internally
      // (e.g., pre-join → in-meeting), so we capture audio directly from DOM elements.
      if (this.page) {
        const audioPath = path.join('/tmp/recordings', `${this.config.meetingId}_audio.webm`);
        this.audioFilePath = audioPath;
        this.audioWriteStream = fs.createWriteStream(audioPath);

        try {
          // Expose the audio data callback in the CURRENT page context.
          // This must happen here (not in initialize()) because page.goto()
          // navigates to a new document, losing any previously exposed functions.
          try {
            await this.page.exposeFunction('__aramisAudioData', (base64: string) => {
              if (this.audioWriteStream && !this.audioWriteStream.destroyed) {
                this.audioWriteStream.write(Buffer.from(base64, 'base64'));
              }
            });
          } catch (e) {
            // May fail if already exposed (e.g., no navigation happened)
            logger.warn(`exposeFunction __aramisAudioData: ${e}`);
          }

          // Expose per-track audio data callback for individual participant recording
          try {
            await this.page.exposeFunction('__aramisTrackData', (trackIndex: number, base64: string) => {
              let stream = this.perTrackStreams.get(trackIndex);
              if (!stream) {
                const trackPath = path.join('/tmp/recordings', `${this.config.meetingId}_track_${trackIndex}.webm`);
                stream = fs.createWriteStream(trackPath);
                this.perTrackStreams.set(trackIndex, stream);
                this.perTrackPaths.set(trackIndex, trackPath);
                logger.info(`Per-track recording started for track ${trackIndex}: ${trackPath}`);
              }
              if (!stream.destroyed) {
                stream.write(Buffer.from(base64, 'base64'));
              }
            });
          } catch (e) {
            logger.warn(`exposeFunction __aramisTrackData: ${e}`);
          }

          // Click page body to satisfy user gesture requirement for AudioContext
          try {
            await this.page.click('body', { timeout: 2000, force: true });
          } catch { /* ignore click failure */ }

          // Execute audio capture via CDP Runtime.evaluate to bypass:
          // 1. tsx/esbuild __name() helper injection (breaks page.evaluate)
          // 2. Google Meet's Trusted Types CSP (blocks addScriptTag)
          const cdp = await this.page.context().newCDPSession(this.page);
          await cdp.send('Runtime.evaluate', {
            expression: AUDIO_CAPTURE_SCRIPT,
            awaitPromise: false,
          });
          await cdp.detach();

          // Record when audio capture started (for sync with video)
          this.audioStartTimestamp = Date.now();

          // Read back the result
          const audioInfo = await this.page.evaluate(() => (window as any).__aramisRec?.info);
          logger.info(`Audio capture started: ${JSON.stringify(audioInfo)}`);
        } catch (error) {
          logger.warn(`Failed to start audio capture (video-only recording): ${error}`);
        }
      }

      // Hide Meet UI and force spotlight layout, then reveal (remove black overlay)
      if (this.meetUIController) {
        await this.meetUIController.hideAllChrome();
        await this.sleep(500); // Let CSS apply before revealing
        await this.meetUIController.removeBlackOverlay();
      }
    } else {
      if (!this.recordingOrchestrator) {
        throw new Error('Recording orchestrator not initialized');
      }
      await this.recordingOrchestrator.start();
    }

    this.isRecording = true;
    this.startTime = new Date();

    // Start speaker tracking (polls UI for active speaker + correlates with audio tracks)
    this.startSpeakerTracking();

    logger.info('Recording started');
  }

  /**
   * Stop recording and save the file
   */
  async stopRecording(): Promise<string | null> {
    if (!this.isRecording) {
      return null;
    }

    logger.info('Stopping recording...');

    if (this.usePlaywrightRecording) {
      // 1. Stop speaker tracking and save timeline
      this.stopSpeakerTracking();

      // 2. Re-inject black overlay so the video ends with black frames (clean trim)
      if (this.page && this.meetUIController) {
        try {
          await this.meetUIController.injectBlackOverlay();
          await this.sleep(500); // Let overlay render into video
        } catch { /* page may be gone */ }
      }

      // 3. Stop audio capture BEFORE closing the page
      if (this.page) {
        try {
          const audioStats = await this.page.evaluate(() => {
            const r = (window as any).__aramisRec;
            if (r?.observer) {
              r.observer.disconnect();
              r.observer = null;
            }
            if (r?.rec && r.rec.state !== 'inactive') {
              r.rec.stop();
            }
            // Stop all per-track recorders
            var perTrackStopped = 0;
            if (r?.perTrackRecorders) {
              var keys = Object.keys(r.perTrackRecorders);
              for (var i = 0; i < keys.length; i++) {
                try {
                  var tr = r.perTrackRecorders[keys[i]];
                  if (tr && tr.state !== 'inactive') {
                    tr.stop();
                    perTrackStopped++;
                  }
                } catch (e) { /* ignore */ }
              }
            }
            const a = (window as any).__aramisAudio;
            if (a?.rec && a.rec.state !== 'inactive') {
              a.rec.stop();
              a.on = false;
            }
            return {
              chunksSent: r?.chunksSent || 0,
              errorCount: r?.errorCount || 0,
              lastError: r?.lastError || null,
              perTrackStopped: perTrackStopped,
            };
          });
          logger.info(`Audio capture stats: ${JSON.stringify(audioStats)}`);
          await this.sleep(2000); // Wait for final audio chunks to be written
        } catch {
          // Page may already be closing
        }
      }

      // 4. Close audio write stream
      if (this.audioWriteStream) {
        await new Promise<void>((resolve) => this.audioWriteStream!.end(resolve));
        this.audioWriteStream = null;
      }

      // 4b. Close all per-track audio write streams
      for (const [trackIndex, stream] of this.perTrackStreams) {
        try {
          await new Promise<void>((resolve) => stream.end(resolve));
        } catch { /* ignore */ }
        logger.info(`Per-track stream closed for track ${trackIndex}: ${this.perTrackPaths.get(trackIndex)}`);
      }
      this.perTrackStreams.clear();

      // 5. Close page to finalize the Playwright video file
      let localVideoPath: string | null = null;
      if (this.page) {
        try {
          const video = this.page.video();
          if (video) {
            await this.page.close();
            localVideoPath = await video.path();
            this.recordingPath = localVideoPath;
            logger.info(`Playwright recording saved: ${localVideoPath}`);
          }
        } catch (error) {
          logger.warn(`Error getting Playwright video path: ${error}`);
        }
        this.page = null;
      }

      // 6. Trim video start using timestamp alignment, and optionally trim
      //    trailing black frames using blackdetect.
      //    Video recording starts at browser context creation (contextCreatedAt),
      //    while audio starts later at startRecording() time (audioStartTimestamp).
      //    The offset between them tells us how many seconds of pre-join/waiting
      //    room video to skip.
      const hasAudio = this.audioFilePath && fs.existsSync(this.audioFilePath)
        && fs.statSync(this.audioFilePath).size > 0;

      if (localVideoPath) {
        const parsed = path.parse(localVideoPath);
        const mergedPath = path.join(parsed.dir, `${parsed.name}_final${parsed.ext}`);
        try {
          // PRIMARY: Calculate trimStart from timestamp difference
          const referenceTime = this.audioStartTimestamp || (this.startTime?.getTime() ?? 0);
          const trimStart = referenceTime && this.contextCreatedAt
            ? Math.max(0, (referenceTime - this.contextCreatedAt) / 1000)
            : 0;

          // SECONDARY: Use blackdetect only for trimEnd (trailing black frames)
          const trimEnd = await this.detectTrailingBlackStart(localVideoPath);

          logger.info(`Video trim: start=${trimStart.toFixed(1)}s (timestamp-based), end=${trimEnd > 0 ? trimEnd.toFixed(1) + 's' : 'none'} (blackdetect)`);

          const ffmpegArgs: string[] = [];

          // Apply -ss ONLY to the video input (before -i video) to skip
          // pre-join/waiting room frames. Audio starts at the right time
          // already, so it needs NO trim offset.
          if (trimStart > 0.5) {
            ffmpegArgs.push('-ss', trimStart.toFixed(2));
          }
          ffmpegArgs.push('-i', localVideoPath);

          if (hasAudio) {
            // Audio input has NO -ss — it starts at the right time already
            ffmpegArgs.push('-i', this.audioFilePath!);

            // Trim to last non-black frame (applied to output duration)
            if (trimEnd > 0 && trimEnd > trimStart) {
              ffmpegArgs.push('-t', (trimEnd - trimStart).toFixed(2));
            }

            ffmpegArgs.push('-c:v', 'copy', '-c:a', 'copy');
            ffmpegArgs.push('-map', '0:v', '-map', '1:a');
            ffmpegArgs.push('-shortest');
          } else {
            // Trim to last non-black frame (video-only)
            if (trimEnd > 0 && trimEnd > trimStart) {
              ffmpegArgs.push('-t', (trimEnd - trimStart).toFixed(2));
            }

            ffmpegArgs.push('-c:v', 'copy');
            logger.warn('No audio captured — producing video-only recording');
          }

          ffmpegArgs.push('-y', mergedPath);

          await execFileAsync('ffmpeg', ffmpegArgs);
          this.recordingPath = mergedPath;
          logger.info(`Final recording: ${mergedPath} (audio: ${hasAudio ? 'yes' : 'no'})`);
        } catch (error) {
          logger.warn(`FFmpeg post-processing failed, using raw video: ${error}`);
        }
      } else if (!hasAudio) {
        logger.warn('No audio captured from meeting participants');
      }
    } else {
      if (!this.recordingOrchestrator) {
        return null;
      }

      // Stop the orchestrator with merge and upload
      this.lastRecordingInfo = await this.recordingOrchestrator.stop({
        merge: true,
        upload: true,
        cleanup: true,
      });

      // Return the best available URL (S3 merged > S3 video > local path)
      this.recordingPath = this.lastRecordingInfo.s3MergedUrl
        ?? this.lastRecordingInfo.s3VideoUrl
        ?? this.lastRecordingInfo.mergedPath
        ?? this.lastRecordingInfo.videoPath;
    }

    this.isRecording = false;
    logger.info(`Recording saved: ${this.recordingPath}`);

    return this.recordingPath;
  }

  /**
   * Wait for the meeting to end
   */
  async waitForEnd(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const maxDuration = BOT_CONFIG.MAX_RECORDING_DURATION_MS;
    const checkInterval = BOT_CONFIG.RECORDING_CHECK_INTERVAL_MS;
    const startTime = Date.now();

    let lastParticipantExtract = 0;
    const participantExtractInterval = 30000; // Extract every 30s to keep cache fresh

    while (Date.now() - startTime < maxDuration) {
      // Periodically extract participants while still in meeting (cache survives page close)
      if (Date.now() - lastParticipantExtract > participantExtractInterval) {
        try {
          const participants = await this.extractParticipants();
          if (participants.length > 0) {
            this.cachedParticipants = participants;
          }
          lastParticipantExtract = Date.now();
        } catch { /* ignore */ }
      }

      // Check if meeting has ended (platform-specific)
      const ended = await this.checkMeetingEnded();
      if (ended) {
        logger.info('Meeting has ended');
        break;
      }

      // Check if we're still in the meeting
      const inMeeting = await this.checkStillInMeeting();
      if (!inMeeting) {
        logger.info('Bot is no longer in meeting');
        break;
      }

      await this.sleep(checkInterval);
    }
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
   * Detect the currently active speaker from the meeting UI.
   * Each platform bot implements this by reading its specific DOM
   * (e.g. the speaking indicator animation on the participant tile).
   * Returns null if no one is speaking or detection fails.
   */
  abstract detectActiveSpeaker(): Promise<ActiveSpeaker | null>;

  /**
   * Extract participant details from the meeting UI.
   * Each platform bot implements this by reading its specific DOM
   * (e.g. participant list panel, video tiles with names).
   * Should be called before leaving the meeting.
   */
  abstract extractParticipants(): Promise<ParticipantInfo[]>;

  /**
   * Start polling the UI for the active speaker during recording.
   * Builds a speaker timeline: [{speaker, startTime, endTime}]
   */
  private startSpeakerTracking(): void {
    this.speakerTimeline = [];
    this.lastDetectedSpeaker = null;
    this.lastSpeakerChangeTime = 0;

    this.speakerTrackingInterval = setInterval(async () => {
      if (!this.page || !this.isRecording) return;
      try {
        const speaker = await this.detectActiveSpeaker();
        const now = this.startTime
          ? (Date.now() - this.startTime.getTime()) / 1000
          : 0;
        const speakerName = speaker?.name ?? null;

        if (speakerName !== this.lastDetectedSpeaker) {
          // Close previous segment (min 0.5s to avoid noise)
          if (this.lastDetectedSpeaker && (now - this.lastSpeakerChangeTime) > 0.5) {
            this.speakerTimeline.push({
              speaker: this.lastDetectedSpeaker,
              email: this.lastDetectedSpeakerEmail,
              startTime: this.lastSpeakerChangeTime,
              endTime: now,
            });
          }
          this.lastDetectedSpeaker = speakerName;
          this.lastDetectedSpeakerEmail = speaker?.email;
          this.lastSpeakerChangeTime = now;
        }
      } catch {
        // Ignore transient errors during speaker detection
      }
    }, 500);
  }

  /**
   * Stop speaker tracking and save the timeline JSON
   */
  private stopSpeakerTracking(): void {
    if (this.speakerTrackingInterval) {
      clearInterval(this.speakerTrackingInterval);
      this.speakerTrackingInterval = null;
    }

    // Close final segment
    if (this.lastDetectedSpeaker && this.startTime) {
      const now = (Date.now() - this.startTime.getTime()) / 1000;
      this.speakerTimeline.push({
        speaker: this.lastDetectedSpeaker,
        email: this.lastDetectedSpeakerEmail,
        startTime: this.lastSpeakerChangeTime,
        endTime: now,
      });
    }

    // Save timeline to file
    if (this.speakerTimeline.length > 0) {
      this.speakerTimelinePath = path.join(
        '/tmp/recordings',
        `${this.config.meetingId}_speakers.json`
      );
      fs.writeFileSync(this.speakerTimelinePath, JSON.stringify(this.speakerTimeline, null, 2));
      logger.info(`Speaker timeline saved: ${this.speakerTimeline.length} segments`);
    } else {
      logger.warn('No speaker segments detected during recording');
    }
  }

  /**
   * Get the speaker timeline (available after recording stops)
   */
  getSpeakerTimeline(): SpeakerSegment[] {
    return this.speakerTimeline;
  }

  /**
   * Get the path to the speaker timeline JSON file
   */
  getSpeakerTimelinePath(): string | null {
    return this.speakerTimelinePath;
  }

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
   * Get the full recording info (includes separate audio URL for transcription)
   */
  getRecordingInfo(): RecordingInfo | null {
    return this.lastRecordingInfo;
  }

  /**
   * Get the path to the captured audio file (Playwright mode).
   * Returns null if no audio was captured or in FFmpeg mode (use getRecordingInfo instead).
   */
  getAudioFilePath(): string | null {
    return this.audioFilePath;
  }

  /**
   * Get per-track audio file paths (one per WebRTC participant).
   * Keys are sequential track indices, values are file paths.
   */
  getPerTrackAudioPaths(): Map<number, string> {
    return new Map(this.perTrackPaths);
  }

  /**
   * Get cached participants extracted during the meeting.
   * These are periodically extracted while the meeting is active,
   * so they survive even if the page closes before explicit extraction.
   */
  getCachedParticipants(): ParticipantInfo[] {
    return this.cachedParticipants;
  }

  /**
   * Leave the meeting
   */
  abstract leave(): Promise<void>;

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up bot resources');

    // Stop speaker tracking if still running
    if (this.speakerTrackingInterval) {
      clearInterval(this.speakerTrackingInterval);
      this.speakerTrackingInterval = null;
    }

    // Close audio write stream if still open (error path)
    if (this.audioWriteStream) {
      try {
        this.audioWriteStream.end();
      } catch { /* ignore */ }
      this.audioWriteStream = null;
    }

    // Close per-track audio write streams if still open (error path)
    for (const [, stream] of this.perTrackStreams) {
      try {
        stream.end();
      } catch { /* ignore */ }
    }
    this.perTrackStreams.clear();

    // Abort chunk uploader if still active (error path)
    if (this.chunkUploader) {
      try {
        await this.chunkUploader.abortUpload();
      } catch (error) {
        logger.warn(`Error aborting chunk uploader: ${error}`);
      }
      this.chunkUploader = null;
    }

    // Force cleanup recording orchestrator if still running
    if (this.recordingOrchestrator && this.recordingOrchestrator.isRecording()) {
      try {
        await this.recordingOrchestrator.forceCleanup();
      } catch (error) {
        logger.warn(`Error during recording cleanup: ${error}`);
      }
    }

    if (this.isRecording) {
      try {
        await this.stopRecording();
      } catch (error) {
        logger.warn(`Error stopping recording during cleanup: ${error}`);
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
   * Helper to sleep for a given time
   */
  /**
   * Detect trailing black frames at the end of the video (e.g. from overlay
   * re-injection after meeting ends). Returns the timestamp where trailing
   * black starts, or 0 if no trailing black segment is found.
   *
   * Note: We no longer use blackdetect for start-of-video trimming because
   * it was unreliable (often returning "content from 0.0s to end"). Instead,
   * trimStart is calculated from the timestamp difference between context
   * creation and audio recording start.
   */
  private async detectTrailingBlackStart(videoPath: string): Promise<number> {
    try {
      const { stderr } = await execFileAsync('ffmpeg', [
        '-i', videoPath,
        '-vf', 'blackdetect=d=0.3:pix_th=0.10',
        '-an', '-f', 'null', '-',
      ], { timeout: 30000 });

      // Parse blackdetect output: "black_start:0 black_end:5.2 black_duration:5.2"
      const blackSegments: { start: number; end: number }[] = [];
      const regex = /black_start:(\d+\.?\d*)\s+black_end:(\d+\.?\d*)/g;
      let match;
      while ((match = regex.exec(stderr)) !== null) {
        blackSegments.push({ start: parseFloat(match[1]), end: parseFloat(match[2]) });
      }

      if (blackSegments.length === 0) {
        return 0;
      }

      // Only look at the last black segment -- if it extends to the end of
      // the video, return its start as the trim point.
      const lastBlack = blackSegments[blackSegments.length - 1];
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      let videoDuration = 0;
      if (durationMatch) {
        videoDuration = parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3]);
      }

      if (videoDuration > 0 && lastBlack.end >= videoDuration - 1) {
        return lastBlack.start;
      }

      return 0;
    } catch (error) {
      logger.warn(`blackdetect failed, skipping trailing trim: ${error}`);
      return 0;
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Take a debug screenshot (only if debug mode is enabled)
   */
  protected async takeDebugScreenshot(name: string): Promise<void> {
    if (!this.options.debug || !this.page) return;

    try {
      const dir = this.options.screenshotDir!;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.screenshotCounter++;
      const filename = `${this.config.meetingId}_${this.screenshotCounter.toString().padStart(3, '0')}_${name}.png`;
      const filepath = path.join(dir, filename);

      await this.page.screenshot({ path: filepath, fullPage: true });
      logger.info(`Screenshot saved: ${filepath}`);
    } catch (error) {
      logger.warn(`Failed to take screenshot: ${error}`);
    }
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

      // Click the element
      await this.page.click(selector);
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
    options: { timeout?: number; retries?: number; humanLike?: boolean } = {}
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
  protected async typeWithDelay(
    selector: string,
    text: string,
    delay: number = 50
  ): Promise<void> {
    await this.page?.fill(selector, '');
    for (const char of text) {
      await this.page?.type(selector, char, { delay });
    }
  }
}
