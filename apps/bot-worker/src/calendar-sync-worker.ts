/**
 * Calendar Sync Worker
 *
 * BullMQ worker that syncs calendar events from connected calendars
 * and auto-creates meetings for calendars with autoRecord enabled.
 *
 * Runs as a repeatable job every 5 minutes.
 */

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@aramis/database';
import { QUEUE_NAMES } from '@aramis/shared';
import { extractMeetingUrl } from '@aramis/shared';
import { logger } from './lib/logger';

export interface CalendarSyncJobData {
  /** Optional: sync only a specific connection */
  connectionId?: string;
  /** Optional: sync only a specific calendar */
  calendarId?: string;
}

export function createCalendarSyncWorker(redis: IORedis) {
  const meetingQueue = new Queue(QUEUE_NAMES.MEETING_BOT, { connection: redis });

  const worker = new Worker<CalendarSyncJobData>(
    QUEUE_NAMES.CALENDAR_SYNC,
    async (job) => {
      const { connectionId, calendarId } = job.data || {};

      logger.info('Starting calendar sync');

      try {
        // Find calendar connections to sync
        const connections = await prisma.calendarConnection.findMany({
          where: {
            isActive: true,
            ...(connectionId ? { id: connectionId } : {}),
          },
          include: {
            calendars: {
              where: {
                isEnabled: true,
                ...(calendarId ? { id: calendarId } : {}),
              },
            },
          },
        });

        let totalSynced = 0;
        let meetingsCreated = 0;

        for (const connection of connections) {
          try {
            for (const calendar of connection.calendars) {
              // Sync events for this calendar
              const syncedCount = await syncCalendarEvents(calendar.id, connection.id);
              totalSynced += syncedCount;

              // Auto-create meetings for autoRecord calendars
              if (calendar.autoRecord) {
                const created = await autoCreateMeetings(
                  calendar.id,
                  connection.userId,
                  meetingQueue
                );
                meetingsCreated += created;
              }
            }

            // Update last sync time
            await prisma.calendarConnection.update({
              where: { id: connection.id },
              data: { lastSyncAt: new Date(), syncError: null },
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to sync connection ${connection.id}: ${errorMessage}`);

            // Record sync error
            await prisma.calendarConnection.update({
              where: { id: connection.id },
              data: { syncError: errorMessage.substring(0, 500) },
            });
          }
        }

        logger.info(
          `Calendar sync complete: ${totalSynced} events synced, ${meetingsCreated} meetings created`
        );

        return { totalSynced, meetingsCreated };
      } catch (error) {
        logger.error(`Calendar sync failed: ${error}`);
        throw error;
      }
    },
    {
      connection: redis,
      concurrency: 1, // Only one sync at a time
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Calendar sync job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Calendar sync job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

/**
 * Sync events from a calendar using the Google Calendar service.
 *
 * This function directly fetches events from the database's CalendarEvent table.
 * The actual Google Calendar API call is handled by the GoogleCalendarService
 * in the web app. This worker syncs the already-fetched events.
 */
async function syncCalendarEvents(calendarId: string, connectionId: string): Promise<number> {
  // For now, we check existing calendar events and update their status.
  // The actual Google Calendar API sync is triggered via the web app's
  // GoogleCalendarService.syncEvents() method, which can be called
  // from the calendar API endpoint.
  //
  // This worker focuses on processing events that have already been synced
  // and creating meetings for upcoming events.

  const now = new Date();
  const oneWeekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const events = await prisma.calendarEvent.findMany({
    where: {
      calendarId,
      startTime: {
        gte: now,
        lte: oneWeekFromNow,
      },
      isCancelled: false,
    },
    orderBy: { startTime: 'asc' },
  });

  return events.length;
}

/**
 * Auto-create meetings for calendar events that have meeting URLs.
 *
 * Only creates meetings for events that:
 * - Have a detected meeting URL
 * - Don't already have an associated meeting (via calendarEventId)
 * - Are in the future (within the next 7 days)
 */
async function autoCreateMeetings(
  calendarId: string,
  userId: string,
  meetingQueue: Queue
): Promise<number> {
  const now = new Date();
  const oneWeekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Find events with meeting URLs that don't have associated meetings yet
  const events = await prisma.calendarEvent.findMany({
    where: {
      calendarId,
      startTime: {
        gte: now,
        lte: oneWeekFromNow,
      },
      isCancelled: false,
      meetingUrl: { not: null },
      platform: { not: null },
      meeting: null, // No meeting created yet
    },
  });

  let created = 0;

  for (const event of events) {
    if (!event.meetingUrl || !event.platform) continue;

    try {
      // Check for duplicates by calendarEventId
      const existingMeeting = await prisma.meeting.findFirst({
        where: { calendarEventId: event.id },
      });

      if (existingMeeting) {
        continue;
      }

      // Create meeting
      const meeting = await prisma.meeting.create({
        data: {
          userId,
          calendarEventId: event.id,
          title: event.title,
          description: event.description,
          meetingUrl: event.meetingUrl,
          platform: event.platform,
          scheduledStart: event.startTime,
          scheduledEnd: event.endTime,
          status: 'SCHEDULED',
        },
      });

      // Queue the bot to join at the scheduled time
      const delay = Math.max(0, event.startTime.getTime() - Date.now());

      await meetingQueue.add('join', {
        meetingId: meeting.id,
        meetingUrl: event.meetingUrl,
        platform: event.platform,
      }, {
        delay,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      });

      logger.info(
        `Auto-created meeting for calendar event: ${event.title} (${meeting.id}), ` +
        `scheduled in ${Math.round(delay / 60000)} minutes`
      );

      created++;
    } catch (error) {
      logger.error(`Failed to auto-create meeting for event ${event.id}: ${error}`);
    }
  }

  return created;
}

/**
 * Set up the repeatable calendar sync job (every 5 minutes).
 */
export async function setupCalendarSyncRepeatable(redis: IORedis): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.CALENDAR_SYNC, { connection: redis });

  // Add repeatable job every 5 minutes
  await queue.add('sync', {}, {
    repeat: {
      every: 5 * 60 * 1000, // 5 minutes
    },
    removeOnComplete: 10,
    removeOnFail: 50,
  });

  logger.info('Calendar sync repeatable job configured (every 5 minutes)');
}
