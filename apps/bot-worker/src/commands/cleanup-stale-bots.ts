import { prisma } from '@aramis/database';
import { STALE_BOT_THRESHOLD_MS } from '@aramis/shared';
import { logger } from '../lib/logger';
import { stateMachine } from '../lib/bot-state-machine';

/**
 * Find BotSessions with status RUNNING and heartbeatAt (lastPing) older than threshold.
 * Mark them as ERROR, update meeting to FAILED.
 */
export async function cleanupStaleBots(thresholdMs: number = STALE_BOT_THRESHOLD_MS): Promise<number> {
  const cutoff = new Date(Date.now() - thresholdMs);

  const staleSessions = await prisma.botSession.findMany({
    where: {
      status: 'RUNNING',
      lastPing: { lt: cutoff },
    },
    include: {
      meeting: { select: { id: true, status: true } },
    },
  });

  if (staleSessions.length === 0) {
    logger.info('No stale bot sessions found');
    return 0;
  }

  logger.info(`Found ${staleSessions.length} stale bot session(s)`);

  for (const session of staleSessions) {
    try {
      const staleError = new Error(`Bot session became stale (no heartbeat since ${session.lastPing?.toISOString()})`);
      await stateMachine.failWithError(
        session.meetingId,
        staleError,
        `Stale bot cleanup (threshold: ${thresholdMs}ms)`,
      );

      logger.info(`Cleaned up stale session ${session.id} for meeting ${session.meetingId}`);
    } catch (error) {
      logger.error(`Failed to clean up session ${session.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Also clean up meetings stuck in PROCESSING or RECORDING with no active session.
  // This happens when the worker crashes during recording or post-processing.
  const stuckMeetings = await prisma.meeting.findMany({
    where: {
      status: { in: ['PROCESSING', 'RECORDING', 'JOINING'] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, status: true, updatedAt: true },
  });

  for (const meeting of stuckMeetings) {
    try {
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: {
          status: 'FAILED',
          errorMessage: `Meeting stuck in ${meeting.status} since ${meeting.updatedAt?.toISOString()} — auto-cleaned`,
        },
      });
      logger.info(
        `Cleaned up stuck meeting ${meeting.id} (was ${meeting.status} since ${meeting.updatedAt?.toISOString()})`,
      );
    } catch (error) {
      logger.error(`Failed to clean up stuck meeting ${meeting.id}: ${error}`);
    }
  }

  if (stuckMeetings.length > 0) {
    logger.info(`Cleaned up ${stuckMeetings.length} stuck meeting(s)`);
  }

  return staleSessions.length + stuckMeetings.length;
}

// CLI entry point
if (require.main === module) {
  cleanupStaleBots()
    .then((count) => {
      console.log(`Cleaned up ${count} stale bot session(s)`);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error:', error);
      process.exit(1);
    });
}
