import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { BOT_CONFIG, BOT_COMMANDS_CHANNEL } from '@aramis/shared';
import type { BotCommand, RecordingConfig } from '@aramis/shared';
import { MeetingBotFactory } from './bots/factory';
import { BaseMeetingBot } from './bots/base';
import { logger } from './lib/logger';
import { AudioWebSocketServer } from './lib/websocket-server';
import { WebhookDispatcher } from './lib/webhook-dispatcher';
import { stateMachine, classifyError } from './lib/bot-state-machine';
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
  webhookDispatcher: WebhookDispatcher;
  workerId: string;
}

/**
 * Check deduplication key to prevent duplicate bots.
 */
async function checkDeduplication(deduplicationKey: string | undefined, meetingId: string): Promise<boolean> {
  if (!deduplicationKey) return false;

  try {
    const existing = await prisma.botSession.findFirst({
      where: {
        meetingId,
        status: { in: ['RUNNING', 'STARTING'] },
      },
    });

    if (existing) {
      logger.info(`Deduplication: bot already running for meeting ${meetingId} (session: ${existing.id})`);
      return true;
    }
  } catch (error) {
    logger.warn(`Deduplication check failed: ${error}`);
  }

  return false;
}

/**
 * Start heartbeat interval for a bot session.
 */
