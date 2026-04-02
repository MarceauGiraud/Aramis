# Migration Plan: Aramis → Kasar

## Overview

Transfer the meeting recording feature from the standalone Aramis platform into the Kasar CRM app. The bot-worker stays as a separate Docker service. The API routes, UI, and shared code move into Kasar.

**Supabase project**: Keep the dedicated Supabase project for meeting recording (separate from Kasar's main DB).

---

## Architecture Target

```
┌─────────────────────────────────────────────────────────────────┐
│                          Kasar CRM                              │
│                    (Next.js 15 + Supabase)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  New routes:                                                    │
│  ├── /api/meeting-recorder/bots          (CRUD + deploy)        │
│  ├── /api/meeting-recorder/meetings      (list, detail, chat)   │
│  ├── /api/meeting-recorder/calendars     (OAuth, sync)          │
│  ├── /api/meeting-recorder/webhooks      (manage)               │
│  └── /api/meeting-recorder/health        (status)               │
│                                                                 │
│  New pages:                                                     │
│  ├── /meetings                           (list)                 │
│  ├── /meetings/[id]                      (detail + player)      │
│  └── /settings/meeting-recorder          (config)               │
│                                                                 │
│  New libs:                                                      │
│  ├── lib/meeting-recorder/queue.ts       (BullMQ)               │
│  ├── lib/meeting-recorder/s3.ts          (S3 presigned URLs)    │
│  ├── lib/meeting-recorder/types.ts       (shared types)         │
│  └── lib/meeting-recorder/constants.ts   (queue names, config)  │
│                                                                 │
└──────────────┬──────────────────────────────────────────────────┘
               │
               │  Redis (BullMQ jobs + pub/sub commands)
               │  Supabase (dedicated project for recordings DB)
               │
┌──────────────▼──────────────────────────────────────────────────┐
│               Bot Worker (Docker, unchanged)                     │
│         DigitalOcean Droplet: 159.89.111.251                    │
│                                                                 │
│  - Playwright + Chrome (H.264)                                  │
│  - FFmpeg x11grab + PulseAudio                                  │
│  - Deepgram live transcription                                  │
│  - Claude AI summaries                                          │
│  - S3 upload (Supabase Storage)                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Environment Variables to Add to Kasar

> **Note on env var naming:** The bot-worker uses unprefixed names (`S3_ENDPOINT`, `DATABASE_URL`). In Kasar, prefix with `MEETING_RECORDER_` to avoid conflicts with Kasar's own vars. The bot-worker `.env.prod` keeps unprefixed names.

### Kasar Web App Environment Variables

```bash
# === Meeting Recorder ===

# Dedicated Supabase project for meeting recordings
MEETING_RECORDER_DATABASE_URL="postgresql://postgres.zlkjxzdrnokhzwohtuwc:PASSWORD@aws-1-eu-west-1.pooler.supabase.com:5432/postgres"
MEETING_RECORDER_DIRECT_URL="postgresql://postgres:PASSWORD@db.zlkjxzdrnokhzwohtuwc.supabase.co:5432/postgres"

# S3 Storage (Supabase Storage S3-compatible)
MEETING_RECORDER_S3_ENDPOINT="https://zlkjxzdrnokhzwohtuwc.storage.supabase.co/storage/v1/s3"
MEETING_RECORDER_S3_ACCESS_KEY="your-access-key"
MEETING_RECORDER_S3_SECRET_KEY="your-secret-key"
MEETING_RECORDER_S3_BUCKET="recordings"
MEETING_RECORDER_S3_REGION="eu-west-1"

# Redis (shared with kasar-workers, same instance)
# REDIS_URL already exists in Kasar

# BullMQ prefix (use same as Kasar: dev or prod)
BULLMQ_PREFIX="dev"  # or "prod" in production

# Bot Worker URL (for screenshots proxy)
BOT_WORKER_URL="http://159.89.111.251:8765"

# Bot Configuration
MEETING_BOT_NAME="Kasar CRM"

# Transcription
DEEPGRAM_API_KEY="your-deepgram-key"

# AI Summaries
ANTHROPIC_API_KEY="your-anthropic-key"

# Token encryption (for calendar OAuth tokens)
MEETING_RECORDER_ENCRYPTION_KEY="32-byte-hex-key"
```

### Bot Worker Environment Variables (Docker)

These go in the bot-worker's `.env.prod` file (unprefixed names):

```bash
# Core
DATABASE_URL="postgresql://..."
REDIS_URL="redis://..."
S3_ENDPOINT="https://..."
S3_ACCESS_KEY="..."
S3_SECRET_KEY="..."
S3_BUCKET="recordings"
S3_REGION="eu-west-1"

# Bot behavior
BOT_HEADLESS=false              # Run Chrome headless (default: false)
BOT_DEBUG=false                 # Enable debug logging (default: false)
BOT_CONCURRENCY=2               # Max concurrent bots (default: 2)
DISPLAY=":99"                   # Managed by DisplayAllocator
PULSE_SOURCE="virtual_speaker.monitor"  # Managed per-bot

# Logging
LOG_LEVEL="info"                # info, debug, warn, error (default: info)

# Worker concurrency
SUMMARY_CONCURRENCY=1           # Summary generation workers (default: 1)
TRANSCRIPTION_CONCURRENCY=2     # Transcription workers (default: 2)
WEBHOOK_CONCURRENCY=5           # Webhook delivery workers (default: 5)

# WebSocket
WS_PORT=8765                    # WebSocket server port (default: 8765)

# Transcription providers
DEEPGRAM_API_KEY="..."          # Required: primary transcription
ASSEMBLYAI_API_KEY="..."        # Optional: alternative transcription provider
OPENAI_API_KEY="..."            # Optional: Whisper transcription

# Other
GOOGLE_TTS_API_KEY="..."        # Optional: text-to-speech
ANTHROPIC_API_KEY="..."         # Required: Claude AI summaries
```

---

## API Routes to Port

All routes are prefixed with `/api/meeting-recorder/` in Kasar to avoid conflicts.

### Bot Management

| Aramis Route | Kasar Route | Method | Description |
|-------------|-------------|--------|-------------|
| `/api/bots` | `/api/meeting-recorder/bots` | GET | List bots with filters (status, platform, date) |
| `/api/bots` | `/api/meeting-recorder/bots` | POST | Deploy bot to meeting. Body: `{ meeting_url, bot_name?, recording_mode?, transcription?, webhooks?, metadata? }` |
| `/api/bots/:id` | `/api/meeting-recorder/bots/:id` | GET | Get bot status + recording + session |
| `/api/bots/:id` | `/api/meeting-recorder/bots/:id` | PATCH | Update bot config |
| `/api/bots/:id` | `/api/meeting-recorder/bots/:id` | DELETE | Stop + cancel bot |
| `/api/bots/:id/leave` | `/api/meeting-recorder/bots/:id/leave` | POST | Force kill bot + cancel meeting |
| `/api/bots/:id/pause` | `/api/meeting-recorder/bots/:id/pause` | POST | Pause recording |
| `/api/bots/:id/resume` | `/api/meeting-recorder/bots/:id/resume` | POST | Resume recording |
| `/api/bots/:id/transcript` | `/api/meeting-recorder/bots/:id/transcript` | GET | Get transcript segments |
| `/api/bots/:id/participants` | `/api/meeting-recorder/bots/:id/participants` | GET | List participants |
| `/api/bots/:id/chat` | `/api/meeting-recorder/bots/:id/chat` | GET | Get chat messages |
| `/api/bots/:id/events` | `/api/meeting-recorder/bots/:id/events` | GET | Get bot logs |
| `/api/bots/:id/screenshots` | `/api/meeting-recorder/bots/:id/screenshots` | GET | Proxy screenshots from bot-worker |
| `/api/bots/:id/send-chat-message` | `/api/meeting-recorder/bots/:id/send-chat-message` | POST | Send message in meeting |
| `/api/bots/:id/output-audio` | `/api/meeting-recorder/bots/:id/output-audio` | POST | Play audio in meeting |
| `/api/bots/:id/data` | `/api/meeting-recorder/bots/:id/data` | DELETE | GDPR data deletion |

### Meeting Management

| Aramis Route | Kasar Route | Method | Description |
|-------------|-------------|--------|-------------|
| `/api/meetings` | `/api/meeting-recorder/meetings` | GET | List meetings (upcoming/past/all) |
| `/api/meetings` | `/api/meeting-recorder/meetings` | POST | Create meeting + queue bot job |
| `/api/meetings/:id` | `/api/meeting-recorder/meetings/:id` | GET | Full meeting detail (recording URLs, transcript, summary, participants) |
| `/api/meetings/:id` | `/api/meeting-recorder/meetings/:id` | PATCH | Update/pause/resume |
| `/api/meetings/:id` | `/api/meeting-recorder/meetings/:id` | DELETE | Delete meeting cascade |
| `/api/meetings/:id/chat` | `/api/meeting-recorder/meetings/:id/chat` | GET | Chat messages |

### Calendar Integration

| Aramis Route | Kasar Route | Method | Description |
|-------------|-------------|--------|-------------|
| `/api/calendars` | `/api/meeting-recorder/calendars` | GET | List calendar connections |
| `/api/calendars` | `/api/meeting-recorder/calendars` | POST | Start OAuth (Google/Microsoft) |
| `/api/calendars/:id` | `/api/meeting-recorder/calendars/:id` | GET | Connection details |
| `/api/calendars/:id` | `/api/meeting-recorder/calendars/:id` | DELETE | Disconnect |
| `/api/calendars/:id/sync` | `/api/meeting-recorder/calendars/:id/sync` | POST | Trigger sync |

### Webhooks

| Aramis Route | Kasar Route | Method | Description |
|-------------|-------------|--------|-------------|
| `/api/webhooks` | `/api/meeting-recorder/webhooks` | GET/POST | List/create webhooks |
| `/api/webhooks/:id` | `/api/meeting-recorder/webhooks/:id` | GET/PATCH/DELETE | Manage webhook |

### Health

| Aramis Route | Kasar Route | Method | Description |
|-------------|-------------|--------|-------------|
| `/api/health` | `/api/meeting-recorder/health` | GET | DB + Redis + S3 health check |

---

## Database Schema

**Keep the dedicated Supabase project.** The Prisma schema stays as-is in the bot-worker. For Kasar's web routes, use a second Prisma client pointing to the meeting recorder DB.

### Key models (already exist in Supabase):

- `Meeting` — title, URL, platform, status, timestamps
- `Recording` — video/audio URLs, duration, format
- `Transcript` — full text, language, confidence, segments
- `TranscriptSegment` — text, start/end time, speaker
- `TranscriptSpeaker` — label, identified name, duration
- `MeetingSummary` — overview, key points, decisions, action items
- `Participant` — name, email, host status
- `BotSession` — worker ID, status, heartbeat
- `BotLog` — level, message, metadata
- `ChatMessage` — sender, message, timestamp
- `CalendarConnection` — provider, tokens (encrypted)
- `Calendar` — name, auto-record settings
- `CalendarEvent` — title, times, meeting URL
- `Webhook` — URL, events, secret
- `WebhookDelivery` — payload, status, retries

> **Note:** The schema also includes `User`, `Account`, `Session`, `Organization`, `Project`, `ApiKey`, `Share`, `RecordingChunk`, `TranscriptWord`, `SummaryTemplate`, `RecordingRule`, `CreditBalance`, `CreditTransaction`, `StripeCustomer`, `Job`, `Invitation`, `MeetingWebhook`, `VerificationToken` models. These handle auth, multi-tenancy, billing, and sharing — they should be reconciled with Kasar's existing models during migration.

### Auth integration:
Replace `getCurrentUserId()` (returns `'demo-user'`) with Kasar's Supabase auth:
```typescript
// Aramis (current)
export function getCurrentUserId() { return 'demo-user'; }

// Kasar (target)
import { createClient } from '@/lib/supabase/server';
export async function getCurrentUserId() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id;
}
```

---

## Shared Code to Port

### Types (`packages/shared/src/types.ts` → `lib/meeting-recorder/types.ts`)
- `MeetingPlatform`, `MeetingStatus`, `RecordingFormat`, `RecordingView`
- `RecordingConfig`, `TranscriptionConfig`, `WebhookConfig`
- `JoinMeetingJob`, `TranscribeJob`, `GenerateSummaryJob`
- `BotEvent`, `BotEventType`, `BotErrorType`, `BotCommand`
- Request/Response types

### Constants (`packages/shared/src/constants.ts` → `lib/meeting-recorder/constants.ts`)
- `QUEUE_NAMES` — meeting-bot, transcription, summary, calendar-sync, webhook-delivery
- `BOT_CONFIG` — timeouts, intervals
- `MEETING_URL_PATTERNS` — regex for Zoom/Teams/Meet
- `BOT_COMMANDS_CHANNEL`, `BOT_COMMAND_TYPES`
- `WEBHOOK_EVENT_TYPES`

### Utils (`packages/shared/src/utils.ts` → `lib/meeting-recorder/utils.ts`)
- `detectPlatform(url)`, `isValidMeetingUrl(url)`
- `extractMeetingId(url)`, `extractMeetingUrl(text)`
- `formatDuration()`, `formatFileSize()`

### Queue (`apps/web/src/lib/queue.ts` → `lib/meeting-recorder/queue.ts`)
- `getMeetingBotQueue()`, `getTranscriptionQueue()`
- `addMeetingBotJob(data)`, `addTranscriptionJob(data)`

### S3 (`apps/web/src/lib/s3.ts` → `lib/meeting-recorder/s3.ts`)
- `getPresignedUrl()`, `deleteS3Prefix()`, `checkS3Health()`

### Crypto (`packages/shared/src/crypto.ts` → `lib/meeting-recorder/crypto.ts`)
- `encrypt()`, `decrypt()` — for calendar OAuth tokens
- `encryptTokens()`, `decryptTokens()`

---

## UI Pages to Port

| Aramis Page | Kasar Page | Description |
|-------------|-----------|-------------|
| `/dashboard` | `/meetings` | Meeting list + create form + stats |
| `/dashboard/meetings` | `/meetings` | Combined into one page |
| `/dashboard/meetings/[id]` | `/meetings/[id]` | Meeting detail (transcript, summary, video, participants, chat, bot logs) |
| `/dashboard/settings` | `/settings/meeting-recorder` | Meeting recorder config |

### UI Components to extract:
- Video/audio player with presigned URLs
- Transcript viewer with speaker colors and search
- Summary display (key points, decisions, action items)
- Participant list
- Bot activity log + screenshot viewer
- Meeting status badge
- Kill/Rejoin buttons

---

## Dependencies to Add to Kasar

```json
{
  "@aws-sdk/client-s3": "^3.490.0",
  "@aws-sdk/s3-request-presigner": "^3.490.0",
  "bullmq": "^5.1.0",
  "ioredis": "^5.3.2",
  "googleapis": "latest",
  "@microsoft/microsoft-graph-client": "latest",
  "ws": "^8.19.0"
}
```

Note: `ioredis` and `bullmq` may already be in Kasar if kasar-workers uses them. `ws` is needed for the WebSocket audio streaming endpoint.

---

## Communication Pattern

```
Kasar Web App                     Bot Worker (Docker)
     │                                  │
     │  1. POST /api/meeting-recorder/bots
     │     → creates Meeting + BotSession in DB
     │     → adds job to Redis BullMQ queue
     │                                  │
     │                                  │  2. Worker picks up job
     │                                  │     → joins meeting
     │                                  │     → records video/audio
     │                                  │     → transcribes live
     │                                  │     → updates DB directly
     │                                  │
     │  3. Frontend polls GET /api/meeting-recorder/meetings/:id
     │     → reads updated DB
     │     → shows live transcript, recording status
     │                                  │
     │  4. POST /api/meeting-recorder/bots/:id/pause
     │     → publishes Redis command
     │                                  │  → bot receives, pauses
     │                                  │
     │                                  │  5. Meeting ends
     │                                  │     → generates summary
     │                                  │     → uploads to S3
     │                                  │     → updates DB
     │                                  │
     │  6. GET /api/meeting-recorder/meetings/:id
     │     → returns recording URLs, transcript, summary
     │
