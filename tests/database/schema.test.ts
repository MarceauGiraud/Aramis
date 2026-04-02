import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

describe('Database Schema', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('User Model', () => {
    it('should create a user with required fields', async () => {
      const user = await prisma.user.create({
        data: {
          email: `test-${Date.now()}@example.com`,
          name: 'Test User',
        },
      });

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.email).toContain('@example.com');
      expect(user.createdAt).toBeInstanceOf(Date);

      // Cleanup
      await prisma.user.delete({ where: { id: user.id } });
    });

    it('should enforce unique email constraint', async () => {
      const email = `unique-${Date.now()}@example.com`;

      await prisma.user.create({ data: { email } });

      await expect(prisma.user.create({ data: { email } })).rejects.toThrow();

      // Cleanup
      await prisma.user.delete({ where: { email } });
    });
  });

  describe('CalendarConnection Model', () => {
    it('should create calendar connection with encrypted tokens', async () => {
      const user = await prisma.user.create({
        data: { email: `cal-test-${Date.now()}@example.com` },
      });

      const connection = await prisma.calendarConnection.create({
        data: {
          userId: user.id,
          provider: 'GOOGLE',
          email: 'calendar@gmail.com',
          accessToken: 'encrypted-access-token',
          refreshToken: 'encrypted-refresh-token',
        },
      });

      expect(connection).toBeDefined();
      expect(connection.provider).toBe('GOOGLE');
      expect(connection.isActive).toBe(true);

      // Cleanup
      await prisma.calendarConnection.delete({ where: { id: connection.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('Meeting Model', () => {
    it('should create meeting with all required fields', async () => {
      const user = await prisma.user.create({
        data: { email: `meeting-test-${Date.now()}@example.com` },
      });

      const meeting = await prisma.meeting.create({
        data: {
          userId: user.id,
          title: 'Test Meeting',
          meetingUrl: 'https://zoom.us/j/123456789',
          platform: 'ZOOM',
          scheduledStart: new Date(),
          status: 'SCHEDULED',
        },
      });

      expect(meeting).toBeDefined();
      expect(meeting.platform).toBe('ZOOM');
      expect(meeting.status).toBe('SCHEDULED');

      // Cleanup
      await prisma.meeting.delete({ where: { id: meeting.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    it('should transition through meeting statuses', async () => {
      const user = await prisma.user.create({
        data: { email: `status-test-${Date.now()}@example.com` },
      });

      const meeting = await prisma.meeting.create({
        data: {
          userId: user.id,
          title: 'Status Test',
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
          platform: 'GOOGLE_MEET',
          scheduledStart: new Date(),
        },
      });

      // Test status transitions
      const statuses = ['JOINING', 'RECORDING', 'PROCESSING', 'COMPLETED'];

      for (const status of statuses) {
        const updated = await prisma.meeting.update({
          where: { id: meeting.id },
          data: { status: status as any },
        });
        expect(updated.status).toBe(status);
      }

      // Cleanup
      await prisma.meeting.delete({ where: { id: meeting.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('Recording Model', () => {
    it('should create recording with chunks', async () => {
      const user = await prisma.user.create({
        data: { email: `recording-test-${Date.now()}@example.com` },
      });

      const meeting = await prisma.meeting.create({
        data: {
          userId: user.id,
          title: 'Recording Test',
          meetingUrl: 'https://teams.microsoft.com/l/meetup/123',
          platform: 'TEAMS',
          scheduledStart: new Date(),
        },
      });

      const recording = await prisma.recording.create({
        data: {
          meetingId: meeting.id,
          status: 'RECORDING',
          chunks: {
            create: [
              {
                chunkNumber: 0,
                s3Key: 'recordings/test/chunk_000.webm',
                fileSize: BigInt(1024 * 1024 * 10),
                startTime: new Date(),
                endTime: new Date(),
                duration: 300,
              },
              {
                chunkNumber: 1,
                s3Key: 'recordings/test/chunk_001.webm',
                fileSize: BigInt(1024 * 1024 * 10),
                startTime: new Date(),
                endTime: new Date(),
                duration: 300,
              },
            ],
          },
        },
        include: { chunks: true },
      });

      expect(recording).toBeDefined();
      expect(recording.chunks).toHaveLength(2);
      expect(recording.chunks[0].chunkNumber).toBe(0);

      // Cleanup
      await prisma.recordingChunk.deleteMany({ where: { recordingId: recording.id } });
      await prisma.recording.delete({ where: { id: recording.id } });
      await prisma.meeting.delete({ where: { id: meeting.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('Transcript Model', () => {
    it('should create transcript with segments and speakers', async () => {
      const user = await prisma.user.create({
        data: { email: `transcript-test-${Date.now()}@example.com` },
      });

      const meeting = await prisma.meeting.create({
        data: {
          userId: user.id,
          title: 'Transcript Test',
          meetingUrl: 'https://zoom.us/j/999',
          platform: 'ZOOM',
          scheduledStart: new Date(),
        },
      });

      const transcript = await prisma.transcript.create({
        data: {
          meetingId: meeting.id,
          status: 'COMPLETED',
          fullText: 'Hello, this is a test transcript.',
          wordCount: 6,
          language: 'en',
          confidence: 0.95,
          speakers: {
            create: [
              { label: 'Speaker 1', identifiedName: 'John' },
              { label: 'Speaker 2', identifiedName: 'Jane' },
            ],
          },
        },
        include: { speakers: true },
      });

      expect(transcript).toBeDefined();
      expect(transcript.speakers).toHaveLength(2);
      expect(transcript.confidence).toBe(0.95);

      // Cleanup
      await prisma.transcriptSpeaker.deleteMany({ where: { transcriptId: transcript.id } });
      await prisma.transcript.delete({ where: { id: transcript.id } });
      await prisma.meeting.delete({ where: { id: meeting.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('SummaryTemplate Model', () => {
    it('should create custom template with sections', async () => {
      const user = await prisma.user.create({
        data: { email: `template-test-${Date.now()}@example.com` },
      });

      const template = await prisma.summaryTemplate.create({
        data: {
          userId: user.id,
          name: 'Sales Call Template',
          description: 'Template for sales calls',
          sections: [
            {
              id: '1',
              name: 'Pain Points',
              key: 'pain-points',
              prompt: 'List customer pain points',
              required: true,
              order: 1,
              outputFormat: 'list',
            },
            {
              id: '2',
              name: 'Next Steps',
              key: 'next-steps',
              prompt: 'What are the next steps?',
              required: true,
              order: 2,
              outputFormat: 'list',
            },
          ],
          isDefault: false,
          includeDefaultSections: true,
        },
      });

      expect(template).toBeDefined();
      expect(template.sections).toHaveLength(2);
      expect(template.name).toBe('Sales Call Template');

      // Cleanup
      await prisma.summaryTemplate.delete({ where: { id: template.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('MeetingSummary Model', () => {
    it('should create summary with structured data', async () => {
      const user = await prisma.user.create({
        data: { email: `summary-test-${Date.now()}@example.com` },
      });

      const meeting = await prisma.meeting.create({
        data: {
          userId: user.id,
          title: 'Summary Test',
          meetingUrl: 'https://meet.google.com/xyz',
          platform: 'GOOGLE_MEET',
          scheduledStart: new Date(),
        },
      });

      const summary = await prisma.meetingSummary.create({
        data: {
          meetingId: meeting.id,
          status: 'COMPLETED',
          overview: 'This was a productive meeting about Q4 planning.',
          keyPoints: [
            { topic: 'Budget', summary: 'Discussed Q4 budget allocation' },
            { topic: 'Timeline', summary: 'Agreed on key milestones' },
          ],
          decisions: [{ description: 'Approved $50k marketing budget', madeBy: 'John' }],
          actionItems: [
            {
              description: 'Create marketing plan',
              assignee: 'Jane',
              dueDate: '2026-02-15',
              priority: 'high',
              status: 'pending',
            },
          ],
          modelUsed: 'gpt-4',
          promptTokens: 1500,
          completionTokens: 800,
        },
      });

      expect(summary).toBeDefined();
      expect(summary.keyPoints).toHaveLength(2);
      expect(summary.actionItems).toHaveLength(1);

      // Cleanup
      await prisma.meetingSummary.delete({ where: { id: summary.id } });
      await prisma.meeting.delete({ where: { id: meeting.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });
});
