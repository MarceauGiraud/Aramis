import { describe, it, expect } from 'vitest';
import {
  detectMeetingPlatform,
  extractMeetingUrl,
  parseMeetingId,
  isValidMeetingUrl,
  MeetingPlatform,
} from '@aramis/shared';

describe('Meeting URL Detector', () => {
  describe('detectMeetingPlatform', () => {
    it('should detect Zoom URLs', () => {
      const zoomUrls = [
        'https://zoom.us/j/123456789',
        'https://zoom.us/j/123456789?pwd=abc123',
        'https://us02web.zoom.us/j/123456789',
        'https://company.zoom.us/j/123456789',
        'https://zoom.us/my/username',
        'https://zoom.us/s/123456789',
      ];

      for (const url of zoomUrls) {
        expect(detectMeetingPlatform(url)).toBe('ZOOM');
      }
    });

    it('should detect Microsoft Teams URLs', () => {
      const teamsUrls = [
        'https://teams.microsoft.com/l/meetup-join/123456',
        'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc',
        'https://teams.live.com/meet/123456',
      ];

      for (const url of teamsUrls) {
        expect(detectMeetingPlatform(url)).toBe('TEAMS');
      }
    });

    it('should detect Google Meet URLs', () => {
      const meetUrls = [
        'https://meet.google.com/abc-defg-hij',
        'https://meet.google.com/abc-defg-hij?authuser=0',
        'http://meet.google.com/xyz-uvwx-rst',
      ];

      for (const url of meetUrls) {
        expect(detectMeetingPlatform(url)).toBe('GOOGLE_MEET');
      }
    });

    it('should return null for non-meeting URLs', () => {
      const nonMeetingUrls = [
        'https://google.com',
        'https://microsoft.com',
        'https://zoom.com', // Not a meeting URL
        'https://example.com/meeting',
        '',
        'not-a-url',
      ];

      for (const url of nonMeetingUrls) {
        expect(detectMeetingPlatform(url)).toBeNull();
      }
    });
  });

  describe('extractMeetingUrl', () => {
    it('should extract Zoom URL from text', () => {
      const texts = [
        'Join the meeting at https://zoom.us/j/123456789',
        'Meeting link: https://zoom.us/j/123456789?pwd=abc',
        'Click here to join https://us02web.zoom.us/j/123456789 today',
      ];

      for (const text of texts) {
        const result = extractMeetingUrl(text);
        expect(result).toBeDefined();
        expect(result?.platform).toBe('ZOOM');
      }
    });

    it('should extract Teams URL from text', () => {
      const text = 'Please join the Teams meeting: https://teams.microsoft.com/l/meetup-join/123456';
      const result = extractMeetingUrl(text);

      expect(result).toBeDefined();
      expect(result?.platform).toBe('TEAMS');
    });

    it('should extract Google Meet URL from text', () => {
      const text = 'Join us at https://meet.google.com/abc-defg-hij for the standup';
      const result = extractMeetingUrl(text);

      expect(result).toBeDefined();
      expect(result?.platform).toBe('GOOGLE_MEET');
    });

    it('should return first meeting URL when multiple present', () => {
      const text = `
        Zoom: https://zoom.us/j/111111111
        Teams: https://teams.microsoft.com/l/meetup-join/222222
        Meet: https://meet.google.com/aaa-bbbb-ccc
      `;

      const result = extractMeetingUrl(text);
      expect(result).toBeDefined();
      // Should return the first one found
      expect(result?.platform).toBe('ZOOM');
    });

    it('should return null when no meeting URL found', () => {
      const texts = [
        'No meeting link here',
        'Check out https://google.com for more info',
        '',
      ];

      for (const text of texts) {
        expect(extractMeetingUrl(text)).toBeNull();
      }
    });
  });

  describe('parseMeetingId', () => {
    it('should parse Zoom meeting ID', () => {
      expect(parseMeetingId('https://zoom.us/j/123456789', 'ZOOM')).toBe('123456789');
      expect(parseMeetingId('https://zoom.us/j/123456789?pwd=abc', 'ZOOM')).toBe('123456789');
      expect(parseMeetingId('https://us02web.zoom.us/j/98765', 'ZOOM')).toBe('98765');
    });

    it('should parse Google Meet meeting code', () => {
      expect(parseMeetingId('https://meet.google.com/abc-defg-hij', 'GOOGLE_MEET')).toBe('abc-defg-hij');
      expect(parseMeetingId('https://meet.google.com/xyz-uvwx-rst?authuser=0', 'GOOGLE_MEET')).toBe('xyz-uvwx-rst');
    });

    it('should return full path for Teams (complex format)', () => {
      const teamsUrl = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc';
      const result = parseMeetingId(teamsUrl, 'TEAMS');
      expect(result).toBeDefined();
      expect(result).toContain('19');
    });
  });

  describe('isValidMeetingUrl', () => {
    it('should validate correct meeting URLs', () => {
      expect(isValidMeetingUrl('https://zoom.us/j/123456789')).toBe(true);
      expect(isValidMeetingUrl('https://teams.microsoft.com/l/meetup-join/123')).toBe(true);
      expect(isValidMeetingUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(isValidMeetingUrl('not-a-url')).toBe(false);
      expect(isValidMeetingUrl('')).toBe(false);
      expect(isValidMeetingUrl('https://google.com')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isValidMeetingUrl('https://zoom.us/j/')).toBe(false); // No meeting ID
      expect(isValidMeetingUrl('https://meet.google.com/')).toBe(false); // No code
    });
  });
});
