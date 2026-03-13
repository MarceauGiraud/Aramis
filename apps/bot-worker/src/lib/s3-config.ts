/**
 * S3 Configuration validation
 */

export interface S3Config {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/**
 * Check if S3 is configured (non-throwing)
 */
export function isS3Configured(): boolean {
  return !!(
    process.env.S3_ENDPOINT &&
    process.env.S3_ACCESS_KEY &&
    process.env.S3_SECRET_KEY &&
    process.env.S3_BUCKET
  );
}

/**
 * Validate S3 configuration (throws if invalid)
 */
export function validateS3Config(): S3Config {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION || 'us-east-1';

  if (!endpoint) {
    throw new Error('S3_ENDPOINT is required');
  }
  if (!accessKey) {
    throw new Error('S3_ACCESS_KEY is required');
  }
  if (!secretKey) {
    throw new Error('S3_SECRET_KEY is required');
  }
  if (!bucket) {
    throw new Error('S3_BUCKET is required');
  }

  return { endpoint, region, accessKey, secretKey, bucket };
}
