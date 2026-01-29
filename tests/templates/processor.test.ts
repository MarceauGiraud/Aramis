import { describe, it, expect, vi, beforeEach } from 'vitest';

// Types for the template system
interface TemplateSection {
  id: string;
  name: string;
  key: string;
  description: string;
  prompt: string;
  required: boolean;
  order: number;
  outputFormat: 'text' | 'list' | 'table' | 'json';
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

interface SummaryTemplate {
  id: string;
  name: string;
  description: string;
  sections: TemplateSection[];
  includeDefaultSections: boolean;
  applyTo?: {
    type: 'all' | 'calendar' | 'rule' | 'meeting';
    calendarIds?: string[];
    meetingPatterns?: string[];
  };
}

interface TemplateVariable {
  name: string;
  value: string;
}

interface TranscriptContext {
  fullText: string;
  duration: number;
  speakers: string[];
}

interface MeetingContext {
  title: string;
  date: string;
  time: string;
  participants: string[];
  platform: string;
  organizer?: string;
}

// Template processor implementation
class TemplateProcessor {
  private mockLLM = vi.fn();

  constructor() {
    this.mockLLM.mockResolvedValue('Default response');
  }

  setMockResponse(response: string): void {
    this.mockLLM.mockResolvedValue(response);
  }

  resolveVariables(text: string, context: MeetingContext, transcript: TranscriptContext): string {
    const variables: Record<string, string> = {
      '{{meeting_title}}': context.title,
      '{{meeting_date}}': context.date,
      '{{meeting_time}}': context.time || '',
      '{{duration}}': this.formatDuration(transcript.duration),
      '{{participants}}': context.participants.join(', '),
      '{{participant_count}}': String(context.participants.length),
      '{{platform}}': context.platform,
      '{{organizer}}': context.organizer || 'Unknown',
      '{{transcript}}': transcript.fullText,
      '{{speaker_list}}': transcript.speakers.join(', '),
    };

    let result = text;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
    }

