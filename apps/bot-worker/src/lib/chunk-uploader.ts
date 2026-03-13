import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  CompletedPart,
} from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { validateS3Config, isS3Configured } from './s3-config';

/**
 * Configuration options for ChunkUploader
 */
export interface ChunkUploaderOptions {
  /** Interval in milliseconds between upload attempts (default: 30000 = 30 seconds) */
  uploadIntervalMs?: number;
  /** Minimum chunk size in bytes before uploading (default: 5MB - S3 minimum) */
  minChunkSize?: number;
  /** Maximum retry attempts for failed uploads (default: 3) */
  maxRetries?: number;
  /** Delay between retries in milliseconds (default: 1000) */
  retryDelayMs?: number;
  /** Content type for the uploaded file (default: 'video/webm') */
  contentType?: string;
}

/**
 * State of an uploaded part for tracking and resuming
 */
interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/**
 * Upload state for persistence and resume capability
 */
export interface UploadState {
  uploadId: string;
  bucket: string;
  key: string;
  uploadedParts: UploadedPart[];
  totalUploadedBytes: number;
  lastUploadedPosition: number;
  startTime: number;
}

const DEFAULT_OPTIONS: Required<ChunkUploaderOptions> = {
  uploadIntervalMs: 30000, // 30 seconds
  minChunkSize: 5 * 1024 * 1024, // 5MB - S3 minimum for multipart
  maxRetries: 3,
  retryDelayMs: 1000,
  contentType: 'video/webm',
};

// Allowed upload directory to prevent path traversal
const ALLOWED_UPLOAD_DIR = '/tmp/recordings';

/**
 * ChunkUploader - Live chunk upload to S3 for recording files
 *
 * This class watches a recording file and uploads new data as it's written,
 * using S3 multipart upload for reliability. It supports:
 * - Configurable upload intervals (default 30 seconds)
 * - Automatic retry on network failures
 * - Resume capability after crashes
 * - Progress tracking
 */
export class ChunkUploader {
  private s3Client: S3Client;
  private bucket: string;
  private options: Required<ChunkUploaderOptions>;

  // Current upload state
  private filePath: string | null = null;
  private s3Key: string | null = null;
  private uploadId: string | null = null;
  private uploadedParts: UploadedPart[] = [];
  private lastUploadedPosition: number = 0;
  private totalUploadedBytes: number = 0;
  private startTime: number = 0;

  // Upload control
  private uploadTimer: NodeJS.Timeout | null = null;
  private isUploading: boolean = false;
  private isStopped: boolean = false;
  private pendingBuffer: Buffer | null = null;

  constructor(options: ChunkUploaderOptions = {}) {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured. Please set S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, and S3_BUCKET environment variables.');
    }

    const config = validateS3Config();