function startHeartbeat(meetingId: string): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await prisma.botSession.update({
        where: { meetingId },
        data: {
          lastPing: new Date(),
        },
      });
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
      const command: BotCommand = JSON.parse(message);
      logger.info(`Received command for ${meetingId}: ${command.action}`);

      switch (command.action) {
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
          // Chat sending is platform-specific; log for now
          logger.info(`Send-chat command received: ${JSON.stringify(command.data)}`);
          break;
        default:
          logger.warn(`Unknown command type: ${(command as any).type}`);
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
export async function processMeetingJob(job: Job, deps: JobHandlerDeps): Promise<any> {
  const { redis, redisSub, transcriptionQueue, wsServer, webhookDispatcher, workerId } = deps;

  const { meetingId, meetingUrl, platform, botName, recordingConfig, deduplicationKey, metadata } = job.data;

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
  if (await checkDeduplication(deduplicationKey, meetingId)) {
    logger.info(`Skipping duplicate bot for meeting ${meetingId}`);
    return { success: false, reason: 'duplicate' };
  }

  // Verify meeting exists before processing
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, status: true },
  });

  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  // Check if meeting should be aborted before joining
  // This guards against retries re-joining completed/failed/active meetings
  const abortCheck = await stateMachine.checkAbortBeforeJoin(meetingId);
  if (abortCheck.abort) {
    logger.info(`Meeting ${meetingId} skipped before join: ${abortCheck.reason}`);
    return { success: false, reason: abortCheck.reason };
  }

  // State transition: JOINING
  await stateMachine.transition(meetingId, 'JOINING', {
    reason: 'Worker picked up job',
  });

  // Initialize bot session
  await stateMachine.initBotSession(meetingId, workerId);

  // Register webhooks for this meeting
  await webhookDispatcher.registerWebhooks(meetingId);

  // Dispatch bot joining event
  await webhookDispatcher.dispatch({
    type: 'bot_joining',
    meetingId,
    timestamp: new Date(),
    data: { platform, meetingUrl },
  });

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
  const heartbeatInterval = startHeartbeat(meetingId);

  // Set up command channel
  const cleanupCommandChannel = setupCommandChannel(redisSub, meetingId, bot);

  let liveTranscription: LiveTranscriptionManager | null = null;
  let perParticipantManager: PerParticipantAudioManager | null = null;

  try {
    // Initialize and join
    await bot.initialize();

    // Update bot session to RUNNING
    await stateMachine.transitionSession(meetingId, 'RUNNING', 'Bot initialized');

    await bot.join();

    // Dispatch bot joined event
    await webhookDispatcher.dispatch({
      type: 'bot_joined',
      meetingId,
      timestamp: new Date(),
    });

    // State transition: RECORDING
    const joinedAt = new Date();
    promMetrics.joinDuration.observe((joinedAt.getTime() - jobStartTime) / 1000);

    await stateMachine.transition(meetingId, 'RECORDING', {
      meetingData: { actualStart: joinedAt },
      reason: 'Bot joined meeting',
    });

    // Dispatch recording started event
    await webhookDispatcher.dispatch({
      type: 'recording_started',
      meetingId,
      timestamp: new Date(),
    });

    // Register audio stream for WebSocket if available
    const orchestrator = bot.getRecordingOrchestrator();

    // Listen for recording segment rotation events from the orchestrator
    if (orchestrator) {
      orchestrator.on('recording-rotated', (segmentInfo: any) => {
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
          if (bot && signalMeetingId === meeting.id) {
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

          liveTranscription.on('transcript', (segment: any, isFinal: boolean) => {
            // Receiving a transcript proves humans are speaking in the meeting
            bot.handleMeetingSignal({ type: 'HumanSpeechDetected' });

            // Track metrics
            promMetrics.transcriptionSegments.inc({
              provider: job.data.transcriptionConfig?.provider || 'deepgram',
              is_final: String(isFinal),
            });

            if (isFinal) {
              webhookDispatcher.dispatch({
                type: 'transcript_segment',
                meetingId,
                timestamp: new Date(),
                data: {
                  text: segment.text,
                  speaker: segment.speaker,
                  startTime: segment.startTime,
                  endTime: segment.endTime,
                  confidence: segment.confidence,
                  isFinal: true,
                },
              });
            }
            // Forward to WebSocket clients
            wsServer.broadcastTranscript(meetingId, segment, isFinal);
          });

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
            perParticipantManager.on('transcript', (segment: any, isFinal: boolean) => {
              if (isFinal && segment.text) {
                logger.info(`[Per-participant] ${segment.speaker}: ${segment.text}`);
              }
              // Broadcast via WebSocket
              if (wsServer) {
                wsServer.broadcastTranscript(meetingId, segment, isFinal);
              }
            });
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

    // Stop live transcription and flush to database
    let liveTranscriptFlushed = false;
    if (liveTranscription) {
      try {
        await liveTranscription.stop();
        await liveTranscription.flushToDatabase();
        liveTranscriptFlushed = true;
        logger.info(`Live transcript flushed to database for meeting ${meetingId}`);
      } catch (err) {
        logger.warn(`Failed to flush live transcript: ${err}`);
      }
    }

    // Unregister WebSocket audio stream
    wsServer.unregisterBot(meetingId);

    // State transition: PROCESSING
    await stateMachine.transition(meetingId, 'PROCESSING', {
      reason: 'Meeting ended, processing recording',
    });

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
          await stateMachine.transition(meetingId, 'FAILED', {
            errorMessage: `Recording save failed: ${saveMsg}`,
            reason: 'Recording save/upload failed, no local fallback',
          });
          return { success: false, reason: 'recording_save_failed', error: saveMsg };
        }

        logger.warn(`Using local recording fallback for ${meetingId}: ${recordingPath}`);
      }
    }

    // Save chat messages to DB
    const chatMessages = bot.getChatMessages();
    if (chatMessages.length > 0) {
      logger.info(`Saving ${chatMessages.length} chat messages for meeting ${meetingId}`);
      try {
        for (const msg of chatMessages) {
          await (prisma as any).chatMessage.create({
            data: {
              meetingId,
              sender: msg.sender,
              message: msg.message,
              timestamp: msg.timestamp,
              platform: msg.platform,
            },
          });
        }
      } catch (chatError) {
        // ChatMessage model may not exist in schema yet
        logger.warn(`Failed to save chat messages (model may not exist): ${chatError}`);
      }
    }

    // Store detected participants in the database
    try {
      const extractedParticipants = await bot.extractParticipants();
      if (extractedParticipants.length > 0) {
        logger.info(`Storing ${extractedParticipants.length} participants for meeting ${meetingId}`);
        for (const p of extractedParticipants) {
          await prisma.participant.create({
            data: {
              meetingId,
              name: p.name,
              email: p.email ?? null,
              isHost: p.isHost ?? false,
            },
          });
        }
        logger.info(`Stored ${extractedParticipants.length} participants for meeting ${meetingId}`);
      } else {
        // Fall back to speaker history if extractParticipants returned nothing
        const speakerNames = [...new Set(bot.getSpeakerHistory().map((s) => s.speaker))];
        if (speakerNames.length > 0) {
          logger.info(`Storing ${speakerNames.length} participants from speaker history for meeting ${meetingId}`);
          for (const name of speakerNames) {
            await prisma.participant.create({
              data: {
                meetingId,
                name,
                isHost: false,
              },
            });
          }
        }
      }
    } catch (participantError) {
      logger.warn(`Failed to store participants (non-fatal): ${participantError}`);
    }

    if (noRecording) {
      // No recording mode: just update meeting status
      await stateMachine.transition(meetingId, 'COMPLETED', {
        meetingData: { actualEnd: new Date() },
        reason: 'No recording mode',
      });

      // Dispatch bot left event
      await webhookDispatcher.dispatch({
        type: 'bot_left',
        meetingId,
        timestamp: new Date(),
      });

      return { success: true, noRecording: true, chatMessages: chatMessages.length };
    }

    // Determine the best video URL (S3 merged > S3 video > local path)
    const videoUrl = recordingInfo?.s3MergedUrl ?? recordingInfo?.s3VideoUrl ?? recordingPath;

    const s3Uploaded = !!(recordingInfo?.s3MergedUrl || recordingInfo?.s3VideoUrl);

    // Update meeting with actualEnd (already in PROCESSING)
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { actualEnd: new Date() },
    });

    // Create recording record with both video and audio URLs
    const recording = await prisma.recording.create({
      data: {
        meetingId,
        videoUrl,
        audioUrl: recordingInfo?.s3AudioUrl ?? undefined,
        status: s3Uploaded ? 'COMPLETED' : 'PROCESSING',
      },
    });

    logger.info(`Meeting ${meetingId} recording saved: ${videoUrl}`);
    if (recordingInfo?.s3AudioUrl) {
      logger.info(`Audio available at: ${recordingInfo.s3AudioUrl}`);
    }

    // Dispatch recording stopped event
    await webhookDispatcher.dispatch({
      type: 'recording_stopped',
      meetingId,
      timestamp: new Date(),
      data: { videoUrl, s3Uploaded },
    });

    // Collect DOM-detected speaker history for transcription reconciliation
    const speakerHistory = bot.getSpeakerHistory();
    if (speakerHistory.length > 0) {
      logger.info(`Collected ${speakerHistory.length} DOM speaker events for meeting ${meetingId}`);
    }

    // Reconcile speaker names: either on the live transcript or via post-hoc job
    if (liveTranscriptFlushed && speakerHistory.length > 0) {
      // Live transcript already in DB -- reconcile speaker names directly
      try {
        const transcript = await prisma.transcript.findFirst({
          where: { meetingId },
          include: {
            speakers: true,
            segments: { include: { speaker: true } },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (transcript && transcript.segments.length > 0) {
          // Map Prisma segments to reconciler input (needs speaker label, not speakerId)
          const segmentsForReconciler = transcript.segments.map((seg) => ({
            speaker: seg.speaker?.label,
            startTime: seg.startTime,
            endTime: seg.endTime,
          }));

          const reconciler = new SpeakerReconciler();
          const mapping = reconciler.reconcile(segmentsForReconciler, speakerHistory);

          if (mapping.labelToName.size > 0) {
            for (const speaker of transcript.speakers) {
              const identifiedName = mapping.labelToName.get(speaker.label);
              if (identifiedName) {
                await prisma.transcriptSpeaker.update({
                  where: { id: speaker.id },
                  data: { identifiedName },
                });
              }
            }
            logger.info(
              `Speaker reconciliation applied to live transcript: ` + `${mapping.labelToName.size} names identified`,
            );
          }
        }
      } catch (reconcileError) {
        logger.warn(`Speaker reconciliation on live transcript failed (non-fatal): ${reconcileError}`);
      }
    }

    // Queue batch transcription only when per-participant didn't produce
    // enough segments. Per-participant segments already have real speaker
    // names; batch transcription would replace them with generic "Speaker N".
    const audioUrl = recordingInfo?.s3AudioUrl;
    if (perParticipantSegments && perParticipantSegments.length > 0) {
      logger.info(`Per-participant produced ${perParticipantSegments.length} segments — saving as final transcript`);

      // Save per-participant segments directly to the database since we skip
      // batch transcription (per-participant already has real speaker names).
      try {
        const fullText = perParticipantSegments.map((s) => s.text).join(' ');
        const avgConfidence =
          perParticipantSegments.reduce((sum, s) => sum + ((s as any).confidence || 0), 0) /
          perParticipantSegments.length;

        const transcript = await prisma.transcript.create({
          data: {
            meetingId,
            status: 'COMPLETED',
            provider: 'deepgram',
            fullText,
            language: 'fr',
            confidence: avgConfidence,
            wordCount: fullText.split(/\s+/).length,
          },
        });

        // Create speakers
        const speakerNames = [...new Set(perParticipantSegments.map((s) => s.speaker).filter(Boolean))] as string[];
        const speakerMap = new Map<string, string>();

        for (const name of speakerNames) {
          const speaker = await prisma.transcriptSpeaker.create({
            data: {
              transcriptId: transcript.id,
              label: name,
              identifiedName: name,
            },
          });
          speakerMap.set(name, speaker.id);
        }

        // Create segments
        for (let i = 0; i < perParticipantSegments.length; i++) {
          const seg = perParticipantSegments[i];
          await prisma.transcriptSegment.create({
            data: {
              transcriptId: transcript.id,
              speakerId: seg.speaker ? speakerMap.get(seg.speaker) : undefined,
              text: seg.text,
              startTime: seg.startTime,
              endTime: seg.endTime,
              confidence: (seg as any).confidence,
              order: i,
            },
          });
        }

        logger.info(`Saved ${perParticipantSegments.length} per-participant segments to database`);
      } catch (saveError) {
        logger.error(`Failed to save per-participant segments to database: ${saveError}`);
      }
    } else if (!audioUrl) {
      logger.warn(`No audio available for ${meetingId} — skipping batch transcription`);
    } else if (s3Uploaded && process.env.DEEPGRAM_API_KEY) {
      try {
        // Live transcript is kept until the batch job succeeds.
        // The transcription worker will atomically replace it in a transaction.

        await transcriptionQueue.add(
          'transcribe',
          {
            meetingId,
            recordingId: recording.id,
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
    }

    // Track meeting duration
    promMetrics.meetingDuration.observe((Date.now() - jobStartTime) / 1000);

    // State transition: COMPLETED
    await stateMachine.transition(meetingId, 'COMPLETED', {
      reason: 'Recording saved and transcription queued',
    });

    // Dispatch bot left event
    await webhookDispatcher.dispatch({
      type: 'bot_left',
      meetingId,
      timestamp: new Date(),
    });

    return { success: true, recordingPath: videoUrl, s3Uploaded };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error in meeting bot for ${meetingId}: ${errorMessage}`);

    // Dispatch error event
    await webhookDispatcher.dispatch({
      type: 'error',
      meetingId,
      timestamp: new Date(),
      data: { error: errorMessage },
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

    // Transition meeting to FAILED with error classification
    try {
      await stateMachine.failWithError(meetingId, error);
    } catch (updateError) {
      logger.error(`Failed to update meeting/session status: ${updateError}`);
    }

    throw error;
  } finally {
    // Track session end
    promMetrics.activeSessions.dec();
    promMetrics.activeDisplays.set(displayAllocator.getActiveCount());
    // Clean up heartbeat
    clearInterval(heartbeatInterval);

    // Clean up command channel
    cleanupCommandChannel();

    // Unregister webhooks for this meeting
    webhookDispatcher.unregisterWebhooks(meetingId);

    // Update bot session to STOPPED
    try {
      await stateMachine.transitionSession(meetingId, 'STOPPED', 'Job finished');
    } catch {
      // Ignore - session may not exist or already in terminal state
    }

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
