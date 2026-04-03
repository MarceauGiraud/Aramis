import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { getS3Client } from './s3-config';

const BUCKET = process.env.S3_BUCKET || 'recordings';
const ALLOWED_UPLOAD_DIR = '/tmp/recordings';

/**
 * Validate that the path is within the allowed directory
 * Prevents path traversal attacks
 */
function validatePath(localPath: string): void {
  const resolvedPath = path.resolve(localPath);
  const resolvedAllowed = path.resolve(ALLOWED_UPLOAD_DIR);

  if (!resolvedPath.startsWith(resolvedAllowed)) {
    throw new Error(`Invalid path: ${localPath}. Path must be within ${ALLOWED_UPLOAD_DIR}`);
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${localPath}`);
  }
}

/**
 * Upload a recording to S3 using streams for memory efficiency
 */
export async function uploadRecording(localPath: string, meetingId: string): Promise<string> {
  // Validate path to prevent path traversal
  validatePath(localPath);

  const filename = path.basename(localPath);
  const key = `recordings/${meetingId}/${filename}`;

  logger.info(`Uploading recording to S3: ${key}`);

  // Use streaming upload for large files
  const fileStream = fs.createReadStream(localPath);
  const fileStats = fs.statSync(localPath);

  const upload = new Upload({
    client: getS3Client(),
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: 'video/webm',
      ContentLength: fileStats.size,
    },
    // Upload in 10MB chunks
    partSize: 10 * 1024 * 1024,
    // 4 concurrent uploads
    queueSize: 4,
  });

  upload.on('httpUploadProgress', (progress) => {
    if (progress.loaded && progress.total) {
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      logger.debug(`Upload progress: ${percentage}%`);
    }
  });

  await upload.done();

  // Return the S3 URL
  return `s3://${BUCKET}/${key}`;
}

export async function getPresignedUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });

  return getSignedUrl(getS3Client(), command, { expiresIn: 3600 });
}

/**
 * Upload audio to S3 using streams for memory efficiency
 */
export async function uploadAudio(localPath: string, meetingId: string): Promise<string> {
  // Validate path to prevent path traversal
  validatePath(localPath);

  const filename = path.basename(localPath);
  const key = `recordings/${meetingId}/audio/${filename}`;

  logger.info(`Uploading audio to S3: ${key}`);

  // Use streaming upload for large files
  const fileStream = fs.createReadStream(localPath);
  const fileStats = fs.statSync(localPath);

  const upload = new Upload({
    client: getS3Client(),
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: 'audio/wav',
      ContentLength: fileStats.size,
    },
    partSize: 10 * 1024 * 1024,
    queueSize: 4,
  });

  await upload.done();

  return `s3://${BUCKET}/${key}`;
}
