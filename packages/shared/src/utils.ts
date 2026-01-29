import { MeetingPlatform, MEETING_URL_PATTERNS } from './constants';

// Re-export for convenience
export { MeetingPlatform };

/**
 * Detect the meeting platform from a URL
 */
export function detectPlatform(url: string): MeetingPlatform | null {
  if (!url || typeof url !== 'string') return null;

  if (MEETING_URL_PATTERNS.ZOOM.test(url)) {
    return 'ZOOM';
  }
  if (MEETING_URL_PATTERNS.TEAMS.test(url)) {
    return 'TEAMS';
  }
  if (MEETING_URL_PATTERNS.GOOGLE_MEET.test(url)) {
    return 'GOOGLE_MEET';
  }
  return null;
}

// Alias for compatibility with tests
export const detectMeetingPlatform = detectPlatform;

/**
 * Validate a meeting URL
 */
export function isValidMeetingUrl(url: string): boolean {
  return detectPlatform(url) !== null;
}

/**
 * Format duration in seconds to human readable string
 */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Format file size in bytes to human readable string
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Extract meeting ID from URL
 */
export function extractMeetingId(url: string): string | null {
  const platform = detectPlatform(url);

  if (!platform) return null;

  try {
    const urlObj = new URL(url);

    switch (platform) {
      case 'ZOOM': {
        // Extract from /j/123456789 or /my/username or /s/123456789
        const pathMatch = urlObj.pathname.match(/\/(j|my|s)\/([^?/]+)/);
        return pathMatch?.[2] || null;
      }
      case 'TEAMS': {
        // Teams URLs have meeting ID in path
        return urlObj.pathname.split('/').pop() || null;
      }
      case 'GOOGLE_MEET': {
        // Extract from /abc-defg-hij
        const pathMatch = urlObj.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
        return pathMatch?.[1] || null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Alias for compatibility with tests
export function parseMeetingId(url: string, platform: MeetingPlatform): string | null {
  return extractMeetingId(url);
}

/**
 * Extract meeting URL from text (description, location, etc.)
 */
export function extractMeetingUrl(text: string): { url: string; platform: MeetingPlatform } | null {
  if (!text || typeof text !== 'string') return null;

  // URL regex pattern
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  const matches = text.match(urlPattern);

  if (!matches) return null;

  // Check each URL for meeting platform
  for (const url of matches) {
    const platform = detectPlatform(url);
    if (platform) {
      return { url, platform };
    }
  }

  return null;
}

/**
 * Generate a random string for IDs
 */
export function generateId(length: number = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt === maxAttempts) break;

      await sleep(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}
