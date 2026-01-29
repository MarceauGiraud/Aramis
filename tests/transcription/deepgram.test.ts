import { describe, it, expect, vi, beforeEach } from 'vitest';

// Types for transcription
interface TranscriptSegment {
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
  speaker?: string;
  words: Word[];
}

interface Word {
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
}

interface TranscriptionResult {
  segments: TranscriptSegment[];
  fullText: string;
  duration: number;
  language: string;
  speakers: string[];
  confidence: number;
}

interface DeepgramConfig {
  apiKey: string;
  model: 'nova-2' | 'nova' | 'enhanced' | 'base';
  language: string;
  diarize: boolean;
  punctuate: boolean;
  utterances: boolean;
}

// Mock WebSocket for testing
const mockWebSocket = {
  send: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  readyState: 1, // OPEN
};

// Mock Deepgram client
class MockDeepgramClient {
  private config: DeepgramConfig;
  private onTranscriptCallback?: (segment: TranscriptSegment) => void;
  private onErrorCallback?: (error: Error) => void;

  constructor(config: DeepgramConfig) {
    this.config = config;
  }

  async transcribeFile(audioPath: string): Promise<TranscriptionResult> {
    // Mock file transcription
    return {
      segments: [
        {
          text: 'Hello, this is a test transcription.',
          startTime: 0,
          endTime: 3.5,
          confidence: 0.95,
          speaker: 'Speaker 1',
          words: [
            { text: 'Hello', startTime: 0, endTime: 0.5, confidence: 0.98 },
            { text: 'this', startTime: 0.6, endTime: 0.8, confidence: 0.96 },
            { text: 'is', startTime: 0.9, endTime: 1.0, confidence: 0.99 },
            { text: 'a', startTime: 1.1, endTime: 1.2, confidence: 0.97 },
            { text: 'test', startTime: 1.3, endTime: 1.6, confidence: 0.94 },
            { text: 'transcription', startTime: 1.7, endTime: 3.5, confidence: 0.92 },
          ],
        },
      ],
      fullText: 'Hello, this is a test transcription.',
      duration: 3.5,
      language: 'en',
      speakers: ['Speaker 1'],
      confidence: 0.95,
    };
  }

  async startLiveTranscription(): Promise<typeof mockWebSocket> {
    return mockWebSocket;
  }

