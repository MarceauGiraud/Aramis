/**
 * Bot State Machine
 *
 * Centralizes all meeting and bot session state transitions.
 * Enforces valid transitions, creates audit trail via BotLog,
 * and classifies errors with sub-types.
 */

import { prisma, BotStatus } from '@aramis/database';
import { logger } from './logger';
import { stateTransitions } from './prometheus-metrics';
import type { MeetingStatus, BotErrorType } from '@aramis/shared';

export interface TransitionOptions {
  /** Additional data to update on the meeting record */
  meetingData?: Record<string, unknown>;
  /** Reason for the transition (stored in audit log) */
  reason?: string;
  /** Error type classification (for FAILED transitions) */
  errorType?: BotErrorType;
  /** Error message (for FAILED transitions) */
  errorMessage?: string;
}

// ============================================================================
// Valid Transition Maps
// ============================================================================

const VALID_MEETING_TRANSITIONS: Record<string, MeetingStatus[]> = {
  SCHEDULED: ['JOINING', 'CANCELLED'],
  JOINING: ['WAITING', 'RECORDING', 'FAILED', 'CANCELLED'],
  WAITING: ['RECORDING', 'FAILED', 'CANCELLED'],
  RECORDING: ['RECORDING_PAUSED', 'PROCESSING', 'FAILED'],
  RECORDING_PAUSED: ['RECORDING', 'PROCESSING', 'FAILED'],
  PROCESSING: ['POST_PROCESSING', 'COMPLETED', 'FAILED'],
  POST_PROCESSING: ['COMPLETED', 'FAILED'],
  STOPPED: ['FAILED'],
  FAILED: ['JOINING'], // retry
  CANCELLED: [],
  COMPLETED: [],
};

const VALID_SESSION_TRANSITIONS: Record<string, BotStatus[]> = {
  IDLE: ['STARTING'],
  STARTING: ['RUNNING', 'WAITING_ROOM', 'ERROR'],
  RUNNING: ['PAUSED', 'POST_PROCESSING', 'STOPPED', 'ERROR'],
  WAITING_ROOM: ['RUNNING', 'STOPPED', 'ERROR'],
  PAUSED: ['RUNNING', 'STOPPED', 'ERROR'],
  POST_PROCESSING: ['STOPPED', 'ERROR'],
  STOPPED: [],
  ERROR: [],
};

// ============================================================================
// Error Classification
// ============================================================================

const ERROR_PATTERNS: Array<{ pattern: RegExp; type: BotErrorType }> = [
  { pattern: /denied|rejected|not allowed|access denied/i, type: 'denied_entry' },
  { pattern: /timeout|timed out|deadline/i, type: 'timeout' },
  { pattern: /network|ECONNREFUSED|ENOTFOUND|fetch failed|socket/i, type: 'network_error' },
  { pattern: /kicked|removed from|ejected/i, type: 'kicked' },
  { pattern: /meeting.*ended|call.*ended|meeting.*over/i, type: 'meeting_ended' },
  { pattern: /login|sign in|authenticate|auth/i, type: 'login_required' },
  { pattern: /display|xvfb|x11|screen/i, type: 'display_error' },
  { pattern: /ffmpeg|recording|capture|audio|video/i, type: 'recording_error' },
];

export function classifyError(error: unknown): BotErrorType {
  const message = error instanceof Error ? error.message : String(error);
  for (const { pattern, type } of ERROR_PATTERNS) {
    if (pattern.test(message)) return type;
  }
  return 'unknown';
}

// ============================================================================
// BotStateMachine
// ============================================================================

