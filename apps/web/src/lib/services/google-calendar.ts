import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '@aramis/database';
import { extractMeetingUrl, MeetingPlatform } from '@aramis/shared';
import { decrypt, encrypt } from '@aramis/shared';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'openid',
  'email',
  'profile',
];

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GoogleCalendarService {
  private config: GoogleCalendarConfig;

  constructor(config?: Partial<GoogleCalendarConfig>) {
    this.config = {
      clientId: config?.clientId || process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: config?.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: config?.redirectUri || `${process.env.NEXTAUTH_URL}/api/calendars/callback/google`,
    };
  }

  /**
   * Create OAuth2 client
   */
  private createOAuth2Client(): OAuth2Client {
    return new google.auth.OAuth2(this.config.clientId, this.config.clientSecret, this.config.redirectUri);
  }

  /**
   * Generate authorization URL
   */
  generateAuthUrl(state: string): string {
    const oauth2Client = this.createOAuth2Client();

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      state,
      prompt: 'consent',
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    email: string;
  }> {
    const oauth2Client = this.createOAuth2Client();

    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    return {
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token ?? undefined,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      email: userInfo.email!,
    };
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt?: Date;
  }> {
    const oauth2Client = this.createOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const { credentials } = await oauth2Client.refreshAccessToken();

    return {
      accessToken: credentials.access_token!,
      expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : undefined,
    };
  }

  /**
   * Create calendar client with connection
   */
  async createCalendarClient(connectionId: string): Promise<calendar_v3.Calendar> {
    const connection = await prisma.calendarConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new Error('Calendar connection not found');
    }

    const oauth2Client = this.createOAuth2Client();

    // Decrypt tokens
    const accessToken = decrypt(connection.accessToken);
    const refreshToken = connection.refreshToken ? decrypt(connection.refreshToken) : undefined;

    // Check if token is expired
    if (connection.expiresAt && connection.expiresAt < new Date()) {
      if (!refreshToken) {
        throw new Error('Token expired and no refresh token available');
      }

      // Refresh the token
      const newTokens = await this.refreshAccessToken(refreshToken);

      // Update connection
      await prisma.calendarConnection.update({
        where: { id: connectionId },
        data: {
          accessToken: encrypt(newTokens.accessToken),
          expiresAt: newTokens.expiresAt,
        },
      });

      oauth2Client.setCredentials({
        access_token: newTokens.accessToken,
        refresh_token: refreshToken,
      });
    } else {
      oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    }

    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  /**
   * List all calendars for a connection
   */
  async listCalendars(connectionId: string): Promise<calendar_v3.Schema$CalendarListEntry[]> {
    const calendar = await this.createCalendarClient(connectionId);

    const { data } = await calendar.calendarList.list();

    return data.items || [];
  }

  /**
   * Sync calendars from Google to database
   */
  async syncCalendars(connectionId: string): Promise<void> {
    const googleCalendars = await this.listCalendars(connectionId);

    for (const googleCal of googleCalendars) {
      if (!googleCal.id) continue;

      await prisma.calendar.upsert({
        where: {
          connectionId_externalId: {
            connectionId,
            externalId: googleCal.id,
          },
        },
        create: {
          connectionId,
          externalId: googleCal.id,
          name: googleCal.summary || 'Unnamed Calendar',
          color: googleCal.backgroundColor,
          isPrimary: googleCal.primary || false,
        },
        update: {
          name: googleCal.summary || 'Unnamed Calendar',
          color: googleCal.backgroundColor,
        },
      });
    }
  }

  /**
   * Fetch events from a calendar
   */
  async fetchEvents(
    connectionId: string,
    calendarExternalId: string,
    options: {
      timeMin?: Date;
      timeMax?: Date;
      maxResults?: number;
    } = {},
  ): Promise<calendar_v3.Schema$Event[]> {
    const calendar = await this.createCalendarClient(connectionId);

    const now = new Date();
    const { data } = await calendar.events.list({
      calendarId: calendarExternalId,
      timeMin: (options.timeMin || now).toISOString(),
      timeMax: (options.timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)).toISOString(),
      maxResults: options.maxResults || 100,
      singleEvents: true,
      orderBy: 'startTime',
    });

    return data.items || [];
  }

  /**
   * Sync events from Google Calendar to database
   */
  async syncEvents(calendarId: string): Promise<number> {
    const dbCalendar = await prisma.calendar.findUnique({
      where: { id: calendarId },
      include: { connection: true },
    });

    if (!dbCalendar) {
      throw new Error('Calendar not found');
    }

    const events = await this.fetchEvents(dbCalendar.connectionId, dbCalendar.externalId);

    let syncedCount = 0;

    for (const event of events) {
      if (!event.id || !event.start) continue;

      // Extract meeting URL from location or description
      const meetingInfo =
        extractMeetingUrl(event.location || '') ||
        extractMeetingUrl(event.description || '') ||
        extractMeetingUrl(event.hangoutLink || '');

      // Determine platform from conference data
      let platform: MeetingPlatform | null = meetingInfo?.platform || null;
      let meetingUrl = meetingInfo?.url || null;

      // Check Google Meet link
      if (!meetingUrl && event.hangoutLink) {
        meetingUrl = event.hangoutLink;
        platform = 'GOOGLE_MEET';
      }

      // Check conference data
      if (!meetingUrl && event.conferenceData?.entryPoints) {
        const videoEntry = event.conferenceData.entryPoints.find((ep) => ep.entryPointType === 'video');
        if (videoEntry?.uri) {
          const info = extractMeetingUrl(videoEntry.uri);
          if (info) {
            meetingUrl = info.url;
            platform = info.platform;
          }
        }
      }

      const startTime = event.start.dateTime || event.start.date;
      const endTime = event.end?.dateTime || event.end?.date;

      if (!startTime) continue;

      await prisma.calendarEvent.upsert({
        where: {
          calendarId_externalId: {
            calendarId,
            externalId: event.id,
          },
        },
        create: {
          calendarId,
          externalId: event.id,
          title: event.summary || 'Untitled Event',
          description: event.description,
          location: event.location,
          startTime: new Date(startTime),
          endTime: endTime ? new Date(endTime) : new Date(startTime),
          isAllDay: !event.start.dateTime,
          meetingUrl,
          platform,
          organizer: event.organizer?.email,
          attendees: event.attendees?.map((a) => a.email!).filter(Boolean) || [],
          isRecurring: !!event.recurringEventId,
          recurringId: event.recurringEventId,
          isCancelled: event.status === 'cancelled',
          lastSyncAt: new Date(),
        },
        update: {
          title: event.summary || 'Untitled Event',
          description: event.description,
          location: event.location,
          startTime: new Date(startTime),
          endTime: endTime ? new Date(endTime) : new Date(startTime),
          isAllDay: !event.start.dateTime,
          meetingUrl,
          platform,
          organizer: event.organizer?.email,
          attendees: event.attendees?.map((a) => a.email!).filter(Boolean) || [],
          isRecurring: !!event.recurringEventId,
          recurringId: event.recurringEventId,
          isCancelled: event.status === 'cancelled',
          lastSyncAt: new Date(),
        },
      });

      syncedCount++;
    }

    // Update connection last sync time
    await prisma.calendarConnection.update({
      where: { id: dbCalendar.connectionId },
      data: { lastSyncAt: new Date(), syncError: null },
    });

    return syncedCount;
  }
}

// Export singleton
export const googleCalendarService = new GoogleCalendarService();
