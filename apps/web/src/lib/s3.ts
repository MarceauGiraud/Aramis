import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || '',
    secretAccessKey: process.env.S3_SECRET_KEY || '',
  },
  forcePathStyle: true,
});

const BUCKET = process.env.S3_BUCKET || 'recordings';

/**
 * Convert an s3:// URL to a presigned HTTP URL for browser access.
 * Returns the original URL if it's not an s3:// URL.
 */
export async function resolveS3Url(url: string): Promise<string> {
  if (!url.startsWith('s3://')) {
    return url;
  }

  const withoutProtocol = url.slice(5); // remove "s3://"
  const slashIndex = withoutProtocol.indexOf('/');
  const bucket = withoutProtocol.slice(0, slashIndex);
  const key = withoutProtocol.slice(slashIndex + 1);

  const command = new GetObjectCommand({
    Bucket: bucket || BUCKET,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}
