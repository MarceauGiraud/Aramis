import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger before importing TeamsBot
vi.mock('../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock shared constants — use importOriginal to keep all exports
vi.mock('@aramis/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aramis/shared')>();
  return {
    ...actual,
    BOT_CONFIG: {
      ...actual.BOT_CONFIG,
      JOIN_MAX_ATTEMPTS: 3,
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers to build a mock Playwright Page
// ---------------------------------------------------------------------------

interface MockPageOptions {
  url?: string;
  title?: string;
  bodyText?: string;
  selectors?: Record<string, any>;
  evaluateResult?: any;
}

function createMockPage(opts: MockPageOptions = {}) {
  const {
    url = 'https://teams.microsoft.com/v2/meet/abc123',
    title = 'Microsoft Teams',
    bodyText = '',
    selectors = {},
  } = opts;

  let currentUrl = url;
  let currentBodyText = bodyText;
  let currentSelectors = { ...selectors };
  let evaluateOverride: ((fn: Function) => any) | null = null;

  const page: any = {
    url: () => currentUrl,
    title: vi.fn().mockResolvedValue(title),
    textContent: vi.fn().mockImplementation((_sel: string) => Promise.resolve(currentBodyText)),

    goto: vi.fn().mockImplementation((newUrl: string) => {
      currentUrl = newUrl;
      return Promise.resolve();
    }),

    $: vi.fn().mockImplementation((selector: string) => {
      if (currentSelectors[selector]) {
        return Promise.resolve(currentSelectors[selector]);
      }
      return Promise.resolve(null);
    }),

    $$: vi.fn().mockImplementation((selector: string) => {
      if (Array.isArray(currentSelectors[selector])) {
        return Promise.resolve(currentSelectors[selector]);
      }
      return Promise.resolve([]);
    }),

    evaluate: vi.fn().mockImplementation((fn: Function) => {
      if (evaluateOverride) {
        return Promise.resolve(evaluateOverride(fn));
      }
      // Execute the function with a mock document/window
      return Promise.resolve(opts.evaluateResult ?? null);
    }),

    close: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(null),
    click: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    mouse: { move: vi.fn().mockResolvedValue(undefined) },
    viewportSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
    on: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),

    // Helpers for test mutation
    _setUrl(u: string) {
      currentUrl = u;
    },
    _setBodyText(t: string) {
      currentBodyText = t;
    },
    _setSelectors(s: Record<string, any>) {
      currentSelectors = { ...s };
    },
    _setEvaluateOverride(fn: ((f: Function) => any) | null) {
      evaluateOverride = fn;
    },
  };

  return page;
}

function createMockElement(attrs: Record<string, string | null> = {}) {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn().mockImplementation((name: string) => {
      return Promise.resolve(attrs[name] ?? null);
    }),
    textContent: vi.fn().mockResolvedValue(''),
  };
}

// ---------------------------------------------------------------------------
// Import TeamsBot (after mocks are set up)
// ---------------------------------------------------------------------------

import { TeamsBot } from '../bots/teams';
import { JoinError } from '../bots/base';

// Helper to create a TeamsBot with a mock page injected
function createTeamsBot(pageOpts?: MockPageOptions) {
  const bot = new TeamsBot({
    meetingUrl: 'https://teams.microsoft.com/meet/abc123?p=token',
    botName: 'Test Bot',
    platform: 'TEAMS',
    meetingId: 'test-meeting-id',
  });

  const mockPage = createMockPage(pageOpts);
  (bot as any).page = mockPage;
  (bot as any).context = { waitForEvent: vi.fn() };

  return { bot, mockPage };
}

// ============================================================================
// Tests
// ============================================================================

describe('TeamsBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. URL Transformation
  // --------------------------------------------------------------------------
  describe('buildWebClientUrl()', () => {
    it('should transform /meet/<id> URLs to /v2/meet/<id> with anon=true', () => {
      const { bot } = createTeamsBot();
      const result = (bot as any).buildWebClientUrl('https://teams.microsoft.com/meet/abc123?p=token');
      expect(result).toContain('/v2/meet/abc123');
      expect(result).toContain('anon=true');
      expect(result).toContain('p=token');
    });

    it('should extract embedded URL from launcher links', () => {
      const { bot } = createTeamsBot();
      const embedded = encodeURIComponent('/_#/l/meetup-join/19:meeting_abc@thread.v2/0?context={"Tid":"xyz"}');
      const launcherUrl = `https://teams.microsoft.com/dl/launcher/launcher.html?url=${embedded}&type=meetup-join`;
      const result = (bot as any).buildWebClientUrl(launcherUrl);

      expect(result).toContain('/v2/');
      expect(result).toContain('meetup-join');
      expect(result).toContain('anon=true');
      // Should not contain /_#/ prefix
      expect(result).not.toContain('_#');
    });

    it('should preserve /v2/ URLs and add anon param if missing', () => {
      const { bot } = createTeamsBot();
      const v2Url = 'https://teams.microsoft.com/v2/#/l/meetup-join/19:meeting_abc@thread.v2/0';
      const result = (bot as any).buildWebClientUrl(v2Url);

      expect(result).toContain('/v2/');
      expect(result).toContain('anon=true');
    });

    it('should not duplicate anon param on /v2/ URLs that already have it as a search param', () => {
      const { bot } = createTeamsBot();
      const v2Url = 'https://teams.microsoft.com/v2/?anon=true#/l/meetup-join/19:meeting@thread.v2/0';
      const result = (bot as any).buildWebClientUrl(v2Url);

      // Should only have one anon=true in the search params
      const url = new URL(result);
      expect(url.searchParams.getAll('anon')).toHaveLength(1);
      expect(url.searchParams.get('anon')).toBe('true');
    });

    it('should add anon as search param even when present in hash fragment', () => {
      const { bot } = createTeamsBot();
      // anon=true is in the hash fragment, not in search params
      const v2Url = 'https://teams.microsoft.com/v2/#/l/meetup-join/19:meeting@thread.v2/0?anon=true';
      const result = (bot as any).buildWebClientUrl(v2Url);

      // URL.searchParams doesn't see hash params, so anon gets added as a search param too
      const url = new URL(result);
      expect(url.searchParams.get('anon')).toBe('true');
    });

    it('should add anti-launcher params for /l/meetup-join/ URLs', () => {
      const { bot } = createTeamsBot();
      const meetupUrl = 'https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0';
      const result = (bot as any).buildWebClientUrl(meetupUrl);

      expect(result).toContain('msLaunch=false');
      expect(result).toContain('suppressPrompt=true');
      expect(result).toContain('directDl=true');
      expect(result).toContain('anon=true');
    });

    it('should fallback to v2 prefix for unknown URL formats', () => {
      const { bot } = createTeamsBot();
      const unknownUrl = 'https://teams.microsoft.com/some/unknown/path';
      const result = (bot as any).buildWebClientUrl(unknownUrl);

      expect(result).toContain('/v2/some/unknown/path');
      expect(result).toContain('anon=true');
    });

    it('should return original URL on parse failure (invalid URL)', () => {
      const { bot } = createTeamsBot();
      const result = (bot as any).buildWebClientUrl('not-a-valid-url');
      expect(result).toBe('not-a-valid-url');
    });
  });

  describe('buildV2Url()', () => {
    it('should prepend /v2 to a path starting with /', () => {
      const { bot } = createTeamsBot();
      const result = (bot as any).buildV2Url('/meet/abc123?p=token');

      expect(result).toBe('https://teams.microsoft.com/v2/meet/abc123?p=token&anon=true');
    });

    it('should handle path without leading slash', () => {
      const { bot } = createTeamsBot();
      const result = (bot as any).buildV2Url('meet/abc123');

      expect(result).toContain('/v2/meet/abc123');
      expect(result).toContain('anon=true');
    });

    it('should add anon=true if not present', () => {
      const { bot } = createTeamsBot();
      const result = (bot as any).buildV2Url('/l/meetup-join/19:meeting@thread.v2/0');
      expect(result).toContain('anon=true');
    });

    it('should not duplicate anon param if already present', () => {
      const { bot } = createTeamsBot();
      const result = (bot as any).buildV2Url('/meet/abc?anon=true');

      const matches = result.match(/anon=true/g);
      expect(matches).toHaveLength(1);
    });

    it('should handle complex thread IDs', () => {
      const { bot } = createTeamsBot();
      const path = '/l/meetup-join/19:meeting_ZjA4OTBkMDYtN2U1OS00NzE4@thread.v2/0?context={"Tid":"abc-123"}';
      const result = (bot as any).buildV2Url(path);

      expect(result).toContain('/v2/l/meetup-join/');
      expect(result).toContain('19:meeting_ZjA4OTBkMDYtN2U1OS00NzE4');
    });
  });

  describe('addAntiLauncherParams()', () => {
    it('should add all four anti-launcher params', () => {
      const { bot } = createTeamsBot();
      const url = new URL('https://teams.microsoft.com/l/meetup-join/19:meeting@thread.v2/0');
      (bot as any).addAntiLauncherParams(url);

      expect(url.searchParams.get('msLaunch')).toBe('false');
      expect(url.searchParams.get('suppressPrompt')).toBe('true');
      expect(url.searchParams.get('directDl')).toBe('true');
      expect(url.searchParams.get('anon')).toBe('true');
    });

    it('should overwrite existing params', () => {
      const { bot } = createTeamsBot();
      const url = new URL('https://teams.microsoft.com/l/meetup-join/19:meeting@thread.v2/0?msLaunch=true');
      (bot as any).addAntiLauncherParams(url);

      expect(url.searchParams.get('msLaunch')).toBe('false');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Error State Detection
  // --------------------------------------------------------------------------
  describe('checkForErrorStates()', () => {
    it('should throw non-retryable JoinError on captcha detection', async () => {
      const { bot, mockPage } = createTeamsBot();
      mockPage.evaluate.mockResolvedValueOnce({ error: 'captcha', retryable: false });

      await expect((bot as any).checkForErrorStates()).rejects.toThrow(JoinError);
      await expect(async () => {
        mockPage.evaluate.mockResolvedValueOnce({ error: 'captcha', retryable: false });
        await (bot as any).checkForErrorStates();
      }).rejects.toMatchObject({ retryable: false });
    });

    it('should throw non-retryable JoinError on login form redirect', async () => {
      const { bot, mockPage } = createTeamsBot();
      mockPage.evaluate.mockResolvedValueOnce({ error: 'login_form_redirect', retryable: false });

      await expect((bot as any).checkForErrorStates()).rejects.toThrow('Teams error: login_form_redirect');
    });

    it('should throw non-retryable JoinError on sign-in required', async () => {
      const { bot, mockPage } = createTeamsBot();
      mockPage.evaluate.mockResolvedValueOnce({ error: 'sign_in_required: Sign in to join', retryable: false });

      await expect((bot as any).checkForErrorStates()).rejects.toThrow('sign_in_required');
    });

    it('should throw retryable JoinError on connection failure', async () => {
      const { bot, mockPage } = createTeamsBot();
      mockPage.evaluate.mockResolvedValueOnce({ error: 'connection_failure', retryable: true });

      try {
        await (bot as any).checkForErrorStates();
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(JoinError);
        expect(e.retryable).toBe(true);
        expect(e.message).toContain('connection_failure');
      }
    });

    it('should not throw when no error state is detected', async () => {
      const { bot, mockPage } = createTeamsBot();
      mockPage.evaluate.mockResolvedValueOnce(null);

      await expect((bot as any).checkForErrorStates()).resolves.toBeUndefined();
    });

    it('should not throw when evaluate rejects (page navigating)', async () => {
      const { bot, mockPage } = createTeamsBot();
      mockPage.evaluate.mockRejectedValueOnce(new Error('Execution context destroyed'));

      await expect((bot as any).checkForErrorStates()).resolves.toBeUndefined();
    });

    it('should not throw when page is null', async () => {
      const { bot } = createTeamsBot();
      (bot as any).page = null;

      await expect((bot as any).checkForErrorStates()).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Join Transition Detection
  // --------------------------------------------------------------------------
  describe('waitForJoinTransition()', () => {
    it('should return "meeting" when hangup button is detected', async () => {
      const { bot, mockPage } = createTeamsBot();
      mockPage.evaluate.mockResolvedValue('meeting');

      const result = await (bot as any).waitForJoinTransition();
      expect(result).toBe('meeting');
    });

    it('should return "lobby" when lobby text is detected', async () => {
      const { bot, mockPage } = createTeamsBot();
      mockPage.evaluate.mockResolvedValue('lobby');

      const result = await (bot as any).waitForJoinTransition();
      expect(result).toBe('lobby');
    });

    it('should return "prejoin" when page is null', async () => {
      const { bot } = createTeamsBot();
      (bot as any).page = null;

      const result = await (bot as any).waitForJoinTransition();
      expect(result).toBe('prejoin');
    });

    it('should return "prejoin" after timeout when no state is detected', async () => {
      const { bot, mockPage } = createTeamsBot();

      // Always return 'unknown' for transition check and null for error check
      mockPage.evaluate.mockResolvedValue('unknown');
      mockPage.$.mockResolvedValue(createMockElement()); // pre-join button exists

      // Stub out checkForErrorStates so it doesn't consume evaluate calls
      (bot as any).checkForErrorStates = vi.fn().mockResolvedValue(undefined);

      // Mock hasAnySelector to return false (no lobby/meeting indicators after timeout)
      (bot as any).hasAnySelector = vi.fn().mockResolvedValue(false);

      // Speed up the test by reducing the polling delay
      (bot as any).sleep = vi.fn().mockResolvedValue(undefined);

      const result = await (bot as any).waitForJoinTransition();
      expect(result).toBe('prejoin');
    }, 30000);

    it('should detect lobby via evaluate after initial unknown state', async () => {
      const { bot, mockPage } = createTeamsBot();

      // Stub out checkForErrorStates
      (bot as any).checkForErrorStates = vi.fn().mockResolvedValue(undefined);

      // First calls return unknown, then lobby
      let callCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) return Promise.resolve('unknown');
        return Promise.resolve('lobby');
      });
      mockPage.$.mockResolvedValue(createMockElement());
      (bot as any).sleep = vi.fn().mockResolvedValue(undefined);

      const result = await (bot as any).waitForJoinTransition();
      expect(result).toBe('lobby');
    });

    it('should return "meeting" when page navigation exception occurs', async () => {
      const { bot, mockPage } = createTeamsBot();

      // Stub out checkForErrorStates
      (bot as any).checkForErrorStates = vi.fn().mockResolvedValue(undefined);

      // evaluate returns unknown, then $ throws (page navigating)
      mockPage.evaluate.mockResolvedValue('unknown');
      mockPage.$.mockRejectedValue(new Error('Target closed'));
      (bot as any).sleep = vi.fn().mockResolvedValue(undefined);

      const result = await (bot as any).waitForJoinTransition();
      expect(result).toBe('meeting');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Meeting End Detection
  // --------------------------------------------------------------------------
  describe('checkMeetingEnded()', () => {
    function createJoinedBot(pageOpts?: MockPageOptions) {
      const { bot, mockPage } = createTeamsBot(pageOpts);
      (bot as any).joinedSuccessfully = true;
      (bot as any).joinedAt = new Date(Date.now() - 60000); // 60s ago
      (bot as any).lastKnownParticipantCount = 3;
      return { bot, mockPage };
    }

    it('should return false when bot has not joined yet', async () => {
      const { bot } = createTeamsBot();
      (bot as any).joinedSuccessfully = false;

      const result = await bot.checkMeetingEnded();
      expect(result).toBe(false);
    });

    it('should return false during 30s grace period after join', async () => {
      const { bot, mockPage } = createTeamsBot();
      (bot as any).joinedSuccessfully = true;
      (bot as any).joinedAt = new Date(); // just now
      (bot as any).meetingSignal = null;
      (bot as any).lastRosterParticipantCount = null;

      // Even with end phrases, grace period should prevent detection
      mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });

      const result = await bot.checkMeetingEnded();
      expect(result).toBe(false);
    });

    describe('WebSocket signal detection', () => {
      it('should detect meeting_ended signal', async () => {
        const { bot } = createJoinedBot();
        (bot as any).meetingSignal = { type: 'MeetingStatusChange', change: 'meeting_ended' };
        (bot as any).lastRosterParticipantCount = null;

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should detect request_to_join_denied signal', async () => {
        const { bot } = createJoinedBot();
        (bot as any).meetingSignal = { type: 'MeetingStatusChange', change: 'request_to_join_denied' };
        (bot as any).lastRosterParticipantCount = null;

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should detect anonymous_join_disabled signal', async () => {
        const { bot } = createJoinedBot();
        (bot as any).meetingSignal = { type: 'MeetingStatusChange', change: 'anonymous_join_disabled' };
        (bot as any).lastRosterParticipantCount = null;

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should not end meeting for unrelated signal types', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = { type: 'DominantSpeaker', change: undefined };
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });
        // Stub getParticipantCount
        (bot as any).getParticipantCount = vi.fn().mockResolvedValue(3);

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(false);
      });
    });

    describe('Roster-based detection', () => {
      it('should end meeting when roster shows 0 participants', async () => {
        const { bot } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = 0;

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should end meeting when roster drops to 1 after having more', async () => {
        const { bot } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = 1;
        (bot as any).lastKnownParticipantCount = 5;

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should not end meeting when roster count is stable above 1', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = 3;
        (bot as any).lastKnownParticipantCount = 3;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });
        (bot as any).getParticipantCount = vi.fn().mockResolvedValue(3);

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(false);
      });

      it('should update peak participant count from roster', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = 10;
        (bot as any).lastKnownParticipantCount = 3;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });
        (bot as any).getParticipantCount = vi.fn().mockResolvedValue(10);

        await bot.checkMeetingEnded();
        expect((bot as any).lastKnownParticipantCount).toBe(10);
      });
    });

    describe('DOM-based detection', () => {
      it('should detect "The meeting has ended" text', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: true, reason: 'The meeting has ended' });

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should detect "You left the meeting" text', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: true, reason: 'You left the meeting' });

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should detect "Rejoin" text as meeting end', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: true, reason: 'Rejoin' });

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should detect calling-retry-screen-title element', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: true, reason: 'calling-retry-screen-title found' });

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should detect hangup button disappearance after grace period', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        // No end phrases, but hangup button is gone
        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: false });

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should not end if hangup button disappears during grace period', async () => {
        const { bot, mockPage } = createTeamsBot();
        (bot as any).joinedSuccessfully = true;
        (bot as any).joinedAt = new Date(); // just joined
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;
        (bot as any).lastKnownParticipantCount = 0;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: false });

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(false);
      });
    });

    describe('URL-based detection', () => {
      it('should detect navigation away from teams.microsoft.com', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });
        mockPage._setUrl('https://login.microsoftonline.com/error');

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should not end meeting when still on teams.microsoft.com', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });
        mockPage._setUrl('https://teams.microsoft.com/v2/meet/abc123');
        (bot as any).getParticipantCount = vi.fn().mockResolvedValue(3);

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(false);
      });
    });

    describe('Participant count detection', () => {
      it('should end meeting when participant count drops to 0', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });
        mockPage._setUrl('https://teams.microsoft.com/v2/meet/abc');
        (bot as any).getParticipantCount = vi.fn().mockResolvedValue(0);

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should end meeting when only bot remains after others were present', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;
        (bot as any).lastKnownParticipantCount = 4;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });
        mockPage._setUrl('https://teams.microsoft.com/v2/meet/abc');
        (bot as any).getParticipantCount = vi.fn().mockResolvedValue(1);

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(true);
      });

      it('should not end meeting when multiple participants remain', async () => {
        const { bot, mockPage } = createJoinedBot();
        (bot as any).meetingSignal = null;
        (bot as any).lastRosterParticipantCount = null;

        mockPage.evaluate.mockResolvedValue({ ended: false, hasHangup: true });
        mockPage._setUrl('https://teams.microsoft.com/v2/meet/abc');
        (bot as any).getParticipantCount = vi.fn().mockResolvedValue(5);

        const result = await bot.checkMeetingEnded();
        expect(result).toBe(false);
      });
    });

    it('should return true when page is null', async () => {
      const { bot } = createTeamsBot();
      (bot as any).page = null;

      const result = await bot.checkMeetingEnded();
      expect(result).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 5. checkStillInMeeting()
  // --------------------------------------------------------------------------
  describe('checkStillInMeeting()', () => {
    it('should return false when page is null', async () => {
      const { bot } = createTeamsBot();
      (bot as any).page = null;

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(false);
    });

    it('should return false when pre-join button is still visible', async () => {
      const { bot } = createTeamsBot();
      (bot as any).hasAnySelector = vi
        .fn()
        .mockResolvedValueOnce(true) // pre-join button found
        .mockResolvedValue(false);

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(false);
    });

    it('should return true when hangup button is present', async () => {
      const { bot } = createTeamsBot();
      (bot as any).hasAnySelector = vi
        .fn()
        .mockResolvedValueOnce(false) // no pre-join button
        .mockResolvedValueOnce(true); // meeting indicators found

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(true);
    });

    it('should return true when calling-unified-bar is present', async () => {
      const { bot } = createTeamsBot();
      (bot as any).hasAnySelector = vi
        .fn()
        .mockResolvedValueOnce(false) // no pre-join button
        .mockResolvedValueOnce(true); // meeting indicators found

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(true);
    });

    it('should return true based on URL when previously joined', async () => {
      const { bot, mockPage } = createTeamsBot();
      (bot as any).joinedSuccessfully = true;
      (bot as any).hasAnySelector = vi.fn().mockResolvedValue(false); // no selectors found

      // URL indicates Teams meeting
      mockPage._setUrl('https://teams.microsoft.com/v2/#/l/meetup-join/19:meeting@thread.v2/0');

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(true);
    });

    it('should return true for teams.live.com meeting URLs', async () => {
      const { bot, mockPage } = createTeamsBot();
      (bot as any).joinedSuccessfully = true;
      (bot as any).hasAnySelector = vi.fn().mockResolvedValue(false);

      mockPage._setUrl('https://teams.live.com/meet/abc123');

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(true);
    });

    it('should return false when URL is not a Teams meeting URL', async () => {
      const { bot, mockPage } = createTeamsBot();
      (bot as any).joinedSuccessfully = true;
      (bot as any).hasAnySelector = vi.fn().mockResolvedValue(false);

      mockPage._setUrl('https://login.microsoftonline.com/auth');

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(false);
    });

    it('should return false when URL is teams.microsoft.com but not a meeting path', async () => {
      const { bot, mockPage } = createTeamsBot();
      (bot as any).joinedSuccessfully = false;
      (bot as any).hasAnySelector = vi.fn().mockResolvedValue(false);

      mockPage._setUrl('https://teams.microsoft.com/');

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(false);
    });

    it('should require joinedSuccessfully for URL-based detection', async () => {
      const { bot, mockPage } = createTeamsBot();
      (bot as any).joinedSuccessfully = false;
      (bot as any).hasAnySelector = vi.fn().mockResolvedValue(false);

      mockPage._setUrl('https://teams.microsoft.com/v2/#/l/meetup-join/19:meeting@thread.v2/0');

      const result = await bot.checkStillInMeeting();
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 6. getCaptureMode()
  // --------------------------------------------------------------------------
  describe('getCaptureMode()', () => {
    it('should return x11grab for Teams', () => {
      const { bot } = createTeamsBot();
      const mode = (bot as any).getCaptureMode();
      expect(mode).toBe('x11grab');
    });
  });
});
