import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger';

// Types for the agent
export interface TranscriptSegment {
  text: string;
  startTime: number;
  endTime: number;
  speaker?: string;
}

export interface TranscriptData {
  fullText: string;
  segments: TranscriptSegment[];
  speakers: string[];
  duration: number;
}

export interface MeetingContext {
  title: string;
  date: string;
  participants: string[];
  platform: string;
}

export interface AgentSummary {
  overview: string;
  keyPoints: Array<{
    topic: string;
    summary: string;
    speakers?: string[];
    timestamp?: number;
    confidence: 'high' | 'medium' | 'low';
  }>;
  decisions: Array<{
    description: string;
    context?: string;
    madeBy?: string;
    timestamp?: number;
  }>;
  actionItems: Array<{
    description: string;
    assignee?: string;
    dueDate?: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  nextSteps?: string;
  agentReflection: string;
}

// Tool definitions for Claude
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_transcript',
    description: 'Search the transcript for specific keywords or phrases. Returns matching segments with timestamps.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The search query - keywords or phrases to find in the transcript',
        },
        speaker_filter: {
          type: 'string',
          description: 'Optional: Filter results to a specific speaker',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_segment_by_time',
    description: 'Get the transcript segment at a specific timestamp. Useful for examining a particular moment in the meeting.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_time: {
          type: 'number',
          description: 'Start time in seconds from the beginning of the meeting',
        },
        end_time: {
          type: 'number',
          description: 'End time in seconds (optional, defaults to start_time + 60)',
        },
      },
      required: ['start_time'],
    },
  },
  {
    name: 'get_speaker_segments',
    description: 'Get all segments where a specific speaker is talking. Useful for understanding what a particular person said.',
    input_schema: {
      type: 'object' as const,
      properties: {
        speaker: {
          type: 'string',
          description: 'The speaker name or identifier (e.g., "Speaker 1", "John")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of segments to return (default: 10)',
        },
      },
      required: ['speaker'],
    },
  },
  {
    name: 'verify_claim',
    description: 'Verify if a specific claim or statement was actually made in the meeting. Returns evidence from the transcript.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claim: {
          type: 'string',
          description: 'The claim to verify (e.g., "John agreed to send the report by Friday")',
        },
      },
      required: ['claim'],
    },
  },
  {
    name: 'get_meeting_stats',
    description: 'Get statistics about the meeting: total duration, speaking time per person, number of topics discussed.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'finalize_summary',
    description: 'Call this when you have gathered enough information and are ready to produce the final summary.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'object',
          description: 'The complete meeting summary',
          properties: {
            overview: { type: 'string' },
            keyPoints: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  topic: { type: 'string' },
                  summary: { type: 'string' },
                  speakers: { type: 'array', items: { type: 'string' } },
                  timestamp: { type: 'number' },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
              },
            },
            decisions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  context: { type: 'string' },
                  madeBy: { type: 'string' },
                  timestamp: { type: 'number' },
                },
              },
            },
            actionItems: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  assignee: { type: 'string' },
                  dueDate: { type: 'string' },
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
              },
            },
            nextSteps: { type: 'string' },
            agentReflection: { type: 'string' },
          },
        },
      },
      required: ['summary'],
    },
  },
];

export class ClaudeSummaryAgent {
  private client: Anthropic;
  private transcript: TranscriptData;
  private context: MeetingContext;
  private maxIterations: number;

  constructor(options: {
    apiKey?: string;
    maxIterations?: number;
  } = {}) {
    this.client = new Anthropic({
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY,
    });
    this.maxIterations = options.maxIterations || 10;
    this.transcript = { fullText: '', segments: [], speakers: [], duration: 0 };
    this.context = { title: '', date: '', participants: [], platform: '' };
  }

