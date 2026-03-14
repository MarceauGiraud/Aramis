import { prisma } from '@aramis/database';
import { STALE_BOT_THRESHOLD_MS } from '@aramis/shared';
import { logger } from '../lib/logger';

/**
 * Find BotSessions with status RUNNING and heartbeatAt (lastPing) older than threshold.
 * Mark them as ERROR, update meeting to FAILED.
 */
export async function cleanupStaleBots(
  thresholdMs: number = STALE_BOT_THRESHOLD_MS
): Promise<number> {
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
      await prisma.$transaction([
        prisma.botSession.update({
          where: { id: session.id },
          data: { status: 'ERROR' },
        }),
        prisma.meeting.update({
          where: { id: session.meetingId },
          data: {
            status: 'FAILED',
            errorMessage: `Bot session became stale (no heartbeat since ${session.lastPing?.toISOString()})`,
          },
        }),
        prisma.botLog.create({
          data: {
            botSessionId: session.id,
            level: 'ERROR',
            message: 'Bot session marked as stale - no heartbeat received',
            metadata: {
              lastPing: session.lastPing?.toISOString(),
              threshold: `${thresholdMs}ms`,
            },
          },
        }),
      ]);

      logger.info(
        `Cleaned up stale session ${session.id} for meeting ${session.meetingId}`
      );
    } catch (error) {
      logger.error(
        `Failed to clean up session ${session.id}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  return staleSessions.length;
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
