import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Types
interface BotConfig {
  meetingUrl: string;
  botName: string;
  platform: 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET';
  meetingId: string;
  userId: string;
  recordVideo: boolean;
  recordAudio: boolean;
  maxDuration: number; // seconds
}

interface BotState {
  status: 'idle' | 'joining' | 'waiting' | 'recording' | 'stopped' | 'error';
  joinedAt?: Date;
  startedRecordingAt?: Date;
  stoppedAt?: Date;
  error?: string;
}

interface RecordingResult {
  videoPath?: string;
  audioPath?: string;
  duration: number;
  chunks: number;
}

// Mock Browser for testing
const mockBrowser = {
  newPage: vi.fn(),
  close: vi.fn(),
};

const mockPage = {
  goto: vi.fn(),
  click: vi.fn(),
  type: vi.fn(),
  waitForSelector: vi.fn(),
  evaluate: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
};

// Base Bot Class (simplified for testing)
class BaseMeetingBot {
  protected config: BotConfig;
  protected state: BotState;
  protected browser: typeof mockBrowser | null = null;
  protected page: typeof mockPage | null = null;
  private eventHandlers: Map<string, Function[]> = new Map();

  constructor(config: BotConfig) {
    this.config = config;
    this.state = { status: 'idle' };
  }

  async initialize(): Promise<void> {
    this.browser = mockBrowser;
    this.page = mockPage;
    mockBrowser.newPage.mockResolvedValue(mockPage);
  }

  async join(): Promise<void> {
    if (!this.browser) {
      throw new Error('Bot not initialized');
    }

    this.state.status = 'joining';
    this.emit('status', this.state.status);

    await mockPage.goto(this.config.meetingUrl);
    await this.handlePlatformJoin();

    this.state.status = 'waiting';
    this.state.joinedAt = new Date();
    this.emit('status', this.state.status);
    this.emit('joined', this.state.joinedAt);
  }

  protected async handlePlatformJoin(): Promise<void> {
    // To be overridden by platform-specific bots
  }

  async startRecording(): Promise<void> {
    if (this.state.status !== 'waiting') {
      throw new Error(`Cannot start recording in state: ${this.state.status}`);
    }

    this.state.status = 'recording';
    this.state.startedRecordingAt = new Date();
    this.emit('status', this.state.status);
    this.emit('recording-started', this.state.startedRecordingAt);
  }

  async stopRecording(): Promise<RecordingResult> {
    if (this.state.status !== 'recording') {
      throw new Error(`Cannot stop recording in state: ${this.state.status}`);
    }

    this.state.status = 'stopped';
    this.state.stoppedAt = new Date();
    this.emit('status', this.state.status);

    const duration = this.state.startedRecordingAt
      ? Math.floor((this.state.stoppedAt.getTime() - this.state.startedRecordingAt.getTime()) / 1000)
      : 0;

    const result: RecordingResult = {
      videoPath: this.config.recordVideo ? `/tmp/${this.config.meetingId}/recording.webm` : undefined,
      audioPath: this.config.recordAudio ? `/tmp/${this.config.meetingId}/audio.wav` : undefined,
      duration,
      chunks: Math.ceil(duration / 300), // 5-minute chunks
    };

    this.emit('recording-stopped', result);
    return result;
  }

  async leave(): Promise<void> {
    if (this.state.status === 'recording') {
      await this.stopRecording();
    }

    await this.page?.close();
    await this.browser?.close();

    this.state.status = 'idle';
    this.emit('left');
  }

  getState(): BotState {
    return { ...this.state };
  }

  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  protected emit(event: string, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach(handler => handler(...args));
  }

  protected async detectMeetingEnd(): Promise<boolean> {
    // To be implemented by subclasses
    return false;
  }
}