    this.s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true, // Required for MinIO
    });

    this.bucket = config.bucket;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Validate that the path is within the allowed directory
   */
  private validatePath(localPath: string): void {
    const resolvedPath = path.resolve(localPath);
    const resolvedAllowed = path.resolve(ALLOWED_UPLOAD_DIR);

    if (!resolvedPath.startsWith(resolvedAllowed)) {
      throw new Error(`Invalid path: ${localPath}. Path must be within ${ALLOWED_UPLOAD_DIR}`);
    }
  }

  /**
   * Start uploading a file in chunks
   * @param filePath Path to the recording file to upload
   * @param meetingId Meeting ID for organizing in S3
   * @param existingState Optional state to resume from a previous upload
   */
  async start(
    filePath: string,
    meetingId: string,
    existingState?: UploadState
  ): Promise<void> {
    this.validatePath(filePath);

    this.filePath = filePath;
    this.s3Key = `recordings/${meetingId}/${path.basename(filePath)}`;
    this.isStopped = false;
    this.startTime = Date.now();

    if (existingState) {
      // Resume from existing state
      await this.resumeUpload(existingState);
    } else {
      // Start a new multipart upload
      await this.initializeUpload();
    }

    // Start the periodic upload timer
    this.startUploadTimer();

    logger.info('ChunkUploader started', {
      filePath: this.filePath,
      s3Key: this.s3Key,
      uploadId: this.uploadId,
      uploadIntervalMs: this.options.uploadIntervalMs,
    });
  }

  /**
   * Initialize a new multipart upload
   */
  private async initializeUpload(): Promise<void> {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: this.s3Key!,
      ContentType: this.options.contentType,
    });

    const response = await this.s3Client.send(command);
    this.uploadId = response.UploadId!;
    this.uploadedParts = [];
    this.lastUploadedPosition = 0;
    this.totalUploadedBytes = 0;

    logger.info('Multipart upload initialized', {
      uploadId: this.uploadId,
      key: this.s3Key,
    });
  }

  /**
   * Resume from a previous upload state
   */
  private async resumeUpload(state: UploadState): Promise<void> {
    this.uploadId = state.uploadId;
    this.uploadedParts = [...state.uploadedParts];
    this.lastUploadedPosition = state.lastUploadedPosition;
    this.totalUploadedBytes = state.totalUploadedBytes;
    this.startTime = state.startTime;

    // Verify the upload still exists on S3 by listing parts
    try {
      const command = new ListPartsCommand({
        Bucket: this.bucket,
        Key: this.s3Key!,
        UploadId: this.uploadId,
      });

      const response = await this.s3Client.send(command);
      const remoteParts = response.Parts || [];

      // Verify our tracked parts match what's on S3
      const remotePartNumbers = new Set(remoteParts.map(p => p.PartNumber));
      const validParts = this.uploadedParts.filter(p =>
        remotePartNumbers.has(p.partNumber)
      );

      if (validParts.length !== this.uploadedParts.length) {
        logger.warn('Some parts were not found on S3, adjusting state', {
          expected: this.uploadedParts.length,
          found: validParts.length,
        });
        this.uploadedParts = validParts;
        // Recalculate position based on valid parts
        this.lastUploadedPosition = validParts.reduce((sum, p) => sum + p.size, 0);
        this.totalUploadedBytes = this.lastUploadedPosition;
      }

      logger.info('Resumed multipart upload', {
        uploadId: this.uploadId,
        key: this.s3Key,
        partsCount: this.uploadedParts.length,
        position: this.lastUploadedPosition,
      });
    } catch (error) {
      // Upload doesn't exist anymore, start fresh
      logger.warn('Could not resume upload, starting fresh', { error });
      await this.initializeUpload();
    }
  }

  /**
   * Start the periodic upload timer
   */
  private startUploadTimer(): void {
    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
    }

    this.uploadTimer = setInterval(async () => {
      if (!this.isStopped && !this.isUploading) {
        await this.uploadPendingData();
      }
    }, this.options.uploadIntervalMs);
  }

  /**
   * Upload any new data that has been written to the file
   */
  private async uploadPendingData(): Promise<void> {
    if (!this.filePath || !this.uploadId || this.isUploading) {
      return;
    }

    this.isUploading = true;

    try {
      // Check if file exists
      if (!fs.existsSync(this.filePath)) {
        logger.debug('File does not exist yet, waiting...', { filePath: this.filePath });
        return;
      }

      const stats = fs.statSync(this.filePath);
      const currentSize = stats.size;
      const newDataSize = currentSize - this.lastUploadedPosition;

      // Only upload if we have enough new data (or if we're stopping)
      if (newDataSize < this.options.minChunkSize && !this.isStopped) {
        logger.debug('Not enough new data to upload', {
          newDataSize,
          minChunkSize: this.options.minChunkSize,
        });
        return;
      }

      if (newDataSize <= 0) {
        return;
      }

      // Read the new data
      const fd = fs.openSync(this.filePath, 'r');
      const buffer = Buffer.alloc(newDataSize);
      fs.readSync(fd, buffer, 0, newDataSize, this.lastUploadedPosition);
      fs.closeSync(fd);

      // Upload the chunk with retries
      await this.uploadChunkWithRetry(buffer);

    } catch (error) {
      logger.error('Error uploading pending data', {
        error: error instanceof Error ? error.message : String(error),
        filePath: this.filePath,
      });
    } finally {
      this.isUploading = false;
    }
  }

  /**
   * Upload a chunk with retry logic
   */
  private async uploadChunkWithRetry(data: Buffer): Promise<void> {
    const partNumber = this.uploadedParts.length + 1;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        const command = new UploadPartCommand({
          Bucket: this.bucket,
          Key: this.s3Key!,
          UploadId: this.uploadId!,
          PartNumber: partNumber,
          Body: data,
        });

        const response = await this.s3Client.send(command);

        // Track the uploaded part
        this.uploadedParts.push({
          partNumber,
          etag: response.ETag!,
          size: data.length,
        });
        this.lastUploadedPosition += data.length;
        this.totalUploadedBytes += data.length;

        logger.info('Chunk uploaded successfully', {
          partNumber,
          size: data.length,
          totalUploaded: this.totalUploadedBytes,
          attempt,
        });

        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`Chunk upload failed, attempt ${attempt}/${this.options.maxRetries}`, {
          partNumber,
          error: lastError.message,
        });

        if (attempt < this.options.maxRetries) {
          // Exponential backoff
          const delay = this.options.retryDelayMs * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    // All retries failed
    throw new Error(`Failed to upload chunk after ${this.options.maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Stop uploading and complete the multipart upload
   * @returns The S3 URL of the completed upload
   */
  async stop(): Promise<string> {
    this.isStopped = true;

    // Stop the timer
    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
      this.uploadTimer = null;
    }

    // Upload any remaining data (even if below minimum chunk size)
    // For the final part, S3 allows any size
    if (this.filePath && fs.existsSync(this.filePath)) {
      const stats = fs.statSync(this.filePath);
      const remainingSize = stats.size - this.lastUploadedPosition;

      if (remainingSize > 0) {
        const fd = fs.openSync(this.filePath, 'r');
        const buffer = Buffer.alloc(remainingSize);
        fs.readSync(fd, buffer, 0, remainingSize, this.lastUploadedPosition);
        fs.closeSync(fd);

        try {
          await this.uploadChunkWithRetry(buffer);
        } catch (error) {
          logger.error('Failed to upload final chunk', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Complete the multipart upload
    if (this.uploadId && this.uploadedParts.length > 0) {
      await this.completeUpload();
    } else if (this.uploadId) {
      // No parts uploaded, abort the upload
      await this.abortUpload();
      throw new Error('No data was uploaded');
    }

    const s3Url = this.getS3Url();

    logger.info('ChunkUploader stopped', {
      s3Url,
      totalUploadedBytes: this.totalUploadedBytes,
      partsCount: this.uploadedParts.length,
      durationMs: Date.now() - this.startTime,
    });

    return s3Url;
  }

  /**
   * Complete the multipart upload
   */
  private async completeUpload(): Promise<void> {
    // Sort parts by part number (required by S3)
    const sortedParts: CompletedPart[] = this.uploadedParts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(p => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
      }));

    const command = new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: this.s3Key!,
      UploadId: this.uploadId!,
      MultipartUpload: {
        Parts: sortedParts,
      },
    });

    await this.s3Client.send(command);

    logger.info('Multipart upload completed', {
      key: this.s3Key,
      partsCount: sortedParts.length,
    });
  }

  /**
   * Abort the multipart upload (cleanup incomplete uploads)
   */
  async abortUpload(): Promise<void> {
    if (!this.uploadId) {
      return;
    }

    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.s3Key!,
        UploadId: this.uploadId,
      });

      await this.s3Client.send(command);

      logger.info('Multipart upload aborted', {
        key: this.s3Key,
        uploadId: this.uploadId,
      });
    } catch (error) {
      logger.error('Failed to abort multipart upload', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get the total number of bytes uploaded so far
   */
  getUploadedSize(): number {
    return this.totalUploadedBytes;
  }

  /**
   * Get the S3 URL for the uploaded file
   */
  getS3Url(): string {
    if (!this.s3Key) {
      throw new Error('Upload not started');
    }
    return `s3://${this.bucket}/${this.s3Key}`;
  }

  /**
   * Get the current upload state for persistence/resuming
   */
  getUploadState(): UploadState | null {
    if (!this.uploadId || !this.s3Key) {
      return null;
    }

    return {
      uploadId: this.uploadId,
      bucket: this.bucket,
      key: this.s3Key,
      uploadedParts: [...this.uploadedParts],
      totalUploadedBytes: this.totalUploadedBytes,
      lastUploadedPosition: this.lastUploadedPosition,
      startTime: this.startTime,
    };
  }

  /**
   * Force an immediate upload of pending data
   * Useful when you want to ensure data is uploaded before a potential crash
   */
  async flush(): Promise<void> {
    if (!this.isUploading) {
      await this.uploadPendingData();
    }
  }

  /**
   * Check if the uploader is currently active
   */
  isActive(): boolean {
    return !this.isStopped && this.uploadId !== null;
  }

  /**
   * Get upload progress information
   */
  getProgress(): {
    uploadedBytes: number;
    partsCount: number;
    elapsedMs: number;
    bytesPerSecond: number;
  } {
    const elapsedMs = Date.now() - this.startTime;
    const bytesPerSecond = elapsedMs > 0 ? (this.totalUploadedBytes / elapsedMs) * 1000 : 0;

    return {
      uploadedBytes: this.totalUploadedBytes,
      partsCount: this.uploadedParts.length,
      elapsedMs,
      bytesPerSecond,
    };
  }

  /**
   * Helper to sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create a ChunkUploader instance with default options
 */
export function createChunkUploader(options?: ChunkUploaderOptions): ChunkUploader {
  return new ChunkUploader(options);
}
