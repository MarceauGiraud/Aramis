import {
  S3Client,
  HeadBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function getS3Client(): S3Client | null {
  if (!process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
    return null;
  }
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
}

const BUCKET = process.env.S3_BUCKET || 'recordings';

/**
 * Check if S3 is reachable by performing a HEAD bucket request.
 */
export async function checkS3Health(): Promise<boolean> {
  const client = getS3Client();
  if (!client) return false;
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete all S3 objects under a given prefix (e.g., recordings/{meetingId}/).
 */
export async function deleteS3Prefix(prefix: string): Promise<number> {
  const client = getS3Client();
  if (!client) return 0;

  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    if (list.Contents) {
      for (const obj of list.Contents) {
        if (obj.Key) {
          await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
          deleted++;
        }
      }
    }

    continuationToken = list.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

/**
 * Convert an s3:// URL to an S3 object key.
 * e.g., "s3://recordings/recordings/abc/file.webm" → "recordings/abc/file.webm"
 */
export function s3UrlToKey(s3Url: string): string | null {
  if (!s3Url.startsWith('s3://')) return null;
  // Format: s3://bucket/key
  const withoutProtocol = s3Url.slice(5);
  const slashIndex = withoutProtocol.indexOf('/');
  if (slashIndex === -1) return null;
  return withoutProtocol.slice(slashIndex + 1);
}

/**
 * Generate a presigned HTTP URL for an S3 object.
 * Accepts either an s3:// URL or a raw S3 key.
 * Returns null if S3 is not configured.
 */
export async function getPresignedUrl(s3UrlOrKey: string, expiresIn = 3600): Promise<string | null> {
  const client = getS3Client();
  if (!client) return null;

  const key = s3UrlOrKey.startsWith('s3://') ? s3UrlToKey(s3UrlOrKey) : s3UrlOrKey;
  if (!key) return null;

  return getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

/**
 * Delete a single S3 object by key.
 */
export async function deleteS3Object(key: string): Promise<void> {
  const client = getS3Client();
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
