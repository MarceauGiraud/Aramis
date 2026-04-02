/**
 * WebSocket Audio Server
 *
 * Provides real-time audio streaming over WebSocket for connected clients.
 *
 * Features:
 * - Server->Client: base64 encoded PCM frames from meeting audio
 * - Client->Server: base64 encoded PCM frames played into meeting via PulseAudio
 * - Supports ?track=mixed (default) for combined audio
 *
 * Client connects to: ws://host:port/api/bots/{botId}/audio
 *
 * NOTE: Requires the `ws` npm package to be installed:
 *   pnpm --filter @aramis/bot-worker add ws @types/ws
 */

import { Server as HttpServer } from 'http';
import { Readable } from 'stream';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from './logger';

// ws is dynamically imported to avoid errors if not installed
let WebSocketServer: any;
let WebSocket: any;

interface BotRegistration {
  botId: string;
  audioStream: Readable;
  clients: Set<any>;
  audioInputProcess: ChildProcess | null;
}

export interface AudioWebSocketConfig {
  /** Port for the WebSocket server (if creating standalone HTTP server) */
  port?: number;
  /** Audio sample rate (default: 16000) */
  sampleRate?: number;
  /** Audio encoding (default: pcm_s16le) */
  encoding?: string;
  /** Number of channels (default: 1) */
  channels?: number;
  /** PulseAudio sink for audio output into meeting */
  pulseAudioSink?: string;
}

export class AudioWebSocketServer extends EventEmitter {
  private wss: any = null;
  private bots: Map<string, BotRegistration> = new Map();
  private config: Required<AudioWebSocketConfig>;
  private perParticipantAudioHandler: ((speakerId: string, pcmBuffer: Buffer) => void) | null = null;
  private videoChunkHandler: ((meetingId: string, chunk: Buffer) => void) | null = null;
  private meetingSignalHandler: ((meetingId: string, signal: { type: string; [key: string]: any }) => void) | null =
    null;
  /** Pending internal clients keyed by meetingId (from per-participant-init message) */
  private pendingInternalClients: Map<string, Set<any>> = new Map();
  /** Clients that connected but haven't sent a per-participant-init yet */
  private unidentifiedClients: Set<any> = new Set();

  constructor(config?: AudioWebSocketConfig) {
    super();
    this.config = {
      port: config?.port || 8765,
      sampleRate: config?.sampleRate || 16000,
      encoding: config?.encoding || 'pcm_s16le',
      channels: config?.channels || 1,
      pulseAudioSink: config?.pulseAudioSink || 'virtual_mic',
    };
  }

  /**
   * Register a handler for per-participant audio binary messages.
   */
  setPerParticipantAudioHandler(handler: (speakerId: string, pcmBuffer: Buffer) => void): void {
    this.perParticipantAudioHandler = handler;
  }

  /**
   * Register a handler for meeting signals (status changes, roster updates)
   * sent from the browser-side WebSocket interceptor.
   */
  onMeetingSignal(handler: (meetingId: string, signal: { type: string; [key: string]: any }) => void): void {
    this.meetingSignalHandler = handler;
  }

  /**
   * Register a handler for WebRTC video chunks (binary type=200) from the browser MediaRecorder.
   */
  onVideoChunk(handler: (meetingId: string, chunk: Buffer) => void): void {
    this.videoChunkHandler = handler;
  }

  /**
   * Attach the WebSocket server to an existing HTTP server.
   */
  async attach(server: HttpServer): Promise<void> {
    try {
      const ws = await import('ws');
      WebSocketServer = ws.WebSocketServer || ws.Server;
      WebSocket = ws.WebSocket || ws.default;
    } catch {
      throw new Error(
        'ws package is not installed. Install it with: pnpm --filter @aramis/bot-worker add ws @types/ws',
      );
    }

    // noServer: true — we handle upgrade routing ourselves below.
    // Without this, WebSocketServer attaches its own 'upgrade' listener
    // which conflicts with ours, causing "handleUpgrade called twice" crash.
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests to route by path
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/api\/bots\/([^/]+)\/audio$/);

