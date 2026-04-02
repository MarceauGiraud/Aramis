import { Client } from '@microsoft/microsoft-graph-client';
import { prisma } from '@aramis/database';
import { extractMeetingUrl, MeetingPlatform } from '@aramis/shared';
import { decrypt, encrypt } from '@aramis/shared';

const SCOPES = ['Calendars.Read', 'User.Read', 'offline_access'];

export interface MicrosoftCalendarConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenantId: string;
}

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface MicrosoftCalendar {
  id: string;
  name: string;
  color?: string;
  isDefaultCalendar?: boolean;
}

interface MicrosoftEvent {
  id: string;
  subject: string;
  body?: { content: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay?: boolean;
  location?: { displayName: string };
  onlineMeeting?: { joinUrl: string };
  organizer?: { emailAddress: { address: string } };
  attendees?: Array<{ emailAddress: { address: string } }>;
  seriesMasterId?: string;
  isCancelled?: boolean;
}

export class MicrosoftCalendarService {
  private config: MicrosoftCalendarConfig;

  constructor(config?: Partial<MicrosoftCalendarConfig>) {
    this.config = {
      clientId: config?.clientId || process.env.MICROSOFT_CLIENT_ID || '',
      clientSecret: config?.clientSecret || process.env.MICROSOFT_CLIENT_SECRET || '',
      redirectUri: config?.redirectUri || `${process.env.NEXTAUTH_URL}/api/calendars/callback/microsoft`,
      tenantId: config?.tenantId || 'common',
    };
  }

  /**
   * Generate authorization URL
   */
  generateAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      response_mode: 'query',
      scope: SCOPES.join(' '),
      state,
    });

    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/authorize?${params}`;
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
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
      scope: SCOPES.join(' '),
    });

    const response = await fetch(`https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const tokens: MicrosoftTokenResponse = await response.json();

    // Get user info
    const client = this.createGraphClient(tokens.access_token);
    const userInfo = await client.api('/me').get();

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: userInfo.mail || userInfo.userPrincipalName,
    };
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES.join(' '),
    });

    const response = await fetch(`https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const tokens: MicrosoftTokenResponse = await response.json();

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    };
  }

  /**
   * Create Graph client
   */
  private createGraphClient(accessToken: string): Client {
    return Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      },
    });
  }

  /**
   * Create Graph client from connection
   */
  async createClientFromConnection(connectionId: string): Promise<Client> {
    const connection = await prisma.calendarConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new Error('Calendar connection not found');
    }

    // Decrypt tokens
    let accessToken = decrypt(connection.accessToken);
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
          refreshToken: newTokens.refreshToken ? encrypt(newTokens.refreshToken) : undefined,
          expiresAt: newTokens.expiresAt,
        },
      });

      accessToken = newTokens.accessToken;
    }

    return this.createGraphClient(accessToken);
  }

  /**
   * List all calendars for a connection
   */
  async listCalendars(connectionId: string): Promise<MicrosoftCalendar[]> {
    const client = await this.createClientFromConnection(connectionId);

    const response = await client.api('/me/calendars').get();

    return response.value.map((cal: any) => ({
      id: cal.id,
      name: cal.name,
      color: cal.hexColor,
      isDefaultCalendar: cal.isDefaultCalendar,
    }));
  }

  /**
   * Sync calendars from Microsoft to database
   */
  async syncCalendars(connectionId: string): Promise<void> {
    const calendars = await this.listCalendars(connectionId);

    for (const cal of calendars) {
      await prisma.calendar.upsert({
        where: {
          connectionId_externalId: {
            connectionId,
            externalId: cal.id,
          },
        },
        create: {
          connectionId,
          externalId: cal.id,
          name: cal.name,
          color: cal.color,
          isPrimary: cal.isDefaultCalendar || false,
        },
        update: {
          name: cal.name,
          color: cal.color,
        },
      });
    }
  }

  /**
   * Fetch events from a calendar
   */
  async fetchEvents(
    connectionId: string,
    calendarId: string,
    options: {
      startDateTime?: Date;
      endDateTime?: Date;
      top?: number;
    } = {},
  ): Promise<MicrosoftEvent[]> {
    const client = await this.createClientFromConnection(connectionId);

    const now = new Date();
    const startDateTime = (options.startDateTime || now).toISOString();
    const endDateTime = (options.endDateTime || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)).toISOString();

    const response = await client
      .api(`/me/calendars/${calendarId}/calendarView`)
      .query({
        startDateTime,
        endDateTime,
        $top: options.top || 100,
        $orderby: 'start/dateTime',
        $select:
          'id,subject,body,start,end,isAllDay,location,onlineMeeting,organizer,attendees,seriesMasterId,isCancelled',
      })
      .get();

    return response.value;
  }

  /**
   * Sync events from Microsoft Calendar to database
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
      // Extract meeting URL
      let meetingUrl: string | null = null;
      let platform: MeetingPlatform | null = null;

      // Check online meeting URL first
      if (event.onlineMeeting?.joinUrl) {
        const info = extractMeetingUrl(event.onlineMeeting.joinUrl);
        if (info) {
          meetingUrl = info.url;
          platform = info.platform;
        } else if (event.onlineMeeting.joinUrl.includes('teams.microsoft.com')) {
          meetingUrl = event.onlineMeeting.joinUrl;
          platform = 'TEAMS';
        }
      }

      // Check location
      if (!meetingUrl && event.location?.displayName) {
        const info = extractMeetingUrl(event.location.displayName);
        if (info) {
          meetingUrl = info.url;
          platform = info.platform;
        }
      }

      // Check body
      if (!meetingUrl && event.body?.content) {
        const info = extractMeetingUrl(event.body.content);
        if (info) {
          meetingUrl = info.url;
          platform = info.platform;
        }
      }

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
          title: event.subject || 'Untitled Event',
          description: event.body?.content,
          location: event.location?.displayName,
          startTime: new Date(event.start.dateTime),
          endTime: new Date(event.end.dateTime),
          isAllDay: event.isAllDay || false,
          meetingUrl,
          platform,
          organizer: event.organizer?.emailAddress?.address,
          attendees: (event.attendees?.map((a) => a.emailAddress?.address).filter(Boolean) as string[]) || [],
          isRecurring: !!event.seriesMasterId,
          recurringId: event.seriesMasterId,
          isCancelled: event.isCancelled || false,
          lastSyncAt: new Date(),
        },
        update: {
          title: event.subject || 'Untitled Event',
          description: event.body?.content,
          location: event.location?.displayName,
          startTime: new Date(event.start.dateTime),
          endTime: new Date(event.end.dateTime),
          isAllDay: event.isAllDay || false,
          meetingUrl,
          platform,
          organizer: event.organizer?.emailAddress?.address,
          attendees: (event.attendees?.map((a) => a.emailAddress?.address).filter(Boolean) as string[]) || [],
          isRecurring: !!event.seriesMasterId,
          recurringId: event.seriesMasterId,
          isCancelled: event.isCancelled || false,
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
export const microsoftCalendarService = new MicrosoftCalendarService();
