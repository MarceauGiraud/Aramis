import { describe, it, expect } from 'vitest';

/**
 * Test the s3:// URL to S3 object key conversion logic used in deepgram.ts.
 *
 * Format: s3://<bucket>/<key>
 * The resolver strips the "s3://" prefix and the bucket name to extract the object key.
 */
function extractS3ObjectKey(s3Url: string): string | null {
  if (!s3Url.startsWith('s3://')) return null;
  const key = s3Url.slice(5); // remove "s3://"
  const slashIndex = key.indexOf('/');
  if (slashIndex === -1) return null; // no key part, just bucket
  return key.slice(slashIndex + 1);
}

/**
 * Build an s3:// URL from bucket and key (as done in storage.ts and chunk-uploader.ts).
 */
function buildS3Url(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

describe('S3 URL Resolution', () => {
  it('extracts object key from standard s3:// URL', () => {
    const url = 's3://recordings/recordings/meeting-123/video.webm';
    expect(extractS3ObjectKey(url)).toBe('recordings/meeting-123/video.webm');
  });

  it('extracts key with nested path', () => {
    const url = 's3://my-bucket/a/b/c/file.wav';
    expect(extractS3ObjectKey(url)).toBe('a/b/c/file.wav');
  });

  it('returns null for non-s3 URLs', () => {
    expect(extractS3ObjectKey('https://example.com/file.webm')).toBeNull();
    expect(extractS3ObjectKey('/local/path/file.webm')).toBeNull();
    expect(extractS3ObjectKey('')).toBeNull();
  });

  it('returns null for s3:// URL with bucket only (no key)', () => {
    expect(extractS3ObjectKey('s3://my-bucket')).toBeNull();
  });

  it('handles bucket with trailing slash but empty key', () => {
    // s3://bucket/ -> key would be empty string
    const result = extractS3ObjectKey('s3://bucket/');
    expect(result).toBe('');
  });

  it('round-trips build and extract', () => {
    const bucket = 'recordings';
    const key = 'recordings/meeting-abc/audio/track.wav';
    const url = buildS3Url(bucket, key);
    expect(url).toBe('s3://recordings/recordings/meeting-abc/audio/track.wav');
    expect(extractS3ObjectKey(url)).toBe(key);
  });

  it('handles special characters in key', () => {
    const url = 's3://bucket/path/file with spaces.webm';
    expect(extractS3ObjectKey(url)).toBe('path/file with spaces.webm');
  });
});