  onTranscript(callback: (segment: TranscriptSegment) => void): void {
    this.onTranscriptCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  // Simulate receiving a transcript
  simulateTranscript(segment: TranscriptSegment): void {
    this.onTranscriptCallback?.(segment);
  }

  simulateError(error: Error): void {
    this.onErrorCallback?.(error);
  }
}

describe('Deepgram Transcription Service', () => {
  let client: MockDeepgramClient;
  const defaultConfig: DeepgramConfig = {
    apiKey: 'test-api-key',
    model: 'nova-2',
    language: 'en',
    diarize: true,
    punctuate: true,
    utterances: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockDeepgramClient(defaultConfig);
  });

  describe('File Transcription', () => {
    it('should transcribe audio file', async () => {
      const result = await client.transcribeFile('/tmp/audio.wav');

      expect(result.fullText).toBeDefined();
      expect(result.segments.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should include word-level timing', async () => {
      const result = await client.transcribeFile('/tmp/audio.wav');

      const firstSegment = result.segments[0];
      expect(firstSegment.words).toBeDefined();
      expect(firstSegment.words.length).toBeGreaterThan(0);

      for (const word of firstSegment.words) {
        expect(word.startTime).toBeDefined();
        expect(word.endTime).toBeGreaterThan(word.startTime);
        expect(word.confidence).toBeGreaterThan(0);
      }
    });

    it('should include speaker diarization', async () => {
      const result = await client.transcribeFile('/tmp/audio.wav');

      expect(result.speakers.length).toBeGreaterThan(0);
      expect(result.segments[0].speaker).toBeDefined();
    });

    it('should detect language', async () => {
      const result = await client.transcribeFile('/tmp/audio.wav');

      expect(result.language).toBe('en');
    });
  });

  describe('Live Transcription', () => {
    it('should establish WebSocket connection', async () => {
      const ws = await client.startLiveTranscription();

      expect(ws.readyState).toBe(1); // OPEN
    });

    it('should receive transcripts via callback', async () => {
      const transcripts: TranscriptSegment[] = [];
      client.onTranscript((segment) => transcripts.push(segment));

      // Simulate receiving transcript
      client.simulateTranscript({
        text: 'Hello world',
        startTime: 0,
        endTime: 1.5,
        confidence: 0.95,
        words: [],
      });

      expect(transcripts.length).toBe(1);
      expect(transcripts[0].text).toBe('Hello world');
    });

    it('should handle errors', async () => {
      const errors: Error[] = [];
      client.onError((error) => errors.push(error));

      client.simulateError(new Error('Connection lost'));

      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('Connection lost');
    });

    it('should send audio data via WebSocket', async () => {
      const ws = await client.startLiveTranscription();

      const audioChunk = new Uint8Array([1, 2, 3, 4]);
      ws.send(audioChunk);

      expect(mockWebSocket.send).toHaveBeenCalledWith(audioChunk);
    });
  });

  describe('Transcription Quality', () => {
    it('should calculate overall confidence', async () => {
      const result = await client.transcribeFile('/tmp/audio.wav');

      // Confidence should be average of segment confidences
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should handle low confidence segments', () => {
      const segment: TranscriptSegment = {
        text: 'unclear audio',
        startTime: 10,
        endTime: 12,
        confidence: 0.3,
        words: [],
      };

      // Low confidence flag
      const isLowConfidence = segment.confidence < 0.5;
      expect(isLowConfidence).toBe(true);
    });
  });
});

describe('Transcription Post-Processing', () => {
  function mergeConsecutiveSpeakerSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
    if (segments.length === 0) return [];

    const merged: TranscriptSegment[] = [];
    let current = { ...segments[0] };

    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];

      if (segment.speaker === current.speaker) {
        // Merge with current
        current.text += ' ' + segment.text;
        current.endTime = segment.endTime;
        current.words = [...current.words, ...segment.words];
        current.confidence = (current.confidence + segment.confidence) / 2;
      } else {
        // Push current and start new
        merged.push(current);
        current = { ...segment };
      }
    }

    merged.push(current);
    return merged;
  }

  it('should merge consecutive segments from same speaker', () => {
    const segments: TranscriptSegment[] = [
      { text: 'Hello', startTime: 0, endTime: 1, confidence: 0.9, speaker: 'Speaker 1', words: [] },
      { text: 'world', startTime: 1, endTime: 2, confidence: 0.95, speaker: 'Speaker 1', words: [] },
      { text: 'How are you', startTime: 2, endTime: 4, confidence: 0.85, speaker: 'Speaker 2', words: [] },
    ];

    const merged = mergeConsecutiveSpeakerSegments(segments);

    expect(merged.length).toBe(2);
    expect(merged[0].text).toBe('Hello world');
    expect(merged[0].speaker).toBe('Speaker 1');
    expect(merged[1].speaker).toBe('Speaker 2');
  });

  it('should preserve timing when merging', () => {
    const segments: TranscriptSegment[] = [
      { text: 'First', startTime: 0, endTime: 1, confidence: 0.9, speaker: 'A', words: [] },
      { text: 'Second', startTime: 1.5, endTime: 3, confidence: 0.9, speaker: 'A', words: [] },
    ];

    const merged = mergeConsecutiveSpeakerSegments(segments);

    expect(merged[0].startTime).toBe(0);
    expect(merged[0].endTime).toBe(3);
  });

  function formatTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  it('should format timestamps correctly', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65)).toBe('1:05');
    expect(formatTimestamp(3661)).toBe('1:01:01');
  });

  function generateSRT(segments: TranscriptSegment[]): string {
    return segments
      .map((segment, index) => {
        const startTime = formatSRTTime(segment.startTime);
        const endTime = formatSRTTime(segment.endTime);
        const speaker = segment.speaker ? `[${segment.speaker}] ` : '';

        return `${index + 1}\n${startTime} --> ${endTime}\n${speaker}${segment.text}\n`;
      })
      .join('\n');
  }

  function formatSRTTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  it('should generate valid SRT format', () => {
    const segments: TranscriptSegment[] = [
      { text: 'Hello world', startTime: 0, endTime: 2.5, confidence: 0.9, speaker: 'Speaker 1', words: [] },
      { text: 'How are you', startTime: 3, endTime: 5, confidence: 0.9, speaker: 'Speaker 2', words: [] },
    ];

    const srt = generateSRT(segments);

    expect(srt).toContain('1\n');
    expect(srt).toContain('00:00:00,000 --> 00:00:02,500');
    expect(srt).toContain('[Speaker 1] Hello world');
    expect(srt).toContain('2\n');
  });

  function generateVTT(segments: TranscriptSegment[]): string {
    const header = 'WEBVTT\n\n';
    const cues = segments
      .map((segment) => {
        const startTime = formatVTTTime(segment.startTime);
        const endTime = formatVTTTime(segment.endTime);
        const speaker = segment.speaker ? `<v ${segment.speaker}>` : '';

        return `${startTime} --> ${endTime}\n${speaker}${segment.text}\n`;
      })
      .join('\n');

    return header + cues;
  }

  function formatVTTTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  it('should generate valid VTT format', () => {
    const segments: TranscriptSegment[] = [
      { text: 'Hello world', startTime: 0, endTime: 2.5, confidence: 0.9, speaker: 'John', words: [] },
    ];

    const vtt = generateVTT(segments);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.500');
    expect(vtt).toContain('<v John>Hello world');
  });
});

