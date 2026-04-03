import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { BOT_CONFIG, BOT_COMMANDS_CHANNEL } from '@aramis/shared';
import type { BotCommand, RecordingConfig } from '@aramis/shared';
import { MeetingBotFactory } from './bots/factory';
import { BaseMeetingBot } from './bots/base';
import { logger } from './lib/logger';
import { AudioWebSocketServer } from './lib/websocket-server';
import { kasarClient } from './lib/kasar-client';
import { classifyError } from './lib/bot-state-machine';
import { displayAllocator } from './lib/display-allocator';
import { LiveTranscriptionManager } from './lib/live-transcription';
import { PerParticipantAudioManager } from './lib/per-participant-audio/manager';
import { SpeakerReconciler } from './lib/speaker-reconciler';
import * as promMetrics from './lib/prometheus-metrics';

/**
 * Dependencies injected from the bootstrap (index.ts).
 */
export interface JobHandlerDeps {
  redis: IORedis;
  redisSub: IORedis;
  transcriptionQueue: Queue;
  wsServer: AudioWebSocketServer;
  workerId: string;
}

/**
 * Check deduplication key via Redis to prevent duplicate bots.
 */
async function checkDeduplication(redis: IORedis, meetingId: string): Promise<boolean> {
  try {
    const existing = await redis.get(`bot:active:${meetingId}`);
    if (existing) {
      logger.info(`Deduplication: bot already active for meeting ${meetingId}`);
      return true;
    }
  } catch (error) {
    logger.warn(`Deduplication check failed: ${error}`);
  }
  return false;
}

/**
 * Start heartbeat interval for a bot session via Redis.
 */
function startHeartbeat(redis: IORedis, meetingId: string): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await redis.set(`bot:heartbeat:${meetingId}`, String(Date.now()), 'EX', 120);
    } catch (error) {
      logger.debug(`Heartbeat update failed for ${meetingId}: ${error}`);
    }
  }, BOT_CONFIG.HEARTBEAT_INTERVAL_MS);
}

/**
 * Set up Redis pub/sub command channel for a meeting.
 * Returns a cleanup function to unsubscribe.
 */
function setupCommandChannel(redisSub: IORedis, meetingId: string, bot: BaseMeetingBot): () => void {
  const channel = `${BOT_COMMANDS_CHANNEL}:${meetingId}`;

  const messageHandler = (_channel: string, message: string): void => {
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      const command = parsed as unknown as BotCommand;
      const action = (parsed.type as string) || command.action;
      logger.info(`Received command for ${meetingId}: ${action}`);

      switch (action) {
        case 'pause':
          bot.pauseRecording();
          break;
        case 'resume':
          bot.resumeRecording();
          break;
        case 'leave':
          bot.leave().catch((err) => logger.error(`Leave command failed: ${err}`));
          break;
        case 'send_chat':
          logger.info(`Send-chat command received: ${JSON.stringify(command.data)}`);
          break;
        default:
          logger.warn(`Unknown command: ${String(action)}`);
      }
    } catch (error) {
      logger.error(`Failed to process command: ${error}`);
    }
  };

  redisSub.subscribe(channel).catch((err: Error) => {
    logger.error(`Failed to subscribe to ${channel}: ${err}`);
  });
  redisSub.on('message', messageHandler);

  logger.info(`Subscribed to command channel: ${channel}`);

  // Return cleanup function
  return () => {
    redisSub.unsubscribe(channel).catch(() => {});
    redisSub.removeListener('message', messageHandler);
    logger.info(`Unsubscribed from command channel: ${channel}`);
  };
}

/**
 * Process a single meeting-bot job. This is the callback passed to the
 * BullMQ Worker for the MEETING_BOT queue.
 */
