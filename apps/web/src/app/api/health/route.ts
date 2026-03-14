import { NextResponse } from 'next/server';
import { prisma } from '@aramis/database';
import IORedis from 'ioredis';
import { checkS3Health } from '@/lib/s3';

interface ServiceStatus {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

// GET /api/health - health check for all services
export async function GET() {
  const services: Record<string, ServiceStatus> = {};

  // Check database
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    services.db = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (error) {
    services.db = {
      status: 'error',
      latencyMs: Date.now() - dbStart,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis
  const redisStart = Date.now();
  try {
    const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      connectTimeout: 3000,
      lazyConnect: true,
    });
    await redis.connect();
    await redis.ping();
    services.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
    await redis.quit();
  } catch (error) {
    services.redis = {
      status: 'error',
      latencyMs: Date.now() - redisStart,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check S3
  const s3Start = Date.now();
  try {
    const s3Ok = await checkS3Health();
    services.s3 = s3Ok
      ? { status: 'ok', latencyMs: Date.now() - s3Start }
      : { status: 'error', latencyMs: Date.now() - s3Start, error: 'S3 not configured or unreachable' };
  } catch (error) {
    services.s3 = {
      status: 'error',
      latencyMs: Date.now() - s3Start,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Determine overall status
  const allOk = Object.values(services).every((s) => s.status === 'ok');
  const anyError = Object.values(services).some((s) => s.status === 'error');

  let overallStatus: 'ok' | 'degraded' | 'error';
  if (allOk) {
    overallStatus = 'ok';
  } else if (services.db.status === 'error') {
    overallStatus = 'error';
  } else {
    overallStatus = 'degraded';
  }

  const statusCode = overallStatus === 'error' ? 503 : 200;

  return NextResponse.json(
    {
      status: overallStatus,
      services,
      timestamp: new Date().toISOString(),
    },
    { status: statusCode }
  );
}
