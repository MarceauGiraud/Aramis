import {
  S3Client,
  HeadBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

function getS3Client(): S3Client | null {
  if (
    !process.env.S3_ENDPOINT ||
    !process.env.S3_ACCESS_KEY ||
    !process.env.S3_SECRET_KEY
  ) {
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
      })
    );

    if (list.Contents) {
      for (const obj of list.Contents) {
        if (obj.Key) {
          await client.send(
            new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key })
          );
          deleted++;
        }
      }
    }

    continuationToken = list.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

/**
 * Delete a single S3 object by key.
 */
export async function deleteS3Object(key: string): Promise<void> {
  const client = getS3Client();
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
