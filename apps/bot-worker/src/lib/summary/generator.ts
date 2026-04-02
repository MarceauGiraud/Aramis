import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger';

export interface KeyPoint {
  topic: string;
  summary: string;
  speakers?: string[];
  timestamp?: number;
}

export interface Decision {
  description: string;
  context?: string;
  madeBy?: string;
  timestamp?: number;
}

export interface ActionItem {
  description: string;
  assignee?: string;
  dueDate?: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface MeetingSummary {
  overview: string;
  keyPoints: KeyPoint[];
  decisions: Decision[];
  actionItems: ActionItem[];
  nextSteps?: string;
}

export interface TranscriptInput {
  fullText: string;
  duration: number;
  speakers: string[];
}

export interface MeetingContext {
  title: string;
  date: string;
  time?: string;
  participants: string[];
  platform: string;
  organizer?: string;
}

export interface SummaryGeneratorConfig {
  provider: 'openai' | 'anthropic';
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_PROMPT = `You are an expert meeting analyst. Analyze the following meeting transcript and provide a structured summary.

## Meeting Information
- Title: {{meeting_title}}
- Date: {{meeting_date}}
- Duration: {{duration}}
- Participants: {{participants}}

## Transcript
{{transcript}}

## Instructions
Provide a comprehensive summary with the following sections:

### 1. Overview
Write a 2-3 sentence overview of the meeting's purpose and main outcome.

### 2. Key Discussion Points
List the main topics discussed with brief explanations. Include:
- The topic/theme
- Key points made
- Who spoke about it (if identifiable)

### 3. Decisions Made
List any decisions that were made during the meeting:
- What was decided
- Context/reasoning
- Who made or approved the decision

### 4. Action Items
Extract all action items mentioned. For each include:
- Task description
- Assignee (if mentioned, otherwise "Unassigned")
- Due date (if mentioned, otherwise null)
- Priority (infer from context: high/medium/low)

### 5. Next Steps
Summarize what happens next after this meeting.

Respond ONLY with valid JSON matching this exact structure:
{
  "overview": "string",
  "keyPoints": [{"topic": "string", "summary": "string", "speakers": ["string"]}],
  "decisions": [{"description": "string", "context": "string", "madeBy": "string"}],
  "actionItems": [{"description": "string", "assignee": "string", "dueDate": "string or null", "priority": "high|medium|low", "status": "pending"}],
  "nextSteps": "string"
}`;

export class SummaryGenerator {
  private config: SummaryGeneratorConfig;
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;

  constructor(config?: Partial<SummaryGeneratorConfig>) {
    this.config = {
      provider: config?.provider || 'anthropic',
      model: config?.model,
      apiKey: config?.apiKey,
      maxTokens: config?.maxTokens || 4000,
      temperature: config?.temperature || 0.3,
    };

    this.initializeClient();
  }

  private initializeClient(): void {
    if (this.config.provider === 'openai') {
      this.openaiClient = new OpenAI({
        apiKey: this.config.apiKey || process.env.OPENAI_API_KEY,
      });
      this.config.model = this.config.model || 'gpt-5.4-2026-03-05';
    } else {
      this.anthropicClient = new Anthropic({
        apiKey: this.config.apiKey || process.env.ANTHROPIC_API_KEY,
      });
      this.config.model = this.config.model || 'claude-sonnet-4-20250514';
    }
  }

  /**
   * Generate summary from transcript
   */
  async generateSummary(
    transcript: TranscriptInput,
    context: MeetingContext,
    customPrompt?: string,
  ): Promise<MeetingSummary> {
    logger.info(`Generating summary for meeting: ${context.title}`);

    const prompt = this.buildPrompt(customPrompt || DEFAULT_PROMPT, transcript, context);

    let response: string;

    if (this.config.provider === 'openai') {
      response = await this.callOpenAI(prompt);
    } else {
      response = await this.callAnthropic(prompt);
    }

    return this.parseResponse(response);
  }

  private buildPrompt(template: string, transcript: TranscriptInput, context: MeetingContext): string {
    const duration = this.formatDuration(transcript.duration);

    return template
      .replace('{{meeting_title}}', context.title)
      .replace('{{meeting_date}}', context.date)
      .replace('{{meeting_time}}', context.time || '')
      .replace('{{duration}}', duration)
      .replace('{{participants}}', context.participants.join(', '))
      .replace('{{participant_count}}', String(context.participants.length))
      .replace('{{platform}}', context.platform)
      .replace('{{organizer}}', context.organizer || 'Unknown')
      .replace('{{transcript}}', this.truncateTranscript(transcript.fullText))
      .replace('{{speaker_list}}', transcript.speakers.join(', '));
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes} minutes`;
  }

  private truncateTranscript(text: string, maxChars: number = 30000): string {
    if (text.length <= maxChars) return text;

    // Truncate with ellipsis
    return text.substring(0, maxChars) + '\n\n[Transcript truncated due to length...]';
  }

  private async callOpenAI(prompt: string): Promise<string> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    const response = await this.openaiClient.chat.completions.create({
      model: this.config.model!,
      messages: [
        {
          role: 'system',
          content: 'You are a meeting analysis assistant. Always respond with valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      response_format: { type: 'json_object' },
    });

    return response.choices[0]?.message?.content || '{}';
  }

  private async callAnthropic(prompt: string): Promise<string> {
    if (!this.anthropicClient) {
      throw new Error('Anthropic client not initialized');
    }

    const response = await this.anthropicClient.messages.create({
      model: this.config.model!,
      max_tokens: this.config.maxTokens!,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const textBlock = response.content.find((block: any) => block.type === 'text');
    return textBlock && 'text' in textBlock ? textBlock.text : '{}';
  }

  private parseResponse(response: string): MeetingSummary {
    try {
      // Extract JSON from response (in case there's extra text)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and normalize
      return {
        overview: parsed.overview || 'No overview available.',
        keyPoints: Array.isArray(parsed.keyPoints)
          ? parsed.keyPoints.map((kp: any) => ({
              topic: kp.topic || 'Unknown Topic',
              summary: kp.summary || '',
              speakers: Array.isArray(kp.speakers) ? kp.speakers : [],
              timestamp: kp.timestamp,
            }))
          : [],
        decisions: Array.isArray(parsed.decisions)
          ? parsed.decisions.map((d: any) => ({
              description: d.description || '',
              context: d.context,
              madeBy: d.madeBy,
              timestamp: d.timestamp,
            }))
          : [],
        actionItems: Array.isArray(parsed.actionItems)
          ? parsed.actionItems.map((ai: any) => ({
              description: ai.description || '',
              assignee: ai.assignee || 'Unassigned',
              dueDate: ai.dueDate || null,
              priority: ['high', 'medium', 'low'].includes(ai.priority) ? ai.priority : 'medium',
              status: ai.status || 'pending',
            }))
          : [],
        nextSteps: parsed.nextSteps,
      };
    } catch (error) {
      logger.error('Failed to parse LLM response:', error as Error);
      throw new Error(`Failed to parse summary response: ${error}`);
    }
  }
}

// Export factory function
export function createSummaryGenerator(config?: Partial<SummaryGeneratorConfig>): SummaryGenerator {
  return new SummaryGenerator(config);
}
