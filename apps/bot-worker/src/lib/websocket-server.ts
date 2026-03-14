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
   * Attach the WebSocket server to an existing HTTP server.
   */
  async attach(server: HttpServer): Promise<void> {
    try {
      const ws = await import('ws');
      WebSocketServer = ws.WebSocketServer || ws.Server;
      WebSocket = ws.WebSocket || ws.default;
    } catch {
      throw new Error(
        'ws package is not installed. Install it with: pnpm --filter @aramis/bot-worker add ws @types/ws'
      );
    }

    this.wss = new WebSocketServer({ server, path: undefined });

    // Handle upgrade requests to route by path
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/api\/bots\/([^/]+)\/audio$/);

      if (!match) {
        socket.destroy();
        return;
      }

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
        if (client.readyState === 1) { // OPEN
          try {
            client.send(message);
          } catch (error) {
            logger.error(`Failed to send audio to WebSocket client: ${error}`);
          }
        }
      }
    });

    this.bots.set(botId, registration);
    logger.info(`Bot ${botId} registered for WebSocket audio streaming`);
  }

  /**
   * Unregister a bot and close all its WebSocket connections.
   */
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

    // Handle incoming audio from client (to be played into meeting)
    ws.on('message', (data: any) => {
      try {
        const message = JSON.parse(data.toString());
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
    ws.send(JSON.stringify({
      type: 'config',
      sampleRate: this.config.sampleRate,
      encoding: this.config.encoding,
      channels: this.config.channels,
    }));
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
        '-f', 's16le',
        '-ar', String(this.config.sampleRate),
        '-ac', String(this.config.channels),
        '-i', 'pipe:0',
        '-f', 'pulse',
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

    // Close the WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    logger.info('WebSocket audio server closed');
  }
}
