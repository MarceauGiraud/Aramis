# Aramis - Claude Code Guide

## Project Overview

Aramis is a meeting recording bot that joins video calls (Google Meet, Zoom, Microsoft Teams), records them, and generates transcriptions and summaries.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Monorepo (pnpm)                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  apps/                                                              │
│  ├── web/              # Next.js frontend + API                     │
│  └── bot-worker/       # Playwright bot + FFmpeg recording          │
│                                                                     │
│  packages/                                                          │
│  ├── database/         # Prisma schema + client                     │
│  └── shared/           # Shared types, constants, utils             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Recording System Architecture

The bot uses FFmpeg for real-time video/audio capture with live S3 upload:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     RecordingOrchestrator                           │
│                   (recording-orchestrator.ts)                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  VideoStreamer   │  │  AudioStreamer   │  │  ChunkUploader   │  │
│  │ (video-streamer) │  │ (audio-streamer) │  │ (chunk-uploader) │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                     │             │
│           ▼                     ▼                     ▼             │
│      FFmpeg x11grab        FFmpeg pulse          S3 Multipart      │
│      Xvfb :99              PulseAudio            30s chunks        │
│      VP9 WebM              WAV 16kHz             with retry        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Description |
|------|-------------|
| `apps/bot-worker/src/lib/video-streamer.ts` | FFmpeg x11grab video capture |
| `apps/bot-worker/src/lib/audio-streamer.ts` | FFmpeg PulseAudio audio capture |
| `apps/bot-worker/src/lib/chunk-uploader.ts` | S3 multipart upload with retry |
| `apps/bot-worker/src/lib/recording-orchestrator.ts` | Coordinates all recording components |
| `apps/bot-worker/src/bots/base.ts` | Base bot class with recording integration |
| `apps/bot-worker/src/bots/google-meet.ts` | Google Meet bot implementation |
| `apps/bot-worker/src/index.ts` | BullMQ worker entry point |

## Development Commands

```bash
# Install dependencies
pnpm install

# Start development (all services)
pnpm dev

# Start specific app
pnpm --filter @aramis/web dev
pnpm --filter @aramis/bot-worker dev

# Build all packages
pnpm build

# Build specific package
pnpm --filter @aramis/bot-worker build

# Run tests
pnpm test
pnpm --filter @aramis/bot-worker test

# Lint
pnpm lint

# Type check
pnpm typecheck

# Database commands
pnpm --filter @aramis/database generate  # Generate Prisma client
pnpm --filter @aramis/database push      # Push schema to DB
pnpm --filter @aramis/database studio    # Open Prisma Studio
```

## Docker Commands

```bash
# Start infrastructure (Postgres, Redis, MinIO)
docker-compose up -d postgres redis minio

# Build and start bot-worker
docker-compose up -d --build bot-worker

# View logs
docker-compose logs -f bot-worker

# Stop all
docker-compose down
```

## Environment Variables

### Required for bot-worker:

```bash
# Database
DATABASE_URL="postgresql://aramis:aramis@localhost:5432/aramis"

# Redis
REDIS_URL="redis://localhost:6379"

# S3/MinIO
S3_ENDPOINT="http://localhost:9000"
S3_ACCESS_KEY="minioadmin"
S3_SECRET_KEY="minioadmin"
S3_BUCKET="recordings"
S3_REGION="us-east-1"

# Recording (auto-configured in Docker)
DISPLAY=":99"
PULSE_SOURCE="virtual_speaker.monitor"

# Transcription
DEEPGRAM_API_KEY="your-key"
```

## Testing the Recording System

### Unit Tests

```bash
cd apps/bot-worker
npx tsx src/__tests__/video-streamer.test.ts
npx tsx src/lib/audio-streamer.test.ts
```

### Integration Test (requires Docker)

```bash
# Start infrastructure
docker-compose up -d postgres redis minio

# Create test meeting in DB
pnpm --filter @aramis/database studio

# Queue a test job
# Use the web UI or directly add to Redis queue
```

## Common Tasks

### Adding a New Bot Platform

1. Create `apps/bot-worker/src/bots/<platform>.ts`
2. Extend `BaseMeetingBot` class
3. Implement abstract methods: `join()`, `leave()`, `checkMeetingEnded()`, `checkStillInMeeting()`
4. Register in `apps/bot-worker/src/bots/factory.ts`

### Modifying Recording Behavior

- Video settings: `video-streamer.ts` (resolution, codec, framerate)
- Audio settings: `audio-streamer.ts` (sample rate, channels)
- Upload intervals: `chunk-uploader.ts` (uploadIntervalMs)
- Orchestration: `recording-orchestrator.ts`

### Debugging Recording Issues

1. Check FFmpeg is available: `ffmpeg -version`
2. Check Xvfb display: `echo $DISPLAY`
3. Check PulseAudio: `pactl list sinks`
4. Check S3 connection: `curl $S3_ENDPOINT/minio/health/live`

## Code Style

- TypeScript strict mode
- ESLint + Prettier
- No emojis in code/comments unless requested
- Prefer simple, focused changes
- Avoid over-engineering

## Project Structure Details

```
apps/bot-worker/
├── src/
│   ├── bots/
│   │   ├── base.ts              # Base class with recording
│   │   ├── google-meet.ts       # Google Meet implementation
│   │   └── factory.ts           # Bot factory
│   ├── lib/
│   │   ├── video-streamer.ts    # FFmpeg video capture
│   │   ├── audio-streamer.ts    # FFmpeg audio capture
│   │   ├── chunk-uploader.ts    # S3 multipart upload
│   │   ├── recording-orchestrator.ts  # Recording coordinator
│   │   ├── storage.ts           # S3 upload utilities
│   │   ├── s3-config.ts         # S3 client config
│   │   └── logger.ts            # Winston logger
│   ├── __tests__/               # Test files
│   └── index.ts                 # Worker entry point
├── Dockerfile
└── package.json

packages/database/
├── prisma/
│   └── schema.prisma            # Database schema
└── src/
    └── index.ts                 # Prisma client export

packages/shared/
└── src/
    ├── types/                   # Shared TypeScript types
    └── constants/               # Queue names, job types
```

## Current Branch

Working branch: `claude/meeting-recorder-setup-FKpfH`

## Recent Changes

1. **Live Streaming Recording** - Replaced Playwright recordVideo with FFmpeg
2. **RecordingOrchestrator** - Coordinates video, audio, and S3 upload
3. **Separate Audio Track** - 16kHz WAV for better transcription
4. **Crash Resilience** - Chunks uploaded as recorded, not at end
5. **Docker Config** - Xvfb + PulseAudio virtual devices
