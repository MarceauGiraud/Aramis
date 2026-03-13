# /debug

Debug common issues in the Aramis project.

## Usage

- `/debug recording` - Debug recording issues
- `/debug s3` - Debug S3/MinIO connection
- `/debug bot` - Debug bot worker issues
- `/debug db` - Debug database connection

## Instructions

### recording

1. Check FFmpeg processes:
```bash
ps aux | grep ffmpeg
```

2. Check recent recordings:
```bash
ls -la /tmp/recordings/
```

3. Check orchestrator logs in bot-worker output

4. Verify Xvfb and PulseAudio are running

### s3

1. Test S3 connection:
```bash
curl -v ${S3_ENDPOINT}/minio/health/live
```

2. Check S3 credentials in environment:
```bash
echo "S3_ENDPOINT=$S3_ENDPOINT"
echo "S3_BUCKET=$S3_BUCKET"
echo "S3_ACCESS_KEY=${S3_ACCESS_KEY:0:4}..."
```

3. List buckets (if mc is available):
```bash
mc ls local/ 2>/dev/null || echo "MinIO client not configured"
```

### bot

1. Check BullMQ worker status:
```bash
docker-compose logs --tail=50 bot-worker
```

2. Check Redis queue:
```bash
redis-cli LLEN bull:meeting-bot:wait
redis-cli LLEN bull:meeting-bot:active
```

3. Check for errors in recent jobs

### db

1. Test database connection:
```bash
pnpm --filter @aramis/database studio
```

2. Check DATABASE_URL is set correctly

3. Verify Prisma client is generated:
```bash
ls packages/database/node_modules/.prisma/client/
```

## Report findings to user with:
- Issue identified
- Root cause
- Suggested fix