export async function processMeetingJob(job: Job, deps: JobHandlerDeps): Promise<unknown> {
  const { redis, redisSub, transcriptionQueue, wsServer, workerId } = deps;

  const { meetingId, meetingUrl, platform, botName, recordingConfig } = job.data;

  // Validate required fields
  if (!meetingId || !meetingUrl || !platform) {
    throw new Error('Missing required job data: meetingId, meetingUrl, or platform');
  }

  logger.info(`Processing job ${job.id}: Join meeting ${meetingId}`);

  // Track active sessions
  promMetrics.activeSessions.inc();
  promMetrics.activeDisplays.set(displayAllocator.getActiveCount());
  const jobStartTime = Date.now();

  // Deduplication check
  if (await checkDeduplication(redis, meetingId)) {
    logger.info(`Skipping duplicate bot for meeting ${meetingId}`);
    return { success: false, reason: 'duplicate' };
  }

  // Verify meeting exists in Kasar
  const meetingCheck = await kasarClient.checkMeetingStatus(meetingId);
  if (!meetingCheck.exists) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  // Check if meeting should be aborted before joining
  if (['ready', 'failed'].includes(meetingCheck.status) || meetingCheck.hasRecording) {
    logger.info(`Meeting ${meetingId} skipped before join: status=${meetingCheck.status}`);
    return { success: false, reason: `meeting_${meetingCheck.status}` };
  }

  // Initialize bot session in Redis
  await redis.set(`bot:active:${meetingId}`, workerId, 'EX', 14400); // 4h TTL

  // Create the appropriate bot for the platform
  // Allocate a unique display + PulseAudio sink for this bot
  const display = await displayAllocator.allocate(meetingId);

  const bot = MeetingBotFactory.create(platform, {
    meetingId,
    meetingUrl,
    botName: botName || process.env.BOT_NAME || 'Aramis Recorder',
    platform,
    recordingConfig: recordingConfig as RecordingConfig | undefined,
    display: display.displayName,
    audioSource: display.pulseAudioSource,
  });

  // Start heartbeat
  const heartbeatInterval = startHeartbeat(redis, meetingId);

  // Set up command channel
  const cleanupCommandChannel = setupCommandChannel(redisSub, meetingId, bot);

  let liveTranscription: LiveTranscriptionManager | null = null;
  let perParticipantManager: PerParticipantAudioManager | null = null;

  try {
    // Initialize and join
    await bot.initialize();

    await bot.join();

    // Notify Kasar that bot has joined
    await kasarClient.notifyBotJoined(meetingId);

    // Track join duration
    const joinedAt = new Date();
    promMetrics.joinDuration.observe((joinedAt.getTime() - jobStartTime) / 1000);

    // Register audio stream for WebSocket if available
    const orchestrator = bot.getRecordingOrchestrator();

    // Listen for recording segment rotation events from the orchestrator
    if (orchestrator) {
      orchestrator.on('recording-rotated', (segmentInfo: unknown) => {
        logger.info(`Recording segment rotated for ${meetingId}`, {
          segment: segmentInfo,
        });
      });
    }

    if (orchestrator && typeof orchestrator.getAudioStream === 'function') {
      const audioStream = orchestrator.getAudioStream();
      if (audioStream) {
        wsServer.registerBot(meetingId, audioStream);

        // Wire WebSocket meeting signals (e.g., Teams CDN) to the bot
        wsServer.onMeetingSignal((signalMeetingId, signal) => {
          if (bot && signalMeetingId === meetingId) {
            bot.handleMeetingSignal(signal);
          }
        });

        // Wire WebRTC video chunks from browser to recording orchestrator
        wsServer.onVideoChunk((videoMeetingId, chunk) => {
          if (bot && videoMeetingId === meetingId) {
            const orch = bot.getRecordingOrchestrator();
            if (orch) {
              orch.writeWebRTCVideoChunk(chunk);
            }
          }
        });

        // Wire live transcription if provider supports it
        try {
          // Per-participant audio (CSRC-based speaker attribution) only works on
          // Google Meet. On Teams/Zoom the browser-inject pipeline doesn't produce
          // audio chunks, so we fall back to mixed audio transcription.
          if (platform === 'GOOGLE_MEET') {
            perParticipantManager = bot.getPerParticipantManager?.();
          }

          // Guard against unhandled 'error' events on EventEmitter — without
          // a listener Node.js throws and crashes the entire worker process.
          if (perParticipantManager) {
            perParticipantManager.on('error', (err: Error) => {
              logger.warn(`Per-participant audio error (non-fatal): ${err.message}`);
            });
          }

          liveTranscription = new LiveTranscriptionManager({
            meetingId,
            providerName: job.data.transcriptionConfig?.provider || 'deepgram',
            sampleRate: 16000,
            encoding: 'linear16',
            language: job.data.transcriptionConfig?.language,
          });

          liveTranscription.on(
            'transcript',
            (
              segment: { text: string; speaker?: string; startTime: number; endTime: number; confidence?: number },
              isFinal: boolean,
            ) => {
              // Receiving a transcript proves humans are speaking in the meeting
              bot.handleMeetingSignal({ type: 'HumanSpeechDetected' });

              // Track metrics
              promMetrics.transcriptionSegments.inc({
                provider: job.data.transcriptionConfig?.provider || 'deepgram',
                is_final: String(isFinal),
              });

              if (isFinal) {
                kasarClient
                  .sendTranscriptChunk(meetingId, [
                    {
                      start: segment.startTime,
                      end: segment.endTime,
                      speaker: segment.speaker || 'Unknown',
                      text: segment.text,
                      confidence: segment.confidence,
                    },
                  ])
                  .catch((err) => logger.warn(`Transcript chunk send failed: ${err}`));
              }
              // Forward to WebSocket clients
              wsServer.broadcastTranscript(meetingId, segment, isFinal);
            },
          );

          // Only pipe mixed audio to Deepgram when per-participant is NOT active.
          // Per-participant handles transcription independently -- running both
          // would produce duplicate transcripts and double the Deepgram cost.
          if (!perParticipantManager) {
            await liveTranscription.start(audioStream);
            logger.info(`Live transcription started for meeting ${meetingId} (mixed audio)`);
          } else {
            logger.info(`Skipping mixed audio live transcription for ${meetingId} (per-participant active)`);
          }

          // Wire per-participant audio transcription if available (overrides mixed audio diarization)
          if (perParticipantManager) {
            perParticipantManager.on(
              'transcript',
              (
                segment: { text?: string; speaker?: string; startTime?: number; endTime?: number; confidence?: number },
                isFinal: boolean,
              ) => {
                if (isFinal && segment.text) {
                  logger.info(`[Per-participant] ${segment.speaker}: ${segment.text}`);
                }
                // Broadcast via WebSocket
                if (wsServer) {
                  wsServer.broadcastTranscript(
                    meetingId,
                    {
                      text: segment.text || '',
                      speaker: segment.speaker,
                      startTime: segment.startTime || 0,
                      endTime: segment.endTime || 0,
                    },
                    isFinal,
                  );
                }
              },
            );
            logger.info('Per-participant audio transcription wired for meeting ' + meetingId);

            // Wire binary WebSocket per-participant audio to the manager
            if (perParticipantManager) {
              wsServer.setPerParticipantAudioHandler((speakerId: string, pcmBuffer: Buffer) => {
                if (perParticipantManager) {
                  // Forward binary PCM directly to manager (no base64 overhead)
                  perParticipantManager.handleBinaryAudioChunk(speakerId, pcmBuffer);
                }
              });
            }
          }
        } catch (err) {
          logger.warn(`Live transcription not available for ${meetingId}: ${err}`);
          liveTranscription = null;
        }
      }
    }

    // Wait for meeting to end or bot to be stopped
    await bot.waitForEnd();

    // Prefer per-participant segments over mixed audio segments
    let perParticipantSegments: { text: string; speaker?: string; startTime: number; endTime: number }[] | null = null;
    if (perParticipantManager) {
      try {
        perParticipantSegments = await perParticipantManager.stop();
        if (perParticipantSegments && perParticipantSegments.length > 0) {
          logger.info(`Per-participant capture produced ${perParticipantSegments.length} segments`);
        }
      } catch (e) {
        logger.warn(`Per-participant stop failed: ${e}`);
      }
    }

    // Stop live transcription and collect segments in memory
    let liveTranscriptData: {
      fullText: string;
      segments: Array<{ start: number; end: number; speaker: string; text: string; confidence?: number }>;
      speakers: Array<{ id: string; label: string; identifiedName?: string; totalDuration: number }>;
    } | null = null;
    if (liveTranscription) {
      try {
        await liveTranscription.stop();
        const segments = liveTranscription.getFinalSegments();
        if (segments.length > 0) {
          // Run speaker reconciliation before building the payload
          const speakerHistory = bot.getSpeakerHistory();
          if (speakerHistory.length > 0) {
            const reconciler = new SpeakerReconciler();
            const mapping = reconciler.reconcile(
              segments.map((s) => ({ speaker: s.speaker, startTime: s.startTime, endTime: s.endTime })),
              speakerHistory,
            );
            // Apply reconciled names to segments
            for (const seg of segments) {
              if (seg.speaker) {
                const name = mapping.labelToName.get(seg.speaker);
                if (name) seg.speaker = name;
              }
            }
          }

          // Collect unique speakers
          const speakerLabels = [...new Set(segments.map((s) => s.speaker).filter(Boolean))] as string[];
          const fullText = segments.map((s) => s.text).join(' ');
          liveTranscriptData = {
            fullText,
            segments: segments.map((s) => ({
              start: s.startTime,
              end: s.endTime,
              speaker: s.speaker || 'Unknown',
              text: s.text,
              confidence: s.confidence,
            })),
            speakers: speakerLabels.map((label) => ({
              id: label,
              label,
              identifiedName: label,
              totalDuration: segments
                .filter((s) => s.speaker === label)
                .reduce((sum, s) => sum + (s.endTime - s.startTime), 0),
            })),
          };
          logger.info(`Live transcript collected for meeting ${meetingId}: ${segments.length} segments`);
        }
      } catch (err) {
        logger.warn(`Failed to collect live transcript: ${err}`);
      }
    }

    // Unregister WebSocket audio stream
    wsServer.unregisterBot(meetingId);

    // Process recording (orchestrator handles S3 upload internally)
    let recordingPath: string | null = null;
    let recordingInfo: ReturnType<typeof bot.getRecordingInfo> = null;
    const noRecording = recordingConfig?.noRecording === true;

    if (!noRecording) {
      try {
        recordingPath = await bot.saveRecording();
        recordingInfo = bot.getRecordingInfo();
      } catch (saveError) {
        // S3 upload errors during save should NOT trigger a full re-join.
        // The recording data may still be available locally.
        const saveMsg = saveError instanceof Error ? saveError.message : String(saveError);
        logger.error(`Recording save/upload failed for ${meetingId}: ${saveMsg}`);
        promMetrics.errorsTotal.inc({ error_type: 'upload_error', phase: 'save_recording' });

        // Try to get whatever recording info is available (local paths)
        recordingInfo = bot.getRecordingInfo();
        recordingPath = recordingInfo?.mergedPath ?? recordingInfo?.videoPath ?? null;

        if (!recordingPath) {
          // No local recording either -- mark as failed but do NOT throw
          // (throwing would trigger BullMQ retry which re-joins the meeting)
          logger.error(`No recording available for ${meetingId} after save failure`);
          await kasarClient
            .notifyError(meetingId, `Recording save failed: ${saveMsg}`, 'save_recording')
            .catch((err) => {
              logger.error(`Failed to notify Kasar of error: ${err}`);
            });
          return { success: false, reason: 'recording_save_failed', error: saveMsg };
        }

        logger.warn(`Using local recording fallback for ${meetingId}: ${recordingPath}`);
      }
    }

    // Collect chat messages
    const chatMessages = bot.getChatMessages();
    const chatData = chatMessages.map((msg) => ({
      sender: msg.sender,
      message: msg.message,
      timestamp: msg.timestamp?.toISOString?.() || new Date().toISOString(),
      platform: msg.platform || platform,
    }));

    if (chatData.length > 0) {
      logger.info(`Collected ${chatData.length} chat messages for meeting ${meetingId}`);
    }

    // Collect participants
    let participantsData: Array<{ name: string; email?: string; isHost?: boolean }> = [];
    try {
      const extractedParticipants = await bot.extractParticipants();
      if (extractedParticipants.length > 0) {
        participantsData = extractedParticipants.map((p) => ({
          name: p.name,
          email: p.email ?? undefined,
          isHost: p.isHost ?? false,
        }));
      } else {
        const speakerNames = [...new Set(bot.getSpeakerHistory().map((s) => s.speaker))];
        participantsData = speakerNames.map((name) => ({ name, isHost: false }));
      }
    } catch (err) {
      logger.warn(`Failed to extract participants: ${err}`);
    }

    if (noRecording) {
      await kasarClient.notifyBotLeft(meetingId, 'no_recording_mode');
      return { success: true, noRecording: true, chatMessages: chatMessages.length };
    }

    // Determine the best video URL (S3 merged > S3 video > local path)
    const videoUrl = recordingInfo?.s3MergedUrl ?? recordingInfo?.s3VideoUrl ?? recordingPath;

    const s3Uploaded = !!(recordingInfo?.s3MergedUrl || recordingInfo?.s3VideoUrl);

    // Collect DOM-detected speaker history for transcription reconciliation
    const speakerHistory = bot.getSpeakerHistory();
    if (speakerHistory.length > 0) {
      logger.info(`Collected ${speakerHistory.length} DOM speaker events for meeting ${meetingId}`);
    }

    // If per-participant segments available, use them as transcript data
    if (perParticipantSegments && perParticipantSegments.length > 0) {
      logger.info(`Per-participant produced ${perParticipantSegments.length} segments — using as final transcript`);

      const fullText = perParticipantSegments.map((s) => s.text).join(' ');
      const speakerNames = [...new Set(perParticipantSegments.map((s) => s.speaker).filter(Boolean))] as string[];
      liveTranscriptData = {
        fullText,
        segments: perParticipantSegments.map((s) => ({
          start: s.startTime,
          end: s.endTime,
          speaker: s.speaker || 'Unknown',
          text: s.text,
          confidence: undefined,
        })),
        speakers: speakerNames.map((name) => ({
          id: name,
          label: name,
          identifiedName: name,
          totalDuration: 0,
        })),
      };
    } else {
      // Queue batch transcription if we have audio and no live transcript
      const audioUrl = recordingInfo?.s3AudioUrl;
      if (!liveTranscriptData && audioUrl && s3Uploaded && process.env.DEEPGRAM_API_KEY) {
        try {
          await transcriptionQueue.add(
            'transcribe',
            {
              meetingId,
              audioUrl,
              model: 'nova-3',
              language: 'detect',
              speakerHistory: speakerHistory.length > 0 ? speakerHistory : undefined,
            },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 10000 },
            },
          );
          logger.info(`Queued batch transcription (Nova-3, auto-detect language) for ${meetingId}`);
        } catch (queueError) {
          logger.error(`Failed to queue transcription: ${queueError}`);
        }
      } else if (!liveTranscriptData && !audioUrl) {
        logger.warn(`No audio available for ${meetingId} — skipping batch transcription`);
      }
    }

    // Track meeting duration
    promMetrics.meetingDuration.observe((Date.now() - jobStartTime) / 1000);

    // Build transcript payload
    const transcriptPayload = liveTranscriptData
      ? {
          fullText: liveTranscriptData.fullText,
          segments: liveTranscriptData.segments,
          speakers: liveTranscriptData.speakers,
          provider: job.data.transcriptionConfig?.provider || 'deepgram',
        }
      : undefined;

    // Send everything to Kasar via notifyRecordingComplete
    await kasarClient.notifyRecordingComplete(meetingId, {
      storagePath: videoUrl || '',
      duration: Math.floor((Date.now() - jobStartTime) / 1000),
      fileSize: 0,
      transcript: transcriptPayload,
      participants: participantsData.length > 0 ? participantsData : undefined,
      chatMessages: chatData.length > 0 ? chatData : undefined,
    });

    return { success: true, recordingPath: videoUrl, s3Uploaded };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error in meeting bot for ${meetingId}: ${errorMessage}`);

    // Notify Kasar of error
    await kasarClient.notifyError(meetingId, errorMessage, 'meeting_bot').catch((err) => {
      logger.error(`Failed to notify Kasar of error: ${err}`);
    });

    // Stop live transcription on error
    if (liveTranscription) {
      await liveTranscription.stop().catch(() => {});
    }

    // Unregister WebSocket audio stream on error
    wsServer.unregisterBot(meetingId);

    // Crash-safe: try to save whatever recording we have before cleanup
    if (bot && bot.isCurrentlyRecording()) {
      try {
        logger.info(`Crash-safe save: attempting to save recording for ${meetingId}`);
        const crashRecording = await bot.stopRecording();
        if (crashRecording) {
          const crashRecordingInfo = bot.getRecordingInfo();
          logger.info(`Crash-safe save: recording saved for ${meetingId}`, {
            videoUrl: crashRecordingInfo?.s3VideoUrl,
            audioUrl: crashRecordingInfo?.s3AudioUrl,
          });
        }
      } catch (saveError) {
        logger.error(`Crash-safe save failed for ${meetingId}: ${saveError}`);
      }
    }

    // Track error metric
    promMetrics.errorsTotal.inc({ error_type: classifyError(error), phase: 'meeting_bot' });

    // Do not re-throw — let the job complete to prevent BullMQ retry re-joining the meeting
    return { success: false, reason: 'error', error: errorMessage };
  } finally {
    // Track session end
    promMetrics.activeSessions.dec();
    promMetrics.activeDisplays.set(displayAllocator.getActiveCount());
    // Clean up heartbeat
    clearInterval(heartbeatInterval);

    // Clean up command channel
    cleanupCommandChannel();

    // Clean up Redis session keys
    await redis.del(`bot:active:${meetingId}`).catch(() => {});
    await redis.del(`bot:heartbeat:${meetingId}`).catch(() => {});

    try {
      await bot.cleanup();
    } catch (cleanupError) {
      logger.error(`Error during bot cleanup: ${cleanupError}`);
    }

    // Release display allocation
    try {
      await displayAllocator.release(meetingId);
    } catch (displayError) {
      logger.error(`Error releasing display for ${meetingId}: ${displayError}`);
    }
  }
}
