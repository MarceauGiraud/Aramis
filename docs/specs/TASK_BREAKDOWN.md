# Aramis Meeting Recorder - Task Breakdown

## Overview

This document breaks down the implementation into discrete tasks with corresponding test scripts.

---

## Task Categories

| Category | Tasks | Priority |
|----------|-------|----------|
| [1. Database & Models](#1-database--models) | 5 | P0 |
| [2. Calendar Integration](#2-calendar-integration) | 8 | P0 |
| [3. Meeting Management](#3-meeting-management) | 6 | P0 |
| [4. Bot Worker Core](#4-bot-worker-core) | 7 | P0 |
| [5. Recording & Chunks](#5-recording--chunks) | 6 | P1 |
| [6. Transcription](#6-transcription) | 5 | P1 |
| [7. AI Summary](#7-ai-summary) | 6 | P1 |
| [8. Custom Templates](#8-custom-templates) | 5 | P2 |
| [9. Sharing & Export](#9-sharing--export) | 4 | P2 |
| [10. Dashboard UI](#10-dashboard-ui) | 8 | P1 |

---

## 1. Database & Models

### Task 1.1: Update Prisma Schema
**File:** `packages/database/prisma/schema.prisma`
**Description:** Implement the complete database schema from specification
**Test:** `tests/database/schema.test.ts`

### Task 1.2: Create Database Migrations
**Command:** `pnpm db:migrate`
**Description:** Generate and apply migrations
**Test:** `tests/database/migrations.test.ts`

### Task 1.3: Implement Database Client Exports
**File:** `packages/database/src/index.ts`
**Description:** Export Prisma client and types
**Test:** `tests/database/client.test.ts`

### Task 1.4: Create Seed Data
**File:** `packages/database/prisma/seed.ts`
**Description:** Seed script for development data
**Test:** `tests/database/seed.test.ts`

### Task 1.5: Database Utilities
**File:** `packages/database/src/utils.ts`
**Description:** Helper functions for common queries
**Test:** `tests/database/utils.test.ts`

---

## 2. Calendar Integration

### Task 2.1: Google OAuth Setup
**Files:**
- `apps/web/src/lib/auth/google.ts`
- `apps/web/src/app/api/calendars/connect/google/route.ts`
- `apps/web/src/app/api/calendars/callback/google/route.ts`
**Test:** `tests/calendar/google-oauth.test.ts`

### Task 2.2: Microsoft OAuth Setup
**Files:**
- `apps/web/src/lib/auth/microsoft.ts`
- `apps/web/src/app/api/calendars/connect/microsoft/route.ts`
- `apps/web/src/app/api/calendars/callback/microsoft/route.ts`
**Test:** `tests/calendar/microsoft-oauth.test.ts`

### Task 2.3: Token Encryption Service
**File:** `packages/shared/src/crypto.ts`
**Description:** Encrypt/decrypt OAuth tokens
**Test:** `tests/calendar/token-encryption.test.ts`

### Task 2.4: Google Calendar Sync Service
**File:** `apps/web/src/lib/services/google-calendar.ts`
**Description:** Fetch and sync Google Calendar events
**Test:** `tests/calendar/google-sync.test.ts`

### Task 2.5: Microsoft Calendar Sync Service
**File:** `apps/web/src/lib/services/microsoft-calendar.ts`
**Description:** Fetch and sync Microsoft Calendar events
**Test:** `tests/calendar/microsoft-sync.test.ts`

### Task 2.6: Calendar API Routes
**Files:**
- `apps/web/src/app/api/calendars/route.ts`
- `apps/web/src/app/api/calendars/[id]/route.ts`
- `apps/web/src/app/api/calendars/sync/route.ts`
**Test:** `tests/calendar/api-routes.test.ts`

### Task 2.7: Meeting URL Detection
**File:** `packages/shared/src/meeting-detector.ts`
**Description:** Detect platform from meeting URLs
**Test:** `tests/calendar/meeting-detector.test.ts`

### Task 2.8: Calendar Webhook Handlers
**Files:**
- `apps/web/src/app/api/webhooks/google/route.ts`
- `apps/web/src/app/api/webhooks/microsoft/route.ts`
**Test:** `tests/calendar/webhooks.test.ts`

---

## 3. Meeting Management

### Task 3.1: Meeting Service
**File:** `apps/web/src/lib/services/meeting.ts`
**Description:** Core meeting CRUD operations
**Test:** `tests/meetings/service.test.ts`

### Task 3.2: Meeting API Routes
**Files:**
- `apps/web/src/app/api/meetings/route.ts`
- `apps/web/src/app/api/meetings/[id]/route.ts`
- `apps/web/src/app/api/meetings/[id]/start/route.ts`
- `apps/web/src/app/api/meetings/[id]/stop/route.ts`
**Test:** `tests/meetings/api-routes.test.ts`

### Task 3.3: Recording Rules Engine
**File:** `apps/web/src/lib/services/recording-rules.ts`
**Description:** Apply rules to determine if meeting should be recorded
**Test:** `tests/meetings/rules-engine.test.ts`

### Task 3.4: Meeting Scheduler
**File:** `apps/web/src/lib/services/scheduler.ts`
**Description:** Schedule bots for upcoming meetings
**Test:** `tests/meetings/scheduler.test.ts`

### Task 3.5: Recording Rules API
**Files:**
- `apps/web/src/app/api/rules/route.ts`
- `apps/web/src/app/api/rules/[id]/route.ts`
**Test:** `tests/meetings/rules-api.test.ts`

### Task 3.6: Meeting Status Updates (WebSocket)
**File:** `apps/web/src/lib/websocket/meeting-status.ts`
**Description:** Real-time status updates via WebSocket
**Test:** `tests/meetings/websocket.test.ts`

---

## 4. Bot Worker Core

### Task 4.1: Job Queue Setup
**File:** `apps/bot-worker/src/queues/job-queue.ts`
**Description:** BullMQ queue configuration
**Test:** `tests/bot-worker/queue.test.ts`

### Task 4.2: Base Bot Class Enhancement
**File:** `apps/bot-worker/src/bots/base.ts`
**Description:** Enhanced base class with chunk support
**Test:** `tests/bot-worker/base-bot.test.ts`

### Task 4.3: Zoom Bot Implementation
**File:** `apps/bot-worker/src/bots/zoom.ts`
**Test:** `tests/bot-worker/zoom-bot.test.ts`

### Task 4.4: Teams Bot Implementation
**File:** `apps/bot-worker/src/bots/teams.ts`
**Test:** `tests/bot-worker/teams-bot.test.ts`

### Task 4.5: Google Meet Bot Implementation
**File:** `apps/bot-worker/src/bots/google-meet.ts`
**Test:** `tests/bot-worker/google-meet-bot.test.ts`

### Task 4.6: Audio Capture Service
**File:** `apps/bot-worker/src/lib/audio-capture.ts`
**Description:** Capture audio for transcription
**Test:** `tests/bot-worker/audio-capture.test.ts`

### Task 4.7: Worker Process Manager
**File:** `apps/bot-worker/src/index.ts`
**Description:** Main worker entry with graceful shutdown
**Test:** `tests/bot-worker/worker.test.ts`

---

## 5. Recording & Chunks

### Task 5.1: Chunk Manager
**File:** `apps/bot-worker/src/lib/chunk-manager.ts`
**Description:** Manage video chunk creation and upload
**Test:** `tests/recording/chunk-manager.test.ts`

### Task 5.2: S3 Storage Service
**File:** `apps/bot-worker/src/lib/storage.ts`
**Description:** Upload/download from S3
**Test:** `tests/recording/storage.test.ts`

### Task 5.3: Chunk Merger Service
**File:** `apps/bot-worker/src/lib/chunk-merger.ts`
**Description:** Merge chunks into final video
**Test:** `tests/recording/chunk-merger.test.ts`

### Task 5.4: HLS Generator
**File:** `apps/bot-worker/src/lib/hls-generator.ts`
**Description:** Generate HLS streams for playback
**Test:** `tests/recording/hls-generator.test.ts`

### Task 5.5: Recording API Routes
**Files:**
- `apps/web/src/app/api/recordings/[meetingId]/route.ts`
- `apps/web/src/app/api/recordings/[meetingId]/stream/route.ts`
- `apps/web/src/app/api/recordings/[meetingId]/download/route.ts`
**Test:** `tests/recording/api-routes.test.ts`

### Task 5.6: Thumbnail Generator
**File:** `apps/bot-worker/src/lib/thumbnail.ts`
**Description:** Generate video thumbnails
**Test:** `tests/recording/thumbnail.test.ts`

---

## 6. Transcription

### Task 6.1: Transcription Service Interface
**File:** `apps/bot-worker/src/lib/transcription/types.ts`
**Description:** Common interface for transcription providers
**Test:** `tests/transcription/interface.test.ts`

### Task 6.2: Deepgram Provider
**File:** `apps/bot-worker/src/lib/transcription/deepgram.ts`
**Test:** `tests/transcription/deepgram.test.ts`

### Task 6.3: Whisper Provider
**File:** `apps/bot-worker/src/lib/transcription/whisper.ts`
**Test:** `tests/transcription/whisper.test.ts`

### Task 6.4: Speaker Diarization
**File:** `apps/bot-worker/src/lib/transcription/diarization.ts`
**Test:** `tests/transcription/diarization.test.ts`

### Task 6.5: Transcript API Routes
**Files:**
- `apps/web/src/app/api/transcripts/[meetingId]/route.ts`
- `apps/web/src/app/api/transcripts/[meetingId]/search/route.ts`
- `apps/web/src/app/api/transcripts/[meetingId]/export/route.ts`
**Test:** `tests/transcription/api-routes.test.ts`

---

## 7. AI Summary

### Task 7.1: LLM Provider Interface
**File:** `apps/bot-worker/src/lib/summary/types.ts`
**Description:** Common interface for LLM providers
**Test:** `tests/summary/interface.test.ts`

### Task 7.2: OpenAI Provider
**File:** `apps/bot-worker/src/lib/summary/openai.ts`
**Test:** `tests/summary/openai.test.ts`

### Task 7.3: Anthropic Provider
**File:** `apps/bot-worker/src/lib/summary/anthropic.ts`
**Test:** `tests/summary/anthropic.test.ts`

### Task 7.4: Default Summary Generator
**File:** `apps/bot-worker/src/lib/summary/generator.ts`
**Description:** Generate structured summaries with default template
**Test:** `tests/summary/generator.test.ts`

### Task 7.5: Summary API Routes
**Files:**
- `apps/web/src/app/api/summaries/[meetingId]/route.ts`
- `apps/web/src/app/api/summaries/[meetingId]/regenerate/route.ts`
**Test:** `tests/summary/api-routes.test.ts`

### Task 7.6: Action Item Extractor
**File:** `apps/bot-worker/src/lib/summary/action-items.ts`
**Description:** Extract and structure action items
**Test:** `tests/summary/action-items.test.ts`

---

## 8. Custom Templates

### Task 8.1: Template Service
**File:** `apps/web/src/lib/services/template.ts`
**Description:** CRUD operations for templates
**Test:** `tests/templates/service.test.ts`

### Task 8.2: Template Processor
**File:** `apps/bot-worker/src/lib/summary/template-processor.ts`
**Description:** Process custom templates for summaries
**Test:** `tests/templates/processor.test.ts`

### Task 8.3: Template Variable Resolver
**File:** `apps/bot-worker/src/lib/summary/variable-resolver.ts`
**Description:** Resolve template variables
**Test:** `tests/templates/variables.test.ts`

### Task 8.4: Template API Routes
**Files:**
- `apps/web/src/app/api/templates/route.ts`
- `apps/web/src/app/api/templates/[id]/route.ts`
- `apps/web/src/app/api/templates/[id]/preview/route.ts`
**Test:** `tests/templates/api-routes.test.ts`

### Task 8.5: Built-in Templates
**File:** `packages/shared/src/templates/built-in.ts`
**Description:** Pre-built templates (Sales, Standup, etc.)
**Test:** `tests/templates/built-in.test.ts`

---

## 9. Sharing & Export

### Task 9.1: Share Service
**File:** `apps/web/src/lib/services/share.ts`
**Test:** `tests/sharing/service.test.ts`

### Task 9.2: Share API Routes
**Files:**
- `apps/web/src/app/api/shares/route.ts`
- `apps/web/src/app/api/shares/[token]/route.ts`
**Test:** `tests/sharing/api-routes.test.ts`

### Task 9.3: Public Share Page
**File:** `apps/web/src/app/share/[token]/page.tsx`
**Test:** `tests/sharing/public-page.test.ts`

### Task 9.4: Export Service
**File:** `apps/web/src/lib/services/export.ts`
**Description:** Export recordings, transcripts, summaries
**Test:** `tests/sharing/export.test.ts`

---

## 10. Dashboard UI

### Task 10.1: Authentication Pages
**Files:**
- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/register/page.tsx`
**Test:** `tests/ui/auth.test.ts`

### Task 10.2: Dashboard Home
**File:** `apps/web/src/app/dashboard/page.tsx`
**Test:** `tests/ui/dashboard.test.ts`

### Task 10.3: Calendar Connection UI
**File:** `apps/web/src/app/dashboard/calendars/page.tsx`
**Test:** `tests/ui/calendars.test.ts`

### Task 10.4: Meeting List & Detail
**Files:**
- `apps/web/src/app/dashboard/meetings/page.tsx`
- `apps/web/src/app/dashboard/meetings/[id]/page.tsx`
**Test:** `tests/ui/meetings.test.ts`

### Task 10.5: Video Player with Transcript
**File:** `apps/web/src/components/video-player.tsx`
**Test:** `tests/ui/video-player.test.ts`

### Task 10.6: Summary Editor
**File:** `apps/web/src/components/summary-editor.tsx`
**Test:** `tests/ui/summary-editor.test.ts`

### Task 10.7: Template Builder
**File:** `apps/web/src/app/dashboard/templates/page.tsx`
**Test:** `tests/ui/template-builder.test.ts`

### Task 10.8: Recording Rules UI
**File:** `apps/web/src/app/dashboard/rules/page.tsx`
**Test:** `tests/ui/rules.test.ts`

---

## Test File Locations

```
tests/
├── database/
│   ├── schema.test.ts
│   ├── migrations.test.ts
│   ├── client.test.ts
│   ├── seed.test.ts
│   └── utils.test.ts
├── calendar/
│   ├── google-oauth.test.ts
│   ├── microsoft-oauth.test.ts
│   ├── token-encryption.test.ts
│   ├── google-sync.test.ts
│   ├── microsoft-sync.test.ts
│   ├── api-routes.test.ts
│   ├── meeting-detector.test.ts
│   └── webhooks.test.ts
├── meetings/
│   ├── service.test.ts
│   ├── api-routes.test.ts
│   ├── rules-engine.test.ts
│   ├── scheduler.test.ts
│   ├── rules-api.test.ts
│   └── websocket.test.ts
├── bot-worker/
│   ├── queue.test.ts
│   ├── base-bot.test.ts
│   ├── zoom-bot.test.ts
│   ├── teams-bot.test.ts
│   ├── google-meet-bot.test.ts
│   ├── audio-capture.test.ts
│   └── worker.test.ts
├── recording/
│   ├── chunk-manager.test.ts
│   ├── storage.test.ts
│   ├── chunk-merger.test.ts
│   ├── hls-generator.test.ts
│   ├── api-routes.test.ts
│   └── thumbnail.test.ts
├── transcription/
│   ├── interface.test.ts
│   ├── deepgram.test.ts
│   ├── whisper.test.ts
│   ├── diarization.test.ts
│   └── api-routes.test.ts
├── summary/
│   ├── interface.test.ts
│   ├── openai.test.ts
│   ├── anthropic.test.ts
│   ├── generator.test.ts
│   ├── api-routes.test.ts
│   └── action-items.test.ts
├── templates/
│   ├── service.test.ts
│   ├── processor.test.ts
│   ├── variables.test.ts
│   ├── api-routes.test.ts
│   └── built-in.test.ts
├── sharing/
│   ├── service.test.ts
│   ├── api-routes.test.ts
│   ├── public-page.test.ts
│   └── export.test.ts
└── ui/
    ├── auth.test.ts
    ├── dashboard.test.ts
    ├── calendars.test.ts
    ├── meetings.test.ts
    ├── video-player.test.ts
    ├── summary-editor.test.ts
    ├── template-builder.test.ts
    └── rules.test.ts
```

---

## Implementation Order

### Phase 1: Foundation (P0)
1. Database & Models (Tasks 1.1-1.5)
2. Calendar Integration (Tasks 2.1-2.8)
3. Meeting Management (Tasks 3.1-3.6)
4. Bot Worker Core (Tasks 4.1-4.7)

### Phase 2: Core Features (P1)
5. Recording & Chunks (Tasks 5.1-5.6)
6. Transcription (Tasks 6.1-6.5)
7. AI Summary (Tasks 7.1-7.6)
8. Dashboard UI (Tasks 10.1-10.8)

### Phase 3: Advanced Features (P2)
9. Custom Templates (Tasks 8.1-8.5)
10. Sharing & Export (Tasks 9.1-9.4)

---

## Total: 55 Tasks
