import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || '',
    secretAccessKey: process.env.S3_SECRET_KEY || '',
  },
  forcePathStyle: true, // Required for MinIO
});

const BUCKET = process.env.S3_BUCKET || 'recordings';

export async function uploadRecording(
  localPath: string,
  meetingId: string
): Promise<string> {
  const filename = path.basename(localPath);
  const key = `recordings/${meetingId}/${filename}`;

  logger.info(`Uploading recording to S3: ${key}`);

  const fileContent = fs.readFileSync(localPath);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileContent,
      ContentType: 'video/webm',
    })
  );

  // Return the S3 URL
  return `s3://${BUCKET}/${key}`;
}

export async function getPresignedUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

export async function uploadAudio(
  localPath: string,
  meetingId: string
): Promise<string> {
  const filename = path.basename(localPath);
  const key = `recordings/${meetingId}/audio/${filename}`;

  logger.info(`Uploading audio to S3: ${key}`);

  const fileContent = fs.readFileSync(localPath);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileContent,
      ContentType: 'audio/wav',
    })
  );

  return `s3://${BUCKET}/${key}`;
}