    return result;
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes} minutes`;
  }

  async processSection(
    section: TemplateSection,
    transcript: TranscriptContext,
    context: MeetingContext
  ): Promise<string | string[] | object> {
    const prompt = this.resolveVariables(section.prompt, context, transcript);

    const response = await this.mockLLM(prompt);

    return this.parseOutput(response, section.outputFormat);
  }

  private parseOutput(response: string, format: TemplateSection['outputFormat']): string | string[] | object {
    switch (format) {
      case 'list':
        return response.split('\n').filter(line => line.trim());
      case 'json':
        try {
          return JSON.parse(response);
        } catch {
          return { raw: response };
        }
      case 'table':
        // Parse markdown table format
        return response;
      default:
        return response;
    }
  }

  async processTemplate(
    template: SummaryTemplate,
    transcript: TranscriptContext,
    context: MeetingContext
  ): Promise<Record<string, string | string[] | object>> {
    const results: Record<string, string | string[] | object> = {};

    const sortedSections = [...template.sections].sort((a, b) => a.order - b.order);

    for (const section of sortedSections) {
      results[section.key] = await this.processSection(section, transcript, context);
    }

    return results;
  }

  validateOutput(
    output: string | string[] | object,
    section: TemplateSection
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (section.outputFormat === 'text' && typeof output === 'string') {
      if (section.maxLength && output.length > section.maxLength) {
        errors.push(`Output exceeds maxLength of ${section.maxLength}`);
      }
    }

    if (section.outputFormat === 'list' && Array.isArray(output)) {
      if (section.minItems && output.length < section.minItems) {
        errors.push(`Output has fewer than ${section.minItems} items`);
      }
      if (section.maxItems && output.length > section.maxItems) {
        errors.push(`Output has more than ${section.maxItems} items`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

describe('Template Processor', () => {
  let processor: TemplateProcessor;

  const sampleTranscript: TranscriptContext = {
    fullText: 'John: Hello everyone. Jane: Hi John. Let\'s discuss the project...',
    duration: 1800,
    speakers: ['John', 'Jane'],
  };

  const sampleContext: MeetingContext = {
    title: 'Project Planning',
    date: '2026-01-15',
    time: '10:00 AM',
    participants: ['John', 'Jane', 'Bob'],
    platform: 'ZOOM',
    organizer: 'John',
  };

  beforeEach(() => {
    processor = new TemplateProcessor();
  });

  describe('Variable Resolution', () => {
    it('should resolve meeting title variable', () => {
      const template = 'Meeting: {{meeting_title}}';
      const result = processor.resolveVariables(template, sampleContext, sampleTranscript);

      expect(result).toBe('Meeting: Project Planning');
    });

    it('should resolve all standard variables', () => {
      const template = `
        Title: {{meeting_title}}
        Date: {{meeting_date}}
        Time: {{meeting_time}}
        Duration: {{duration}}
        Participants: {{participants}}
        Count: {{participant_count}}
        Platform: {{platform}}
        Organizer: {{organizer}}
        Speakers: {{speaker_list}}
      `;

      const result = processor.resolveVariables(template, sampleContext, sampleTranscript);

      expect(result).toContain('Title: Project Planning');
      expect(result).toContain('Date: 2026-01-15');
      expect(result).toContain('Time: 10:00 AM');
      expect(result).toContain('Duration: 30 minutes');
      expect(result).toContain('Participants: John, Jane, Bob');
      expect(result).toContain('Count: 3');
      expect(result).toContain('Platform: ZOOM');
      expect(result).toContain('Organizer: John');
      expect(result).toContain('Speakers: John, Jane');
    });

    it('should handle missing optional variables', () => {
      const contextWithoutOrganizer: MeetingContext = {
        ...sampleContext,
        organizer: undefined,
      };

      const template = 'Organizer: {{organizer}}';
      const result = processor.resolveVariables(template, contextWithoutOrganizer, sampleTranscript);

      expect(result).toBe('Organizer: Unknown');
    });

    it('should format duration correctly for hours', () => {
      const longTranscript: TranscriptContext = {
        ...sampleTranscript,
        duration: 5400, // 1.5 hours
      };

      const template = 'Duration: {{duration}}';
      const result = processor.resolveVariables(template, sampleContext, longTranscript);

      expect(result).toBe('Duration: 1h 30m');
    });

    it('should resolve transcript variable', () => {
      const template = 'Transcript:\n{{transcript}}';
      const result = processor.resolveVariables(template, sampleContext, sampleTranscript);

      expect(result).toContain('John: Hello everyone');
    });
  });

  describe('Section Processing', () => {
    it('should process text format section', async () => {
      processor.setMockResponse('This is a summary of the pain points discussed.');

      const section: TemplateSection = {
        id: '1',
        name: 'Pain Points',
        key: 'pain-points',
        description: 'Customer pain points',
        prompt: 'List pain points from {{meeting_title}}',
        required: true,
        order: 1,
        outputFormat: 'text',
      };

      const result = await processor.processSection(section, sampleTranscript, sampleContext);

      expect(typeof result).toBe('string');
      expect(result).toContain('summary');
    });

    it('should process list format section', async () => {
      processor.setMockResponse('- Item 1\n- Item 2\n- Item 3');

      const section: TemplateSection = {
        id: '2',
        name: 'Action Items',
        key: 'action-items',
        description: 'Action items from meeting',
        prompt: 'List action items',
        required: true,
        order: 2,
        outputFormat: 'list',
      };

      const result = await processor.processSection(section, sampleTranscript, sampleContext);

      expect(Array.isArray(result)).toBe(true);
      expect((result as string[]).length).toBe(3);
    });

    it('should process json format section', async () => {
      processor.setMockResponse('{"name": "John", "role": "PM"}');

      const section: TemplateSection = {
        id: '3',
        name: 'Participant Info',
        key: 'participant-info',
        description: 'Structured participant data',
        prompt: 'Extract participant info',
        required: false,
        order: 3,
        outputFormat: 'json',
      };

      const result = await processor.processSection(section, sampleTranscript, sampleContext);

      expect(typeof result).toBe('object');
      expect((result as any).name).toBe('John');
    });

    it('should handle invalid json gracefully', async () => {
      processor.setMockResponse('not valid json');

      const section: TemplateSection = {
        id: '4',
        name: 'Data',
        key: 'data',
        description: 'Some data',
        prompt: 'Get data',
        required: false,
        order: 4,
        outputFormat: 'json',
      };

      const result = await processor.processSection(section, sampleTranscript, sampleContext);

      expect((result as any).raw).toBe('not valid json');
    });
  });

  describe('Template Processing', () => {
    it('should process all sections in order', async () => {
      processor.setMockResponse('Section output');

      const template: SummaryTemplate = {
        id: 'template-1',
        name: 'Sales Template',
        description: 'Template for sales calls',
        sections: [
          {
            id: '1',
            name: 'Overview',
            key: 'overview',
            description: 'Meeting overview',
            prompt: 'Provide overview',
            required: true,
            order: 1,
            outputFormat: 'text',
          },
          {
            id: '2',
            name: 'Pain Points',
            key: 'pain-points',
            description: 'Pain points',
            prompt: 'List pain points',
            required: true,
            order: 2,
            outputFormat: 'text',
          },
          {
            id: '3',
            name: 'Next Steps',
            key: 'next-steps',
            description: 'Next steps',
            prompt: 'List next steps',
            required: true,
            order: 3,
            outputFormat: 'text',
          },
        ],
        includeDefaultSections: false,
      };

      const results = await processor.processTemplate(template, sampleTranscript, sampleContext);

      expect(Object.keys(results)).toEqual(['overview', 'pain-points', 'next-steps']);
    });

    it('should handle template with out-of-order sections', async () => {
      processor.setMockResponse('Output');

      const template: SummaryTemplate = {
        id: 'template-2',
        name: 'Unordered Template',
        description: 'Template with unordered sections',
        sections: [
          { id: '1', name: 'Third', key: 'third', description: '', prompt: '', required: true, order: 3, outputFormat: 'text' },
          { id: '2', name: 'First', key: 'first', description: '', prompt: '', required: true, order: 1, outputFormat: 'text' },
          { id: '3', name: 'Second', key: 'second', description: '', prompt: '', required: true, order: 2, outputFormat: 'text' },
        ],
        includeDefaultSections: false,
      };

      const results = await processor.processTemplate(template, sampleTranscript, sampleContext);

      // Results should still be keyed by section key, but processed in order
      expect(results['first']).toBeDefined();
      expect(results['second']).toBeDefined();
      expect(results['third']).toBeDefined();
    });
  });

  describe('Output Validation', () => {
    it('should validate text length', () => {
      const section: TemplateSection = {
        id: '1',
        name: 'Brief',
        key: 'brief',
        description: 'Brief summary',
        prompt: '',
        required: true,
        order: 1,
        outputFormat: 'text',
        maxLength: 100,
      };

      const validOutput = 'This is a short text';
      const invalidOutput = 'x'.repeat(150);

      expect(processor.validateOutput(validOutput, section).valid).toBe(true);
      expect(processor.validateOutput(invalidOutput, section).valid).toBe(false);
    });

    it('should validate list item count', () => {
      const section: TemplateSection = {
        id: '2',
        name: 'Items',
        key: 'items',
        description: 'List of items',
        prompt: '',
        required: true,
        order: 1,
        outputFormat: 'list',
        minItems: 2,
        maxItems: 5,
      };

      const tooFew = ['one'];
      const justRight = ['one', 'two', 'three'];
      const tooMany = ['1', '2', '3', '4', '5', '6'];

      expect(processor.validateOutput(tooFew, section).valid).toBe(false);
      expect(processor.validateOutput(justRight, section).valid).toBe(true);
      expect(processor.validateOutput(tooMany, section).valid).toBe(false);
    });
  });
});

describe('Built-in Templates', () => {
  const builtInTemplates: SummaryTemplate[] = [
    {
      id: 'sales-call',
      name: 'Sales Call',
      description: 'Template for sales discovery and demo calls',
      sections: [
        { id: '1', name: 'Customer Overview', key: 'customer-overview', description: '', prompt: 'Summarize the customer', required: true, order: 1, outputFormat: 'text' },
        { id: '2', name: 'Pain Points', key: 'pain-points', description: '', prompt: 'List pain points', required: true, order: 2, outputFormat: 'list' },
        { id: '3', name: 'Requirements', key: 'requirements', description: '', prompt: 'List requirements', required: true, order: 3, outputFormat: 'list' },
        { id: '4', name: 'Next Steps', key: 'next-steps', description: '', prompt: 'List next steps', required: true, order: 4, outputFormat: 'list' },
      ],
      includeDefaultSections: true,
      applyTo: { type: 'rule', meetingPatterns: ['.*[Ss]ales.*', '.*[Dd]emo.*'] },
    },
    {
      id: 'standup',
      name: 'Engineering Standup',
      description: 'Template for daily standups',
      sections: [
        { id: '1', name: 'Updates by Person', key: 'updates', description: '', prompt: 'List updates by person', required: true, order: 1, outputFormat: 'json' },
        { id: '2', name: 'Blockers', key: 'blockers', description: '', prompt: 'List blockers', required: true, order: 2, outputFormat: 'list' },
      ],
      includeDefaultSections: false,
      applyTo: { type: 'rule', meetingPatterns: ['.*[Ss]tandup.*', '.*[Dd]aily.*'] },
    },
  ];

  it('should have valid structure for all built-in templates', () => {
    for (const template of builtInTemplates) {
      expect(template.id).toBeDefined();
      expect(template.name).toBeDefined();
      expect(template.sections.length).toBeGreaterThan(0);

      // Check all sections have required fields
      for (const section of template.sections) {
        expect(section.id).toBeDefined();
        expect(section.key).toBeDefined();
        expect(section.outputFormat).toMatch(/^(text|list|table|json)$/);
      }
    }
  });

  it('should match sales meetings with Sales Call template', () => {
    const salesTemplate = builtInTemplates.find(t => t.id === 'sales-call');
    const patterns = salesTemplate?.applyTo?.meetingPatterns || [];

    const salesTitles = ['Sales Call with Acme', 'Demo for Customer', 'Product Demo'];
    const nonSalesTitles = ['Team Standup', 'Engineering Sync'];

    for (const title of salesTitles) {
      const matches = patterns.some(pattern => new RegExp(pattern).test(title));
      expect(matches).toBe(true);
    }

    for (const title of nonSalesTitles) {
      const matches = patterns.some(pattern => new RegExp(pattern).test(title));
      expect(matches).toBe(false);
    }
  });

  it('should match standup meetings with Standup template', () => {
    const standupTemplate = builtInTemplates.find(t => t.id === 'standup');
    const patterns = standupTemplate?.applyTo?.meetingPatterns || [];

    const standupTitles = ['Daily Standup', 'Team Standup', 'Morning Daily'];
    const nonStandupTitles = ['Sales Demo', 'Planning Meeting'];

    for (const title of standupTitles) {
      const matches = patterns.some(pattern => new RegExp(pattern).test(title));
      expect(matches).toBe(true);
    }

    for (const title of nonStandupTitles) {
      const matches = patterns.some(pattern => new RegExp(pattern).test(title));
      expect(matches).toBe(false);
    }
  });
});
