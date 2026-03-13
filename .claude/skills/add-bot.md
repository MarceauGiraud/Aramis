# /add-bot

Create a new meeting bot for a video conferencing platform.

## Usage

`/add-bot <platform>` - Create a new bot for the specified platform (e.g., zoom, teams, webex)

## Instructions

1. Create a new bot file at `apps/bot-worker/src/bots/<platform>.ts`

2. Use this template:
```typescript
import { BaseMeetingBot, BotConfig, BotOptions } from './base';
import { logger } from '../lib/logger';

export class <Platform>Bot extends BaseMeetingBot {
  constructor(config: BotConfig, options: BotOptions = {}) {
    super(config, options);
  }

  async join(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    logger.info(`Joining <platform> meeting: ${this.config.meetingUrl}`);

    // Navigate to meeting URL
    await this.page.goto(this.config.meetingUrl);

    // TODO: Implement platform-specific join logic
    // - Handle login if required
    // - Click join buttons
    // - Handle permissions dialogs
    // - Wait for meeting to start

    // Start recording once in meeting
    await this.startRecording();
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    logger.info('Leaving meeting');

    // TODO: Implement platform-specific leave logic
    // - Click leave button
    // - Confirm leaving
  }

  async checkMeetingEnded(): Promise<boolean> {
    if (!this.page) return true;

    // TODO: Implement platform-specific check
    // - Look for "meeting ended" text/elements
    // - Check if kicked from meeting

    return false;
  }

  async checkStillInMeeting(): Promise<boolean> {
    if (!this.page) return false;

    // TODO: Implement platform-specific check
    // - Look for meeting UI elements
    // - Check if still connected

    return true;
  }
}
```

3. Register in `apps/bot-worker/src/bots/factory.ts`:
```typescript
import { <Platform>Bot } from './<platform>';

// In the create method switch statement:
case '<platform>':
  return new <Platform>Bot(config, options);
```

4. Add platform type to `packages/shared/src/types/meeting.ts` if not exists

5. Report to user:
   - Files created
   - Next steps for implementing platform-specific logic