      if (match) {
        // External API client connecting to /api/bots/{botId}/audio
        const botId = match[1];
        const bot = this.bots.get(botId);

        if (!bot) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(request, socket, head, (ws: any) => {
          this.handleConnection(ws, botId, url.searchParams);
        });
      } else if (url.pathname === '/' || url.pathname === '/per-participant-audio') {
        // Internal browser-side per-participant audio connection (ws://localhost:8765).
        // The browser inject script connects without a botId path.
        // Route to the first (and typically only) registered bot.
        const firstBotId = this.bots.keys().next().value;
        if (!firstBotId) {
          logger.warn('Per-participant WebSocket connection received but no bot registered yet, accepting anyway');
          // Accept the connection and hold it open; handleConnection will send config.
          // It will be associated with the next bot that registers.
          this.wss.handleUpgrade(request, socket, head, (ws: any) => {
            this.handleInternalConnection(ws, url.searchParams);
          });
          return;
        }

        this.wss.handleUpgrade(request, socket, head, (ws: any) => {
          this.handleConnection(ws, firstBotId, url.searchParams);
        });
      } else {
        socket.destroy();
      }
    });

    logger.info('WebSocket audio server attached to HTTP server');
  }

  /**
   * Register a bot's audio stream for WebSocket clients.
   */
  registerBot(botId: string, audioStream: Readable): void {
    if (this.bots.has(botId)) {
      logger.warn(`Bot ${botId} already registered, replacing`);
      this.unregisterBot(botId);
    }

    const registration: BotRegistration = {
      botId,
      audioStream,
      clients: new Set(),
      audioInputProcess: null,
    };

    // Listen to audio stream and forward to all connected WebSocket clients
    audioStream.on('data', (chunk: Buffer) => {
      const base64Data = chunk.toString('base64');
      const message = JSON.stringify({
        type: 'audio',
        data: base64Data,
        timestamp: Date.now(),
      });

      for (const client of registration.clients) {
        if (client.readyState === 1) {
          // OPEN
          try {
            client.send(message);
          } catch (error) {
            logger.error(`Failed to send audio to WebSocket client: ${error}`);
          }
        }
      }
    });

    this.bots.set(botId, registration);

    // Adopt pending internal clients that match this botId (meetingId)
    const pendingForBot = this.pendingInternalClients.get(botId);
    if (pendingForBot && pendingForBot.size > 0) {
      logger.info(`Adopting ${pendingForBot.size} pending internal WebSocket client(s) for bot ${botId}`);
      for (const client of pendingForBot) {
        if (client.readyState === 1) {
          // OPEN
          registration.clients.add(client);
        }
      }
      this.pendingInternalClients.delete(botId);
    }

    logger.info(`Bot ${botId} registered for WebSocket audio streaming`);
  }

  /**
   * Unregister a bot and close all its WebSocket connections.
   */
  /**
   * Broadcast a transcript segment to all WebSocket clients for a bot.
   */
  broadcastTranscript(
    botId: string,
    segment: { text: string; speaker?: string; startTime: number; endTime: number },
    isFinal: boolean,
  ): void {
    const bot = this.bots.get(botId);
    if (!bot) return;

    const message = JSON.stringify({
      type: 'transcript',
      data: {
        text: segment.text,
        speaker: segment.speaker,
        startTime: segment.startTime,
        endTime: segment.endTime,
        isFinal,
      },
      timestamp: Date.now(),
    });

    for (const client of bot.clients) {
      try {
        if (WebSocket && client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      } catch {
        // Ignore send errors
      }
    }
  }

  unregisterBot(botId: string): void {
    const bot = this.bots.get(botId);
    if (!bot) return;

    // Close all client connections
    for (const client of bot.clients) {
      try {
        client.close(1000, 'Bot session ended');
      } catch {
        // Ignore close errors
      }
    }

    // Stop audio input process if running
    if (bot.audioInputProcess) {
      bot.audioInputProcess.kill('SIGTERM');
    }

    this.bots.delete(botId);
    logger.info(`Bot ${botId} unregistered from WebSocket audio streaming`);
  }

  /**
   * Handle an internal per-participant WebSocket connection when no bot is registered yet.
   * Keeps the connection open and routes it to the first bot that registers.
   */
  private handleInternalConnection(ws: any, params: URLSearchParams): void {
    logger.info('Internal per-participant WebSocket connected, waiting for bot registration');
    this.unidentifiedClients.add(ws);

    // Track the meetingId once we learn it from per-participant-init
    let clientMeetingId: string | null = null;

    // Handle incoming messages (mostly per-participant-init and binary audio)
    ws.on('message', (data: any, isBinary: boolean) => {
      if (isBinary && data instanceof Buffer) {
        if (data.length < 4) return;
        const messageType = data.readInt32LE(0);

        if (messageType === 1) {
          // JSON signal message: [4 bytes type=1][JSON payload]
          this.handleBinaryJsonSignal(data.subarray(4), clientMeetingId);
          return;
        }

        if (messageType === 100) {
          if (data.length < 6) return;
          const idLength = data.readUInt8(4);
          if (data.length < 5 + idLength) return;
          const speakerId = data.toString('utf-8', 5, 5 + idLength);
          const pcmBuffer = data.subarray(5 + idLength);
          if (this.perParticipantAudioHandler && pcmBuffer.length > 0) {
            this.perParticipantAudioHandler(speakerId, pcmBuffer);
          }
        } else if (messageType === 200) {
          // WebRTC video chunk from browser MediaRecorder
          const videoData = Buffer.from(data.buffer, data.byteOffset + 4, data.byteLength - 4);
          if (this.videoChunkHandler) {
            const resolvedMeetingId = clientMeetingId || this.bots.keys().next().value || 'unknown';
            this.videoChunkHandler(resolvedMeetingId, videoData);
          }
        }
        return;
      }
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'per-participant-init') {
          const meetingId = message.meetingId;
          clientMeetingId = meetingId;
          logger.info('Per-participant audio source connected (pre-registration)', { meetingId });

          // Move from unidentified to the correct meeting's pending set
          this.unidentifiedClients.delete(ws);

          // If a bot is already registered for this meetingId, adopt immediately
          const bot = this.bots.get(meetingId);
          if (bot) {
            bot.clients.add(ws);
            logger.info(`Adopted internal client directly for already-registered bot ${meetingId}`);
          } else {
            // Park in the pending map keyed by meetingId
            let pending = this.pendingInternalClients.get(meetingId);
            if (!pending) {
              pending = new Set();
              this.pendingInternalClients.set(meetingId, pending);
            }
            pending.add(ws);
            logger.info(`Parked internal client pending bot registration for meetingId ${meetingId}`);
          }
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', () => {
      this.unidentifiedClients.delete(ws);
      // Also remove from any pending set
      for (const [meetingId, pending] of this.pendingInternalClients) {
        if (pending.delete(ws)) {
          if (pending.size === 0) this.pendingInternalClients.delete(meetingId);
          break;
        }
      }
      logger.info('Internal per-participant WebSocket disconnected');
    });

    ws.on('error', (error: Error) => {
      this.unidentifiedClients.delete(ws);
      for (const [meetingId, pending] of this.pendingInternalClients) {
        if (pending.delete(ws)) {
          if (pending.size === 0) this.pendingInternalClients.delete(meetingId);
          break;
        }
      }
      logger.error(`Internal per-participant WebSocket error: ${error.message}`);
    });

    // Send config so the browser side knows the connection is alive
    ws.send(
      JSON.stringify({
        type: 'config',
        sampleRate: this.config.sampleRate,
        encoding: this.config.encoding,
        channels: this.config.channels,
      }),
    );
  }

  /**
   * Handle a new WebSocket connection for a bot.
   */
  private handleConnection(ws: any, botId: string, params: URLSearchParams): void {
    const bot = this.bots.get(botId);
    if (!bot) {
      ws.close(1008, 'Bot not found');
      return;
    }

    const track = params.get('track') || 'mixed';
    logger.info(`WebSocket client connected for bot ${botId}, track: ${track}`);

    bot.clients.add(ws);

    // Handle incoming messages from client
    ws.on('message', (data: any, isBinary: boolean) => {
      if (isBinary && data instanceof Buffer) {
        // Binary message: [4 bytes type][payload]
        if (data.length < 4) return;

        const messageType = data.readInt32LE(0);

        if (messageType === 1) {
          // JSON signal message: [4 bytes type=1][JSON payload]
          this.handleBinaryJsonSignal(data.subarray(4), botId);
          return;
        }

        if (messageType === 100) {
          // PER_PARTICIPANT_AUDIO
          // Format: [4 bytes type][1 byte id length][N bytes id][remaining: PCM]
          if (data.length < 6) return;
          const idLength = data.readUInt8(4);
          if (data.length < 5 + idLength) return;

          const speakerId = data.toString('utf-8', 5, 5 + idLength);
          const pcmBuffer = data.subarray(5 + idLength);

          if (this.perParticipantAudioHandler && pcmBuffer.length > 0) {
            this.perParticipantAudioHandler(speakerId, pcmBuffer);
          }
        } else if (messageType === 200) {
          // WebRTC video chunk from browser MediaRecorder
          const videoData = Buffer.from(data.buffer, data.byteOffset + 4, data.byteLength - 4);
          if (this.videoChunkHandler) {
            this.videoChunkHandler(botId, videoData);
          }
        }
        return;
      }

      // Existing JSON message handling
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'per-participant-init') {
          logger.info('Per-participant audio source connected', { meetingId: message.meetingId });
          return;
        }

        if (message.type === 'audio' && message.data) {
          const audioBuffer = Buffer.from(message.data, 'base64');
          this.playAudioIntoMeeting(botId, audioBuffer);
        }
      } catch (error) {
        logger.error(`Error processing WebSocket message: ${error}`);
      }
    });

    ws.on('close', () => {
      bot.clients.delete(ws);
      logger.info(`WebSocket client disconnected from bot ${botId}`);
    });

    ws.on('error', (error: Error) => {
      logger.error(`WebSocket error for bot ${botId}: ${error.message}`);
      bot.clients.delete(ws);
    });

    // Send initial config to client
    ws.send(
      JSON.stringify({
        type: 'config',
        sampleRate: this.config.sampleRate,
        encoding: this.config.encoding,
        channels: this.config.channels,
      }),
    );
  }

  /**
   * Parse a binary type=1 JSON signal message and dispatch to the meeting signal handler.
   * Handles MeetingStatusChange, RosterUpdate, DominantSpeaker, Caption, and SourceRequest
   * messages from the browser interceptor.
   */
  private handleBinaryJsonSignal(jsonPayload: Buffer, meetingId: string | null): void {
    try {
      const jsonData = JSON.parse(jsonPayload.toString('utf-8'));

      const signalTypes = [
        'MeetingStatusChange',
        'RosterUpdate',
        'DominantSpeaker',
        'Caption',
        'SourceRequest',
        'WebRTCVideoStart',
        'WebRTCVideoStop',
      ];
      if (signalTypes.includes(jsonData.type)) {
        const resolvedMeetingId = meetingId || this.bots.keys().next().value || 'unknown';
        logger.info(`Meeting signal: ${jsonData.type}`, {
          meetingId: resolvedMeetingId,
          ...(jsonData.type === 'MeetingStatusChange' ? { change: jsonData.change } : {}),
          ...(jsonData.type === 'RosterUpdate' ? { activeParticipantCount: jsonData.activeParticipantCount } : {}),
          ...(jsonData.type === 'DominantSpeaker' ? { streamId: jsonData.streamId } : {}),
          ...(jsonData.type === 'Caption' ? { text: jsonData.text?.substring(0, 50), isFinal: jsonData.isFinal } : {}),
          ...(jsonData.type === 'SourceRequest' ? { streamCount: jsonData.streams?.length } : {}),
        });

        if (this.meetingSignalHandler) {
          this.meetingSignalHandler(resolvedMeetingId, jsonData);
        }
      }
    } catch (error) {
      logger.error(`Failed to parse binary JSON signal: ${error}`);
    }
  }

  /**
   * Play audio data into the meeting via PulseAudio virtual mic.
   * Uses FFmpeg to pipe PCM data to a PulseAudio sink.
   */
  private playAudioIntoMeeting(botId: string, audioData: Buffer): void {
    const bot = this.bots.get(botId);
    if (!bot) return;

    // Create or reuse the audio input process
    if (!bot.audioInputProcess || bot.audioInputProcess.killed) {
      const args = [
        '-f',
        's16le',
        '-ar',
        String(this.config.sampleRate),
        '-ac',
        String(this.config.channels),
        '-i',
        'pipe:0',
        '-f',
        'pulse',
        this.config.pulseAudioSink,
      ];

      bot.audioInputProcess = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      bot.audioInputProcess.on('error', (error) => {
        logger.error(`Audio input process error: ${error.message}`);
      });

      bot.audioInputProcess.on('exit', () => {
        if (bot.audioInputProcess) {
          bot.audioInputProcess = null;
        }
      });
    }

    // Write audio data to FFmpeg stdin
    try {
      bot.audioInputProcess.stdin?.write(audioData);
    } catch (error) {
      logger.error(`Failed to write audio to input process: ${error}`);
    }
  }

  /**
   * Close the WebSocket server and all connections.
   */
  async close(): Promise<void> {
    // Unregister all bots
    for (const botId of this.bots.keys()) {
      this.unregisterBot(botId);
    }

    // Close any pending/unidentified clients
    for (const pending of this.pendingInternalClients.values()) {
      for (const client of pending) {
        try {
          client.close(1000, 'Server shutting down');
        } catch {
          /* ignore */
        }
      }
    }
    this.pendingInternalClients.clear();
    for (const client of this.unidentifiedClients) {
      try {
        client.close(1000, 'Server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.unidentifiedClients.clear();

    // Close the WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    logger.info('WebSocket audio server closed');
  }
}