```

> **Note:** The bot-worker also exposes a WebSocket server on port 8765 for real-time audio streaming to external clients. This is optional and used for live audio features.

---

## Migration Steps (Recommended Order)

### Phase 1: Prisma Client Setup
1. Add a second Prisma client in Kasar pointing to the meeting recorder Supabase project
2. Copy the schema models (or generate client from existing DB)

### Phase 2: Shared Code
3. Create `lib/meeting-recorder/` directory in Kasar
4. Port types, constants, utils, queue, s3, crypto

### Phase 3: API Routes
5. Port all `/api/bots/*` routes → `/api/meeting-recorder/bots/*`
6. Port all `/api/meetings/*` routes → `/api/meeting-recorder/meetings/*`
7. Port calendar and webhook routes
8. Replace `getCurrentUserId()` with Supabase auth
9. Replace `@aramis/database` imports with the second Prisma client
10. Replace `@aramis/shared` imports with `lib/meeting-recorder/*`

### Phase 4: UI
11. Create `/meetings` page (list + create)
12. Create `/meetings/[id]` page (detail + player + transcript)
13. Add meeting recorder section to settings
14. Integrate with Kasar's layout, navigation, and design system

### Phase 5: Bot Worker Update
15. Update bot-worker's shared package imports if needed
16. Ensure BULLMQ_PREFIX matches between Kasar and bot-worker
17. Test end-to-end flow

### Phase 6: Cleanup
18. Remove Aramis web app (no longer needed)
19. Keep bot-worker Docker deployment
20. Update documentation

---

## Bot Worker Deployment (Unchanged)

The bot-worker stays on the DigitalOcean droplet:

```
Server: 159.89.111.251
Config: docker-compose.prod.yml
Env:    .env.prod
Redis:  redis://:PASSWORD@104.131.111.109:6379
```

To update:
```bash
ssh root@159.89.111.251
cd ~/aramis
git pull origin dev
docker compose -f docker-compose.prod.yml up -d --build
```

---

## Key Gotchas

1. **Two Prisma clients**: Kasar uses its own Supabase, meeting recorder uses a separate one. Use `@prisma/client` with different output paths.

2. **Auth replacement**: Every API route uses `getCurrentUserId()` → replace with Kasar's auth middleware.

3. **Redis is shared**: Same Redis instance for kasar-workers and meeting recorder. Use `BULLMQ_PREFIX` to namespace.

4. **S3 is Supabase Storage**: Presigned URLs use the Supabase S3 endpoint. The bot-worker uploads directly; Kasar generates presigned download URLs.

5. **Calendar OAuth**: Tokens are encrypted with `MEETING_RECORDER_ENCRYPTION_KEY`. The Google/Microsoft OAuth redirect URLs will need to change to Kasar's domain.

6. **The bot-worker writes directly to the meeting recorder DB**: It doesn't go through the API. Both Kasar web and bot-worker connect to the same Supabase project.

7. **Two Prisma clients with separate output paths**: Kasar needs a second Prisma client with a different output path. Use `@prisma/client` for Kasar's DB and a custom generated client (e.g., `@prisma/meeting-recorder`) for the recording DB.

8. **Redis pub/sub needs a SEPARATE IORedis connection**: BullMQ uses one connection, but pub/sub commands need another. The bot-worker already does this (`redisSub` in `index.ts`).

9. **Calendar sync is a BullMQ repeatable job (every 5 min)**, not a cron. It runs inside the bot-worker, not the web app.

10. **Stale bot cleanup runs every 5 min** inside the bot-worker (`cleanupStaleBots`). No action needed from Kasar.

11. **`bot:events` channel is defined in constants but not actively used.** Can be ignored.