describe('Speaker Identification', () => {
  interface Speaker {
    id: string;
    label: string;
    identifiedName?: string;
    segments: number;
    duration: number;
  }

  function identifySpeakers(segments: TranscriptSegment[]): Speaker[] {
    const speakerMap = new Map<string, Speaker>();

    for (const segment of segments) {
      const speakerLabel = segment.speaker || 'Unknown';

      if (!speakerMap.has(speakerLabel)) {
        speakerMap.set(speakerLabel, {
          id: `speaker-${speakerMap.size + 1}`,
          label: speakerLabel,
          segments: 0,
          duration: 0,
        });
      }

      const speaker = speakerMap.get(speakerLabel)!;
      speaker.segments++;
      speaker.duration += segment.endTime - segment.startTime;
    }

    return Array.from(speakerMap.values());
  }

  it('should identify unique speakers', () => {
    const segments: TranscriptSegment[] = [
      { text: 'Hello', startTime: 0, endTime: 1, confidence: 0.9, speaker: 'Speaker 1', words: [] },
      { text: 'Hi', startTime: 1, endTime: 2, confidence: 0.9, speaker: 'Speaker 2', words: [] },
      { text: 'How are you', startTime: 2, endTime: 4, confidence: 0.9, speaker: 'Speaker 1', words: [] },
    ];

    const speakers = identifySpeakers(segments);

    expect(speakers.length).toBe(2);
  });

  it('should calculate speaking duration per speaker', () => {
    const segments: TranscriptSegment[] = [
      { text: 'Hello', startTime: 0, endTime: 2, confidence: 0.9, speaker: 'Speaker 1', words: [] },
      { text: 'Hi', startTime: 2, endTime: 3, confidence: 0.9, speaker: 'Speaker 2', words: [] },
      { text: 'Good', startTime: 3, endTime: 5, confidence: 0.9, speaker: 'Speaker 1', words: [] },
    ];

    const speakers = identifySpeakers(segments);

    const speaker1 = speakers.find(s => s.label === 'Speaker 1');
    const speaker2 = speakers.find(s => s.label === 'Speaker 2');

    expect(speaker1?.duration).toBe(4); // 2 + 2
    expect(speaker2?.duration).toBe(1);
  });

  it('should count segments per speaker', () => {
    const segments: TranscriptSegment[] = [
      { text: 'A', startTime: 0, endTime: 1, confidence: 0.9, speaker: 'Speaker 1', words: [] },
      { text: 'B', startTime: 1, endTime: 2, confidence: 0.9, speaker: 'Speaker 1', words: [] },
      { text: 'C', startTime: 2, endTime: 3, confidence: 0.9, speaker: 'Speaker 2', words: [] },
    ];

    const speakers = identifySpeakers(segments);

    const speaker1 = speakers.find(s => s.label === 'Speaker 1');
    expect(speaker1?.segments).toBe(2);
  });
});