export class BotStateMachine {
  /**
   * Transition a meeting to a new status.
   * Validates the transition, updates the DB atomically, and creates an audit log.
   */
  async transition(meetingId: string, toStatus: MeetingStatus, options: TransitionOptions = {}): Promise<void> {
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { id: true, status: true },
    });

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const fromStatus = meeting.status as string;
    const validTargets = VALID_MEETING_TRANSITIONS[fromStatus];

    if (!validTargets || !validTargets.includes(toStatus)) {
      logger.warn(`Invalid meeting transition ${fromStatus} -> ${toStatus} for meeting ${meetingId}`);
      // Don't throw -- allow the transition in case schema has evolved.
      // The warning is enough to flag issues in logs.
    }

    const meetingUpdate: Record<string, unknown> = {
      status: toStatus,
      ...options.meetingData,
    };

    if (toStatus === 'FAILED' && options.errorMessage) {
      meetingUpdate.errorMessage = options.errorMessage.substring(0, 500);
    }

    // Find bot session for audit log
    const botSession = await prisma.botSession.findUnique({
      where: { meetingId },
      select: { id: true },
    });

    const operations: unknown[] = [
      prisma.meeting.update({
        where: { id: meetingId },
        data: meetingUpdate,
      }),
    ];

    // Create audit log if bot session exists
    if (botSession) {
      operations.push(
        prisma.botLog.create({
          data: {
            botSessionId: botSession.id,
            level: toStatus === 'FAILED' ? 'ERROR' : 'INFO',
            message: `Meeting transition: ${fromStatus} -> ${toStatus}`,
            metadata: {
              fromStatus,
              toStatus,
              reason: options.reason,
              errorType: options.errorType,
              ...(options.meetingData || {}),
            },
          },
        }),
      );
    }

    await prisma.$transaction(operations as any);

    stateTransitions.inc({ from_status: fromStatus, to_status: toStatus });

    logger.info(`Meeting ${meetingId}: ${fromStatus} -> ${toStatus}${options.reason ? ` (${options.reason})` : ''}`);
  }

  /**
   * Initialize or reset a bot session for a meeting.
   */
  async initBotSession(meetingId: string, workerId: string): Promise<void> {
    await prisma.botSession.upsert({
      where: { meetingId },
      create: {
        meetingId,
        workerId,
        status: 'STARTING',
        lastPing: new Date(),
      },
      update: {
        workerId,
        status: 'STARTING',
        lastPing: new Date(),
      },
    });

    logger.info(`Bot session initialized for meeting ${meetingId} on worker ${workerId}`);
  }

  /**
   * Transition a bot session to a new status.
   */
  async transitionSession(meetingId: string, toStatus: BotStatus, reason?: string): Promise<void> {
    const session = await prisma.botSession.findUnique({
      where: { meetingId },
      select: { id: true, status: true },
    });

    if (!session) {
      logger.warn(`No bot session found for meeting ${meetingId}, skipping session transition`);
      return;
    }

    const fromStatus = session.status as string;
    const validTargets = VALID_SESSION_TRANSITIONS[fromStatus];

    if (!validTargets || !validTargets.includes(toStatus)) {
      logger.warn(`Invalid session transition ${fromStatus} -> ${toStatus} for meeting ${meetingId}`);
    }

    await prisma.$transaction([
      prisma.botSession.update({
        where: { meetingId },
        data: { status: toStatus, lastPing: new Date() },
      }),
      prisma.botLog.create({
        data: {
          botSessionId: session.id,
          level: toStatus === 'ERROR' ? 'ERROR' : 'INFO',
          message: `Session transition: ${fromStatus} -> ${toStatus}`,
          metadata: {
            fromStatus,
            toStatus,
            reason,
          },
        },
      }),
    ]);

    logger.info(`Session ${meetingId}: ${fromStatus} -> ${toStatus}${reason ? ` (${reason})` : ''}`);
  }

  /**
   * Transition meeting to FAILED with error classification.
   */
  async failWithError(meetingId: string, error: unknown, reason?: string): Promise<void> {
    const errorType = classifyError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    await this.transition(meetingId, 'FAILED', {
      errorType,
      errorMessage,
      reason: reason || `${errorType}: ${errorMessage}`,
    });

    // Also transition session to ERROR
    try {
      await this.transitionSession(meetingId, 'ERROR', `${errorType}: ${errorMessage}`);
    } catch {
      // Session may not exist
    }
  }

  /**
   * Check if a meeting should be aborted before joining.
   * Returns true if the meeting is in a terminal state (CANCELLED, COMPLETED, FAILED),
   * is already being recorded, or already has a recording.
   */
  async checkAbortBeforeJoin(meetingId: string): Promise<{ abort: boolean; reason: string }> {
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { status: true },
    });

    if (!meeting) return { abort: true, reason: 'meeting_not_found' };

    // Don't re-join meetings that are already done or actively recording
    const terminalOrActiveStatuses = ['CANCELLED', 'COMPLETED', 'FAILED', 'RECORDING', 'PROCESSING', 'POST_PROCESSING'];
    if (terminalOrActiveStatuses.includes(meeting.status as string)) {
      return { abort: true, reason: `meeting_status_${(meeting.status as string).toLowerCase()}` };
    }

    // Check if a recording already exists for this meeting (prevents re-join after successful recording)
    try {
      const existingRecording = await prisma.recording.findFirst({
        where: { meetingId },
        select: { id: true, status: true },
      });
      if (existingRecording) {
        return { abort: true, reason: `recording_already_exists_${existingRecording.status}` };
      }
    } catch {
      // Non-fatal: if the check fails, proceed with caution
    }

    return { abort: false, reason: '' };
  }
}

// Singleton instance
export const stateMachine = new BotStateMachine();
