import { prisma } from '@aramis/database';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { DEFAULT_CHUNK_RETENTION_DAYS } from '@aramis/shared';
import { logger } from '../lib/logger';

/**
 * Find RecordingChunks older than the retention period,
 * delete from S3 and database.
 */
export async function clearOldChunks(retentionDays: number = DEFAULT_CHUNK_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const oldChunks = await prisma.recordingChunk.findMany({
    where: {
      createdAt: { lt: cutoff },
    },
    select: {
      id: true,
      s3Key: true,
    },
  });

  if (oldChunks.length === 0) {
    logger.info('No old chunks found');
    return 0;
  }

  logger.info(`Found ${oldChunks.length} chunk(s) older than ${retentionDays} days`);

  // Set up S3 client
  const s3Client = process.env.S3_ENDPOINT
    ? new S3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY || '',
          secretAccessKey: process.env.S3_SECRET_KEY || '',
        },
        forcePathStyle: true,
      })
    : null;

  const bucket = process.env.S3_BUCKET || 'recordings';
  let deleted = 0;

  for (const chunk of oldChunks) {
    try {
      // Delete from S3
      if (s3Client && chunk.s3Key) {
        try {
          await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: chunk.s3Key }));
        } catch (s3Error) {
          logger.warn(
            `Failed to delete S3 object ${chunk.s3Key}: ${s3Error instanceof Error ? s3Error.message : s3Error}`,
          );
        }
      }

      // Delete from database
      await prisma.recordingChunk.delete({
        where: { id: chunk.id },
      });

      deleted++;
    } catch (error) {
      logger.error(`Failed to delete chunk ${chunk.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  logger.info(`Deleted ${deleted} old chunk(s)`);
  return deleted;
}

// CLI entry point
if (require.main === module) {
  const days = parseInt(process.argv[2] || String(DEFAULT_CHUNK_RETENTION_DAYS), 10);
  clearOldChunks(days)
    .then((count) => {
      console.log(`Deleted ${count} old chunk(s)`);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error:', error);
      process.exit(1);
    });
}
