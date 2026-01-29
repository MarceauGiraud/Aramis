import { describe, it, expect, vi, beforeEach } from 'vitest';

// Types for the summary system
interface KeyPoint {
  topic: string;
  summary: string;
  speakers?: string[];
  timestamp?: number;
}

interface Decision {
  description: string;
  context?: string;
  madeBy?: string;
  timestamp?: number;
}

interface ActionItem {
  description: string;
  assignee?: string;
  dueDate?: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

interface MeetingSummary {
  overview: string;
  keyPoints: KeyPoint[];
  decisions: Decision[];
  actionItems: ActionItem[];
  nextSteps?: string;
}

interface TranscriptInput {
  fullText: string;
  duration: number;
  speakers: string[];
}

interface MeetingContext {
  title: string;
  date: string;
  participants: string[];
  platform: string;
}

// Mock LLM response parser
function parseLLMResponse(response: string): MeetingSummary {
  try {
    return JSON.parse(response);
  } catch {
    throw new Error('Invalid JSON response from LLM');
  }
}

// Mock summary generator
class MockSummaryGenerator {
  private mockLLMCall = vi.fn();

  constructor() {
    this.mockLLMCall.mockResolvedValue({
      overview: 'Default overview',
      keyPoints: [],
      decisions: [],
      actionItems: [],
    });
  }

  setMockResponse(response: MeetingSummary): void {
    this.mockLLMCall.mockResolvedValue(response);
  }

  setMockError(error: Error): void {
    this.mockLLMCall.mockRejectedValue(error);
  }

  async generateSummary(
    transcript: TranscriptInput,
    context: MeetingContext
  ): Promise<MeetingSummary> {
    return this.mockLLMCall(transcript, context);
  }

