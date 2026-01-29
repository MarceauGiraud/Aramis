# Aramis - Meeting Recorder

A self-hosted meeting recorder that works with **Zoom**, **Microsoft Teams**, and **Google Meet**.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Aramis                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │   Web App    │     │  Bot Worker  │     │   Storage    │    │
│  │  (Next.js)   │────▶│  (Playwright)│────▶│   (MinIO)    │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│         │                    │                                   │
│         │                    │                                   │
│         ▼                    ▼                                   │
│  ┌──────────────┐     ┌──────────────┐                         │
│  │  PostgreSQL  │     │    Redis     │                         │
│  │  (Database)  │     │   (Queue)    │                         │
│  └──────────────┘     └──────────────┘                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Multi-Platform Support**: Record meetings from Zoom, Microsoft Teams, and Google Meet
- **Automatic Transcription**: AI-powered transcription with speaker identification
- **Smart Summaries**: Get AI-generated meeting summaries and action items
- **Self-Hosted**: Keep your data private with full control
- **API-First**: RESTful API for integration with your tools
- **Scalable**: Horizontal scaling of bot workers for concurrent recordings

## Tech Stack

- **Frontend**: Next.js 14, React, Tailwind CSS
- **Backend**: Next.js API Routes, Prisma ORM
- **Bot Worker**: Node.js, Playwright
- **Database**: PostgreSQL
- **Queue**: Redis + BullMQ
- **Storage**: S3-compatible (MinIO for local dev)

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker & Docker Compose

### Development Setup

1. Clone the repository:
```bash
git clone https://github.com/your-org/aramis.git
cd aramis
```

2. Install dependencies:
```bash
pnpm install
```

3. Start infrastructure services:
```bash
docker-compose up -d postgres redis minio
```

4. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your settings
```

5. Initialize the database:
```bash
pnpm db:push
```

6. Start development servers:
```bash
pnpm dev
```

The web app will be available at `http://localhost:3000`.

### Production Deployment

```bash
# Build and start all services
docker-compose --profile production up -d
```

## Project Structure

```
aramis/
├── apps/
│   ├── web/                 # Next.js web application
│   │   ├── src/
│   │   │   ├── app/         # App router pages
│   │   │   ├── components/  # React components
│   │   │   └── lib/         # Utilities
│   │   └── Dockerfile
│   │
│   └── bot-worker/          # Meeting bot service
│       ├── src/
│       │   ├── bots/        # Platform-specific bots
│       │   ├── lib/         # Utilities
│       │   └── index.ts     # Worker entry point
│       └── Dockerfile
│
├── packages/
│   ├── database/            # Prisma schema & client
│   └── shared/              # Shared types & utilities
│
├── docker-compose.yml
└── README.md
```

## API Reference

### Create a Recording

```bash
POST /api/meetings
Content-Type: application/json

{
  "title": "My Meeting",
  "meetingUrl": "https://zoom.us/j/123456789"
}
```

### List Recordings

```bash
GET /api/meetings
```

### Get Recording Details

```bash
GET /api/meetings/:id
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | - |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `S3_ENDPOINT` | S3-compatible storage endpoint | - |
| `S3_ACCESS_KEY` | S3 access key | - |
| `S3_SECRET_KEY` | S3 secret key | - |
| `S3_BUCKET` | S3 bucket name | `recordings` |
| `BOT_NAME` | Name displayed for the bot | `Aramis Recorder` |
| `DEEPGRAM_API_KEY` | Deepgram API key for transcription | - |

### Bot Worker Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_CONCURRENCY` | Max concurrent recordings per worker | `2` |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |

## How It Works

1. **User submits a meeting URL** through the web dashboard or API
2. **System detects the platform** (Zoom, Teams, or Meet) from the URL
3. **A job is queued** in Redis for the bot worker
4. **Bot worker picks up the job** and launches a headless browser
5. **Bot joins the meeting** as a participant with the configured name
6. **Recording starts** using browser media capture
7. **When meeting ends**, recording is saved to S3
8. **Optional**: Audio is sent for transcription

## Limitations & Known Issues

- **Authentication**: Some meetings may require authentication. Guest access must be enabled.
- **Bot Detection**: Platforms may detect automated browsers. The bot uses stealth techniques but cannot guarantee 100% success.
- **Recording Quality**: Quality depends on network conditions and meeting settings.
- **Meeting Passwords**: Currently not supported. Meetings must allow guests without passwords.

## Roadmap

- [ ] Calendar integration (Google Calendar, Outlook)
- [ ] Scheduled recordings
- [ ] Real-time transcription streaming
- [ ] Speaker diarization
- [ ] Meeting analytics dashboard
- [ ] Webhook notifications
- [ ] Multi-language support

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## License

MIT License - see [LICENSE](LICENSE) for details.
