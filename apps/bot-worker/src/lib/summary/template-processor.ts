import { SummaryGenerator, MeetingSummary, TranscriptInput, MeetingContext } from './generator';
import { logger } from '../logger';

export interface TemplateSection {
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

export interface SummaryTemplate {
  id: string;
  name: string;
  description?: string;
  sections: TemplateSection[];
  includeDefaultSections: boolean;
  applyTo?: {
    type: 'all' | 'calendar' | 'rule' | 'meeting';
    calendarIds?: string[];
    meetingPatterns?: string[];
  };
}

export interface ProcessedSection {
  key: string;
  name: string;
  content: string | string[] | object;
  format: TemplateSection['outputFormat'];
}

export interface ProcessedSummary {
  defaultSummary?: MeetingSummary;
  customSections: ProcessedSection[];
}

export class TemplateProcessor {
  private summaryGenerator: SummaryGenerator;

  constructor(summaryGenerator?: SummaryGenerator) {
    this.summaryGenerator = summaryGenerator || new SummaryGenerator();
  }

  /**
   * Process a custom template
   */
  async processTemplate(
    template: SummaryTemplate,
    transcript: TranscriptInput,
    context: MeetingContext
  ): Promise<ProcessedSummary> {
    logger.info(`Processing template: ${template.name}`);

    const customSections: ProcessedSection[] = [];

    // Sort sections by order
    const sortedSections = [...template.sections].sort((a, b) => a.order - b.order);

    // Process each section
    for (const section of sortedSections) {
      try {
        const content = await this.processSection(section, transcript, context);

        // Validate output
        const validation = this.validateOutput(content, section);
        if (!validation.valid && section.required) {
          logger.warn(`Section ${section.key} validation failed:`, validation.errors);
        }

        customSections.push({
          key: section.key,
          name: section.name,
          content,
          format: section.outputFormat,
        });
      } catch (error) {
        logger.error(`Error processing section ${section.key}:`, error as Error);

        if (section.required) {
          throw error;
        }

        // For optional sections, add empty content
        customSections.push({
          key: section.key,
          name: section.name,
          content: section.outputFormat === 'list' ? [] : '',
          format: section.outputFormat,
        });
      }
    }

    // Include default sections if configured
    let defaultSummary: MeetingSummary | undefined;
    if (template.includeDefaultSections) {
      defaultSummary = await this.summaryGenerator.generateSummary(transcript, context);
    }

    return {
      defaultSummary,
      customSections,
    };
  }

  /**
   * Process a single section
   */
  private async processSection(
    section: TemplateSection,
    transcript: TranscriptInput,
    context: MeetingContext
  ): Promise<string | string[] | object> {
    const prompt = this.buildSectionPrompt(section, transcript, context);

    // Use the summary generator's LLM
    const response = await this.callLLMForSection(prompt, section.outputFormat);

    return this.parseOutput(response, section.outputFormat);
  }

  /**
   * Build prompt for a section
   */
  private buildSectionPrompt(
    section: TemplateSection,
    transcript: TranscriptInput,
    context: MeetingContext
  ): string {
    let resolvedPrompt = this.resolveVariables(section.prompt, transcript, context);

    const formatInstructions = this.getFormatInstructions(section);

    return `## Meeting Context
Title: ${context.title}
Date: ${context.date}
Participants: ${context.participants.join(', ')}

## Task: ${section.name}
${section.description}

${resolvedPrompt}

## Meeting Transcript
${this.truncateTranscript(transcript.fullText)}

## Output Instructions
${formatInstructions}
${section.maxLength ? `Maximum length: ${section.maxLength} characters.` : ''}
${section.minItems ? `Include at least ${section.minItems} items.` : ''}
${section.maxItems ? `Include at most ${section.maxItems} items.` : ''}`;
  }

  /**
   * Resolve template variables
   */
  resolveVariables(
    text: string,
    transcript: TranscriptInput,
    context: MeetingContext
  ): string {
    const duration = this.formatDuration(transcript.duration);

    const variables: Record<string, string> = {
      '{{meeting_title}}': context.title,
      '{{meeting_date}}': context.date,
      '{{meeting_time}}': context.time || '',
      '{{duration}}': duration,
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

  private truncateTranscript(text: string, maxChars: number = 20000): string {
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars) + '\n\n[Truncated...]';
  }

  private getFormatInstructions(section: TemplateSection): string {
    switch (section.outputFormat) {
      case 'list':
        return 'Respond with a JSON array of strings. Example: ["item 1", "item 2", "item 3"]';
      case 'json':
        return 'Respond with valid JSON object.';
      case 'table':
        return 'Respond with a markdown table format.';
      default:
        return 'Respond with plain text.';
    }
  }

  private async callLLMForSection(prompt: string, format: string): Promise<string> {
    // Create a temporary generator for this section
    const generator = new SummaryGenerator();

    // Simple wrapper that returns raw LLM response
    const response = await (generator as any).callOpenAI(prompt);
    return response;
  }

  private parseOutput(
    response: string,
    format: TemplateSection['outputFormat']
  ): string | string[] | object {
    switch (format) {
      case 'list':
        try {
          const parsed = JSON.parse(response);
          if (Array.isArray(parsed)) return parsed;
          // Try to extract array from response
          const match = response.match(/\[[\s\S]*\]/);
          if (match) return JSON.parse(match[0]);
          // Fall back to splitting by newlines
          return response.split('\n').filter(line => line.trim());
        } catch {
          return response.split('\n').filter(line => line.trim());
        }

      case 'json':
        try {
          return JSON.parse(response);
        } catch {
          return { raw: response };
        }

      case 'table':
        return response;

      default:
        return response.trim();
    }
  }

  /**
   * Validate section output
   */
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

  /**
   * Check if template matches a meeting
   */
  matchesMeeting(template: SummaryTemplate, meetingTitle: string, calendarId?: string): boolean {
    if (!template.applyTo) return true;

    switch (template.applyTo.type) {
      case 'all':
        return true;

      case 'calendar':
        return template.applyTo.calendarIds?.includes(calendarId || '') || false;

      case 'rule':
        if (!template.applyTo.meetingPatterns) return false;
        return template.applyTo.meetingPatterns.some(pattern => {
          try {
            return new RegExp(pattern).test(meetingTitle);
          } catch {
            return false;
          }
        });

      default:
        return false;
    }
  }
}

// Export factory
export function createTemplateProcessor(
  summaryGenerator?: SummaryGenerator
): TemplateProcessor {
  return new TemplateProcessor(summaryGenerator);
}