  /**
   * Generate summary using agentic approach with tools
   */
  async generateSummary(
    transcript: TranscriptData,
    context: MeetingContext
  ): Promise<AgentSummary> {
    this.transcript = transcript;
    this.context = context;

    logger.info(`Starting Claude agent for meeting: ${context.title}`);

    const systemPrompt = this.buildSystemPrompt();
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: this.buildInitialPrompt(),
      },
    ];

    let iteration = 0;
    let finalSummary: AgentSummary | null = null;

    while (iteration < this.maxIterations && !finalSummary) {
      iteration++;
      logger.info(`Agent iteration ${iteration}/${this.maxIterations}`);

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });

      // Process the response
      const assistantContent: Anthropic.ContentBlock[] = [];
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        assistantContent.push(block);

        if (block.type === 'tool_use') {
          logger.info(`Agent using tool: ${block.name}`);

          const result = await this.executeTool(block.name, block.input as Record<string, unknown>);

          // Check if this is the finalize_summary tool
          if (block.name === 'finalize_summary' && result.success) {
            finalSummary = result.data as AgentSummary;
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }

      // Add assistant message
      messages.push({
        role: 'assistant',
        content: assistantContent,
      });

      // Add tool results if any
      if (toolResults.length > 0) {
        messages.push({
          role: 'user',
          content: toolResults,
        });
      }

      // Check if agent is done (stop_reason is end_turn without tool calls)
      if (response.stop_reason === 'end_turn' && !response.content.some(b => b.type === 'tool_use')) {
        // Agent finished without calling finalize_summary - extract from text
        const textBlock = response.content.find(b => b.type === 'text');
        if (textBlock && textBlock.type === 'text') {
          logger.warn('Agent finished without finalize_summary, extracting from text');
          finalSummary = this.extractSummaryFromText(textBlock.text);
        }
      }
    }

    if (!finalSummary) {
      throw new Error('Agent failed to produce a summary within max iterations');
    }

    logger.info(`Agent completed in ${iteration} iterations`);
    return finalSummary;
  }

  private buildSystemPrompt(): string {
    return `Tu es un assistant expert en analyse de réunions. Tu dois produire un résumé structuré et précis.

PROCESSUS EN PLUSIEURS ÉTAPES:
1. D'abord, lis le transcript complet pour comprendre le contexte général
2. Utilise l'outil search_transcript pour trouver les moments clés (décisions, action items, etc.)
3. Utilise get_segment_by_time pour examiner en détail les passages importants
4. Utilise verify_claim pour vérifier tes conclusions avant de les inclure
5. Utilise get_meeting_stats pour comprendre la dynamique de la réunion
6. Appelle finalize_summary quand tu as assez d'informations

RÈGLES IMPORTANTES:
- Vérifie TOUJOURS les informations avant de les inclure dans le résumé
- Attribue un niveau de confiance (high/medium/low) à chaque point clé
- Si tu n'es pas sûr d'une information, utilise verify_claim
- Inclus les timestamps quand possible
- Identifie clairement qui a dit quoi

RÉFLEXION:
Dans agentReflection, explique:
- Quels outils tu as utilisés et pourquoi
- Ce que tu as vérifié
- Les zones d'incertitude restantes`;
  }

  private buildInitialPrompt(): string {
    const transcriptPreview = this.transcript.fullText.substring(0, 3000);
    const hasMore = this.transcript.fullText.length > 3000;

    return `Analyse cette réunion et produis un résumé structuré.

## Informations
- Titre: ${this.context.title}
- Date: ${this.context.date}
- Plateforme: ${this.context.platform}
- Participants: ${this.context.participants.join(', ')}
- Durée: ${Math.round(this.transcript.duration / 60)} minutes
- Speakers détectés: ${this.transcript.speakers.join(', ')}

## Début du Transcript
${transcriptPreview}
${hasMore ? '\n[... transcript continues - use search_transcript to explore more ...]' : ''}

Commence par explorer le transcript avec les outils disponibles, puis produis un résumé complet.`;
  }

  private async executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    try {
      switch (name) {
        case 'search_transcript':
          return this.toolSearchTranscript(input.query as string, input.speaker_filter as string | undefined);

        case 'get_segment_by_time':
          return this.toolGetSegmentByTime(input.start_time as number, input.end_time as number | undefined);

        case 'get_speaker_segments':
          return this.toolGetSpeakerSegments(input.speaker as string, input.limit as number | undefined);

        case 'verify_claim':
          return this.toolVerifyClaim(input.claim as string);

        case 'get_meeting_stats':
          return this.toolGetMeetingStats();

        case 'finalize_summary':
          return { success: true, data: input.summary };

        default:
          return { success: false, error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      logger.error(`Tool ${name} failed:`, error);
      return { success: false, error: String(error) };
    }
  }

  private toolSearchTranscript(
    query: string,
    speakerFilter?: string
  ): { success: boolean; data: unknown } {
    const queryLower = query.toLowerCase();
    const results: Array<{
      text: string;
      speaker?: string;
      startTime: number;
      endTime: number;
      matchContext: string;
    }> = [];

    for (const segment of this.transcript.segments) {
      if (segment.text.toLowerCase().includes(queryLower)) {
        if (speakerFilter && segment.speaker !== speakerFilter) continue;

        // Get context (surrounding text)
        const segmentIndex = this.transcript.segments.indexOf(segment);
        const prevSegment = this.transcript.segments[segmentIndex - 1];
        const nextSegment = this.transcript.segments[segmentIndex + 1];

        const matchContext = [
          prevSegment?.text ? `[${prevSegment.speaker}]: ${prevSegment.text}` : '',
          `>>> [${segment.speaker}]: ${segment.text} <<<`,
          nextSegment?.text ? `[${nextSegment.speaker}]: ${nextSegment.text}` : '',
        ].filter(Boolean).join('\n');

        results.push({
          text: segment.text,
          speaker: segment.speaker,
          startTime: segment.startTime,
          endTime: segment.endTime,
          matchContext,
        });
      }
    }

    return {
      success: true,
      data: {
        query,
        matchCount: results.length,
        matches: results.slice(0, 10), // Limit to 10 results
      },
    };
  }

  private toolGetSegmentByTime(
    startTime: number,
    endTime?: number
  ): { success: boolean; data: unknown } {
    const end = endTime || startTime + 60;
    const segments = this.transcript.segments.filter(
      s => s.startTime >= startTime && s.startTime <= end
    );

    const text = segments.map(s => `[${this.formatTime(s.startTime)}] [${s.speaker}]: ${s.text}`).join('\n');

    return {
      success: true,
      data: {
        startTime,
        endTime: end,
        segmentCount: segments.length,
        transcript: text,
      },
    };
  }

  private toolGetSpeakerSegments(
    speaker: string,
    limit: number = 10
  ): { success: boolean; data: unknown } {
    const segments = this.transcript.segments
      .filter(s => s.speaker?.toLowerCase().includes(speaker.toLowerCase()))
      .slice(0, limit);

    const totalDuration = segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);

    return {
      success: true,
      data: {
        speaker,
        segmentCount: segments.length,
        totalSpeakingTime: Math.round(totalDuration),
        segments: segments.map(s => ({
          time: this.formatTime(s.startTime),
          text: s.text,
        })),
      },
    };
  }

  private toolVerifyClaim(claim: string): { success: boolean; data: unknown } {
    // Extract key words from claim
    const keywords = claim.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);

    // Search for evidence
    const evidence: Array<{
      segment: string;
      speaker?: string;
      time: string;
      relevance: 'strong' | 'moderate' | 'weak';
    }> = [];

    for (const segment of this.transcript.segments) {
      const segmentLower = segment.text.toLowerCase();
      const matchCount = keywords.filter(kw => segmentLower.includes(kw)).length;
      const matchRatio = matchCount / keywords.length;

      if (matchRatio >= 0.3) {
        evidence.push({
          segment: segment.text,
          speaker: segment.speaker,
          time: this.formatTime(segment.startTime),
          relevance: matchRatio >= 0.7 ? 'strong' : matchRatio >= 0.5 ? 'moderate' : 'weak',
        });
      }
    }

    // Sort by relevance
    evidence.sort((a, b) => {
      const order = { strong: 0, moderate: 1, weak: 2 };
      return order[a.relevance] - order[b.relevance];
    });

    const verified = evidence.some(e => e.relevance === 'strong');

    return {
      success: true,
      data: {
        claim,
        verified,
        confidence: evidence.length === 0 ? 'not_found' :
          evidence[0].relevance === 'strong' ? 'high' :
          evidence[0].relevance === 'moderate' ? 'medium' : 'low',
        evidenceCount: evidence.length,
        topEvidence: evidence.slice(0, 3),
      },
    };
  }

  private toolGetMeetingStats(): { success: boolean; data: unknown } {
    // Calculate speaker stats
    const speakerStats: Record<string, { segments: number; duration: number }> = {};

    for (const segment of this.transcript.segments) {
      const speaker = segment.speaker || 'Unknown';
      if (!speakerStats[speaker]) {
        speakerStats[speaker] = { segments: 0, duration: 0 };
      }
      speakerStats[speaker].segments++;
      speakerStats[speaker].duration += segment.endTime - segment.startTime;
    }

    // Calculate topic changes (rough estimate based on pauses or speaker changes)
    let topicChanges = 0;
    for (let i = 1; i < this.transcript.segments.length; i++) {
      const gap = this.transcript.segments[i].startTime - this.transcript.segments[i-1].endTime;
      if (gap > 5) topicChanges++; // 5 second gap suggests topic change
    }

    return {
      success: true,
      data: {
        totalDuration: Math.round(this.transcript.duration),
        totalDurationFormatted: this.formatTime(this.transcript.duration),
        totalSegments: this.transcript.segments.length,
        estimatedTopics: Math.max(1, Math.round(topicChanges / 3)),
        speakers: Object.entries(speakerStats).map(([name, stats]) => ({
          name,
          segments: stats.segments,
          speakingTime: Math.round(stats.duration),
          percentage: Math.round((stats.duration / this.transcript.duration) * 100),
        })),
      },
    };
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  private extractSummaryFromText(text: string): AgentSummary {
    // Fallback: try to extract summary from agent's text response
    return {
      overview: text.substring(0, 500),
      keyPoints: [],
      decisions: [],
      actionItems: [],
      agentReflection: 'Summary extracted from text response (agent did not use finalize_summary tool)',
    };
  }
}

// Factory function
export function createClaudeSummaryAgent(options?: {
  apiKey?: string;
  maxIterations?: number;
}): ClaudeSummaryAgent {
  return new ClaudeSummaryAgent(options);
}