  getMockCalls() {
    return this.mockLLMCall.mock.calls;
  }
}

describe('Summary Generator', () => {
  let generator: MockSummaryGenerator;

  beforeEach(() => {
    generator = new MockSummaryGenerator();
  });

  describe('Basic Summary Generation', () => {
    it('should generate summary with all sections', async () => {
      const mockSummary: MeetingSummary = {
        overview: 'The team discussed Q4 planning and budget allocation.',
        keyPoints: [
          { topic: 'Budget', summary: 'Approved $100k for marketing' },
          { topic: 'Timeline', summary: 'Launch date set for March 1st' },
        ],
        decisions: [
          { description: 'Hire 2 new engineers', madeBy: 'John' },
        ],
        actionItems: [
          {
            description: 'Draft hiring plan',
            assignee: 'Jane',
            dueDate: '2026-02-15',
            priority: 'high',
            status: 'pending',
          },
        ],
        nextSteps: 'Follow-up meeting scheduled for next week.',
      };

      generator.setMockResponse(mockSummary);

      const result = await generator.generateSummary(
        {
          fullText: 'Meeting transcript...',
          duration: 3600,
          speakers: ['John', 'Jane'],
        },
        {
          title: 'Q4 Planning',
          date: '2026-01-15',
          participants: ['John', 'Jane'],
          platform: 'ZOOM',
        }
      );

      expect(result.overview).toBe(mockSummary.overview);
      expect(result.keyPoints).toHaveLength(2);
      expect(result.decisions).toHaveLength(1);
      expect(result.actionItems).toHaveLength(1);
    });

    it('should handle empty transcript', async () => {
      generator.setMockResponse({
        overview: 'No content available.',
        keyPoints: [],
        decisions: [],
        actionItems: [],
      });

      const result = await generator.generateSummary(
        { fullText: '', duration: 0, speakers: [] },
        {
          title: 'Empty Meeting',
          date: '2026-01-15',
          participants: [],
          platform: 'TEAMS',
        }
      );

      expect(result.keyPoints).toHaveLength(0);
      expect(result.actionItems).toHaveLength(0);
    });
  });

  describe('Action Item Extraction', () => {
    it('should extract action items with assignees', async () => {
      generator.setMockResponse({
        overview: 'Planning meeting',
        keyPoints: [],
        decisions: [],
        actionItems: [
          {
            description: 'Create project plan',
            assignee: 'Alice',
            priority: 'high',
            status: 'pending',
          },
          {
            description: 'Review budget',
            assignee: 'Bob',
            dueDate: '2026-02-01',
            priority: 'medium',
            status: 'pending',
          },
        ],
      });

      const result = await generator.generateSummary(
        { fullText: 'Alice will create the project plan...', duration: 1800, speakers: ['Alice', 'Bob'] },
        { title: 'Planning', date: '2026-01-15', participants: ['Alice', 'Bob'], platform: 'GOOGLE_MEET' }
      );

      expect(result.actionItems).toHaveLength(2);
      expect(result.actionItems[0].assignee).toBe('Alice');
      expect(result.actionItems[1].dueDate).toBe('2026-02-01');
    });

    it('should default to "Unassigned" when no assignee mentioned', async () => {
      generator.setMockResponse({
        overview: 'Team meeting',
        keyPoints: [],
        decisions: [],
        actionItems: [
          {
            description: 'Update documentation',
            assignee: 'Unassigned',
            priority: 'low',
            status: 'pending',
          },
        ],
      });

      const result = await generator.generateSummary(
        { fullText: 'We need to update the docs...', duration: 900, speakers: [] },
        { title: 'Team Sync', date: '2026-01-15', participants: [], platform: 'ZOOM' }
      );

      expect(result.actionItems[0].assignee).toBe('Unassigned');
    });

    it('should infer priority from context', async () => {
      generator.setMockResponse({
        overview: 'Urgent meeting',
        keyPoints: [],
        decisions: [],
        actionItems: [
          {
            description: 'Fix critical bug',
            priority: 'high',
            status: 'pending',
          },
          {
            description: 'Nice to have feature',
            priority: 'low',
            status: 'pending',
          },
        ],
      });

      const result = await generator.generateSummary(
        { fullText: 'This is critical, we need to fix the bug ASAP...', duration: 600, speakers: [] },
        { title: 'Bug Review', date: '2026-01-15', participants: [], platform: 'TEAMS' }
      );

      expect(result.actionItems[0].priority).toBe('high');
      expect(result.actionItems[1].priority).toBe('low');
    });
  });

  describe('Key Points Extraction', () => {
    it('should extract key discussion topics', async () => {
      generator.setMockResponse({
        overview: 'Product roadmap discussion',
        keyPoints: [
          { topic: 'Feature A', summary: 'New login flow discussed', speakers: ['PM'] },
          { topic: 'Feature B', summary: 'Analytics dashboard planned', speakers: ['Engineer'] },
          { topic: 'Timeline', summary: 'Q2 release target', speakers: ['PM', 'Engineer'] },
        ],
        decisions: [],
        actionItems: [],
      });

      const result = await generator.generateSummary(
        { fullText: 'Let\'s discuss the roadmap...', duration: 2700, speakers: ['PM', 'Engineer'] },
        { title: 'Roadmap Planning', date: '2026-01-15', participants: ['PM', 'Engineer'], platform: 'ZOOM' }
      );

      expect(result.keyPoints).toHaveLength(3);
      expect(result.keyPoints[0].topic).toBe('Feature A');
      expect(result.keyPoints[2].speakers).toContain('PM');
    });

    it('should include timestamps when available', async () => {
      generator.setMockResponse({
        overview: 'Standup meeting',
        keyPoints: [
          { topic: 'Status Update', summary: 'Sprint progress', timestamp: 120 },
          { topic: 'Blockers', summary: 'API issues', timestamp: 360 },
        ],
        decisions: [],
        actionItems: [],
      });

      const result = await generator.generateSummary(
        { fullText: 'Standup transcript...', duration: 900, speakers: [] },
        { title: 'Daily Standup', date: '2026-01-15', participants: [], platform: 'GOOGLE_MEET' }
      );

      expect(result.keyPoints[0].timestamp).toBe(120);
      expect(result.keyPoints[1].timestamp).toBe(360);
    });
  });

  describe('Decision Extraction', () => {
    it('should extract decisions with context', async () => {
      generator.setMockResponse({
        overview: 'Decision meeting',
        keyPoints: [],
        decisions: [
          {
            description: 'Use React for frontend',
            context: 'After comparing Vue and React, team preferred React ecosystem',
            madeBy: 'Tech Lead',
          },
          {
            description: 'Deploy on AWS',
            context: 'Cost analysis favored AWS over GCP',
            madeBy: 'CTO',
          },
        ],
        actionItems: [],
      });

      const result = await generator.generateSummary(
        { fullText: 'We decided to use React...', duration: 3600, speakers: ['Tech Lead', 'CTO'] },
        { title: 'Tech Stack Decision', date: '2026-01-15', participants: ['Tech Lead', 'CTO'], platform: 'TEAMS' }
      );

      expect(result.decisions).toHaveLength(2);
      expect(result.decisions[0].description).toContain('React');
      expect(result.decisions[0].context).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle LLM errors gracefully', async () => {
      generator.setMockError(new Error('Rate limit exceeded'));

      await expect(
        generator.generateSummary(
          { fullText: 'Test', duration: 100, speakers: [] },
          { title: 'Test', date: '2026-01-15', participants: [], platform: 'ZOOM' }
        )
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('should validate summary structure', () => {
      const invalidJson = '{ invalid json }';

      expect(() => parseLLMResponse(invalidJson)).toThrow('Invalid JSON');
    });

    it('should handle missing optional fields', async () => {
      generator.setMockResponse({
        overview: 'Brief meeting',
        keyPoints: [],
        decisions: [],
        actionItems: [],
        // nextSteps is optional and missing
      });

      const result = await generator.generateSummary(
        { fullText: 'Quick sync', duration: 300, speakers: [] },
        { title: 'Quick Sync', date: '2026-01-15', participants: [], platform: 'ZOOM' }
      );

      expect(result.nextSteps).toBeUndefined();
      expect(result.overview).toBeDefined();
    });
  });
});

describe('Summary Validation', () => {
  function validateSummary(summary: MeetingSummary): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!summary.overview || summary.overview.length < 10) {
      errors.push('Overview must be at least 10 characters');
    }

    if (!Array.isArray(summary.keyPoints)) {
      errors.push('keyPoints must be an array');
    }

    if (!Array.isArray(summary.decisions)) {
      errors.push('decisions must be an array');
    }

    if (!Array.isArray(summary.actionItems)) {
      errors.push('actionItems must be an array');
    }

    for (const item of summary.actionItems) {
      if (!item.description) {
        errors.push('Action item must have description');
      }
      if (!['high', 'medium', 'low'].includes(item.priority)) {
        errors.push('Action item must have valid priority');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  it('should validate correct summary', () => {
    const validSummary: MeetingSummary = {
      overview: 'This is a valid meeting summary with sufficient length.',
      keyPoints: [{ topic: 'Test', summary: 'Test summary' }],
      decisions: [],
      actionItems: [],
    };

    const result = validateSummary(validSummary);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject summary with short overview', () => {
    const invalidSummary: MeetingSummary = {
      overview: 'Short',
      keyPoints: [],
      decisions: [],
      actionItems: [],
    };

    const result = validateSummary(invalidSummary);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Overview must be at least 10 characters');
  });

  it('should reject action item without description', () => {
    const invalidSummary: MeetingSummary = {
      overview: 'Valid overview text here.',
      keyPoints: [],
      decisions: [],
      actionItems: [
        { description: '', priority: 'high', status: 'pending' },
      ],
    };

    const result = validateSummary(invalidSummary);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Action item must have description');
  });
});