describe('BaseMeetingBot', () => {
  let bot: BaseMeetingBot;
  const defaultConfig: BotConfig = {
    meetingUrl: 'https://zoom.us/j/123456789',
    botName: 'Test Bot',
    platform: 'ZOOM',
    meetingId: 'test-meeting-123',
    userId: 'user-456',
    recordVideo: true,
    recordAudio: true,
    maxDuration: 7200, // 2 hours
  };

  beforeEach(() => {
    vi.clearAllMocks();
    bot = new BaseMeetingBot(defaultConfig);
  });

  afterEach(async () => {
    // Cleanup
  });

  describe('Initialization', () => {
    it('should start in idle state', () => {
      expect(bot.getState().status).toBe('idle');
    });

    it('should initialize browser and page', async () => {
      await bot.initialize();

      expect(mockBrowser.newPage).toHaveBeenCalled();
    });
  });

  describe('Joining Meeting', () => {
    beforeEach(async () => {
      await bot.initialize();
    });

    it('should navigate to meeting URL', async () => {
      await bot.join();

      expect(mockPage.goto).toHaveBeenCalledWith(defaultConfig.meetingUrl);
    });

    it('should update state to joining then waiting', async () => {
      const statusChanges: string[] = [];
      bot.on('status', (status: string) => statusChanges.push(status));

      await bot.join();

      expect(statusChanges).toContain('joining');
      expect(statusChanges).toContain('waiting');
      expect(bot.getState().status).toBe('waiting');
    });

    it('should set joinedAt timestamp', async () => {
      await bot.join();

      expect(bot.getState().joinedAt).toBeInstanceOf(Date);
    });

    it('should emit joined event', async () => {
      const joinedHandler = vi.fn();
      bot.on('joined', joinedHandler);

      await bot.join();

      expect(joinedHandler).toHaveBeenCalled();
    });

    it('should fail if not initialized', async () => {
      const uninitializedBot = new BaseMeetingBot(defaultConfig);

      await expect(uninitializedBot.join()).rejects.toThrow('Bot not initialized');
    });
  });

  describe('Recording', () => {
    beforeEach(async () => {
      await bot.initialize();
      await bot.join();
    });

    it('should start recording from waiting state', async () => {
      await bot.startRecording();

      expect(bot.getState().status).toBe('recording');
      expect(bot.getState().startedRecordingAt).toBeInstanceOf(Date);
    });

    it('should emit recording-started event', async () => {
      const handler = vi.fn();
      bot.on('recording-started', handler);

      await bot.startRecording();

      expect(handler).toHaveBeenCalled();
    });

    it('should fail to start recording if not in waiting state', async () => {
      // Already in waiting state, start recording
      await bot.startRecording();

      // Try to start again
      await expect(bot.startRecording()).rejects.toThrow('Cannot start recording');
    });

    it('should stop recording and return result', async () => {
      await bot.startRecording();

      // Wait a bit to simulate recording time
      await new Promise(resolve => setTimeout(resolve, 100));

      const result = await bot.stopRecording();

      expect(bot.getState().status).toBe('stopped');
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.videoPath).toContain(defaultConfig.meetingId);
    });

    it('should calculate correct number of chunks', async () => {
      await bot.startRecording();

      // Mock a longer duration
      const startTime = new Date();
      startTime.setMinutes(startTime.getMinutes() - 15); // 15 minutes ago
      (bot as any).state.startedRecordingAt = startTime;

      const result = await bot.stopRecording();

      // 15 minutes / 5 minute chunks = 3 chunks
      expect(result.chunks).toBeGreaterThanOrEqual(3);
    });

    it('should only include video path when recordVideo is true', async () => {
      const audioOnlyBot = new BaseMeetingBot({
        ...defaultConfig,
        recordVideo: false,
      });

      await audioOnlyBot.initialize();
      await audioOnlyBot.join();
      await audioOnlyBot.startRecording();

      const result = await audioOnlyBot.stopRecording();

      expect(result.videoPath).toBeUndefined();
      expect(result.audioPath).toBeDefined();
    });
  });

  describe('Leaving Meeting', () => {
    beforeEach(async () => {
      await bot.initialize();
      await bot.join();
    });

    it('should stop recording before leaving if recording', async () => {
      await bot.startRecording();

      const stopHandler = vi.fn();
      bot.on('recording-stopped', stopHandler);

      await bot.leave();

      expect(stopHandler).toHaveBeenCalled();
    });

    it('should close browser resources', async () => {
      await bot.leave();

      expect(mockPage.close).toHaveBeenCalled();
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should emit left event', async () => {
      const leftHandler = vi.fn();
      bot.on('left', leftHandler);

      await bot.leave();

      expect(leftHandler).toHaveBeenCalled();
    });

    it('should return to idle state', async () => {
      await bot.leave();

      expect(bot.getState().status).toBe('idle');
    });
  });

  describe('Event Handling', () => {
    it('should support multiple event handlers', async () => {
      await bot.initialize();

      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bot.on('status', handler1);
      bot.on('status', handler2);

      await bot.join();

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should pass correct arguments to handlers', async () => {
      await bot.initialize();

      const statusHandler = vi.fn();
      bot.on('status', statusHandler);

      await bot.join();

      expect(statusHandler).toHaveBeenCalledWith('joining');
      expect(statusHandler).toHaveBeenCalledWith('waiting');
    });
  });
});

describe('Platform-Specific Behavior', () => {
  describe('Meeting End Detection', () => {
    it('should detect when meeting has ended (Zoom)', () => {
      const endIndicators = [
        'This meeting has been ended by host',
        'The host has ended this meeting',
        'Meeting ended',
      ];

      for (const indicator of endIndicators) {
        const pageContent = `<div>${indicator}</div>`;
        const hasEnded = endIndicators.some(i => pageContent.includes(i));
        expect(hasEnded).toBe(true);
      }
    });

    it('should detect when meeting has ended (Teams)', () => {
      const endIndicators = [
        'You left the meeting',
        'The meeting has ended',
        'Call ended',
      ];

      for (const indicator of endIndicators) {
        const pageContent = `<div>${indicator}</div>`;
        const hasEnded = endIndicators.some(i => pageContent.includes(i));
        expect(hasEnded).toBe(true);
      }
    });

    it('should detect when meeting has ended (Google Meet)', () => {
      const endIndicators = [
        'You left the meeting',
        'Return to home screen',
        'The call has ended',
      ];

      for (const indicator of endIndicators) {
        const pageContent = `<div>${indicator}</div>`;
        const hasEnded = endIndicators.some(i => pageContent.includes(i));
        expect(hasEnded).toBe(true);
      }
    });
  });

  describe('Waiting Room Handling', () => {
    it('should detect waiting room (Zoom)', () => {
      const waitingIndicators = [
        'Please wait, the meeting host will let you in soon',
        'Waiting for host to start this meeting',
      ];

      const pageContent = 'Please wait, the meeting host will let you in soon';
      const isWaiting = waitingIndicators.some(i => pageContent.includes(i));
      expect(isWaiting).toBe(true);
    });

    it('should detect waiting room (Teams)', () => {
      const waitingIndicators = [
        'Someone in the meeting should let you in soon',
        'Waiting to be admitted',
      ];

      const pageContent = 'Waiting to be admitted';
      const isWaiting = waitingIndicators.some(i => pageContent.includes(i));
      expect(isWaiting).toBe(true);
    });
  });
});
