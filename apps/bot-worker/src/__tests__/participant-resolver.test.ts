import { describe, it, expect } from 'vitest';

/**
 * Test participant name resolution and filtering logic.
 *
 * The bot extracts participant names from the meeting DOM. Names need to be
 * deduplicated and filtered to exclude bot names. This tests the pure logic
 * extracted from the relevant code paths.
 */

const DEFAULT_BOT_KEYWORDS = [
  'bot',
  'recorder',
  'notetaker',
  'note taker',
  'meeting assistant',
  'aramis',
  'otter',
  'fireflies',
  'grain',
  'fathom',
];

/**
 * Check if a participant name looks like a bot (case-insensitive substring match).
 */
function isLikelyBot(name: string, botKeywords: string[] = DEFAULT_BOT_KEYWORDS): boolean {
  const lower = name.toLowerCase();
  return botKeywords.some((kw) => lower.includes(kw));
}

/**
 * Deduplicate participant names (case-insensitive).
 * Returns unique names preserving the first occurrence's casing.
 */
function deduplicateNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(name.trim());
    }
  }
  return result;
}

/**
 * Extract clean participant list: deduplicate, filter bots, trim whitespace.
 */
function resolveParticipants(rawNames: string[], botKeywords?: string[]): string[] {
  const unique = deduplicateNames(rawNames);
  return unique.filter((name) => !isLikelyBot(name, botKeywords));
}

describe('Participant Name Resolution', () => {
  describe('isLikelyBot', () => {
    it('detects common bot names', () => {
      expect(isLikelyBot('Aramis Recorder')).toBe(true);
      expect(isLikelyBot("Otter.ai's Notetaker")).toBe(true);
      expect(isLikelyBot('Fireflies.ai Meeting Bot')).toBe(true);
      expect(isLikelyBot('Fathom Notetaker')).toBe(true);
      expect(isLikelyBot('Grain Recorder')).toBe(true);
    });

    it('does not flag real names', () => {
      expect(isLikelyBot('Alice Martin')).toBe(false);
      expect(isLikelyBot('Bob Smith')).toBe(false);
      expect(isLikelyBot('Jean-Pierre Dupont')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(isLikelyBot('ARAMIS RECORDER')).toBe(true);
      expect(isLikelyBot('aramis recorder')).toBe(true);
    });

    it('supports custom keywords', () => {
      expect(isLikelyBot('MyCustomBot', ['mycustombot'])).toBe(true);
      expect(isLikelyBot('Aramis Recorder', ['mycustombot'])).toBe(false);
    });
  });

  describe('deduplicateNames', () => {
    it('removes duplicates (case-insensitive)', () => {
      expect(deduplicateNames(['Alice', 'alice', 'ALICE'])).toEqual(['Alice']);
    });

    it('preserves first occurrence casing', () => {
      expect(deduplicateNames(['bob Smith', 'Bob Smith'])).toEqual(['bob Smith']);
    });

    it('trims whitespace', () => {
      expect(deduplicateNames(['  Alice  ', 'Alice'])).toEqual(['Alice']);
    });

    it('filters empty strings', () => {
      expect(deduplicateNames(['', '  ', 'Alice'])).toEqual(['Alice']);
    });

    it('handles empty input', () => {
      expect(deduplicateNames([])).toEqual([]);
    });
  });

  describe('resolveParticipants', () => {
    it('filters bots and deduplicates', () => {
      const raw = ['Alice Martin', 'Aramis Recorder', 'Bob Smith', 'alice martin', 'Fireflies.ai Meeting Bot'];
      const result = resolveParticipants(raw);
      expect(result).toEqual(['Alice Martin', 'Bob Smith']);
    });

    it('returns empty array for all-bot meeting', () => {
      const raw = ['Aramis Recorder', 'Otter.ai Notetaker'];
      expect(resolveParticipants(raw)).toEqual([]);
    });

    it('returns all names when no bots present', () => {
      const raw = ['Alice', 'Bob', 'Charlie'];
      expect(resolveParticipants(raw)).toEqual(['Alice', 'Bob', 'Charlie']);
    });
  });
});
