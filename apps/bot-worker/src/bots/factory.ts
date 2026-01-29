import { BaseMeetingBot, BotConfig } from './base';
import { ZoomBot } from './zoom';
import { TeamsBot } from './teams';
import { GoogleMeetBot } from './google-meet';
import { MeetingPlatform } from '@aramis/shared';

export class MeetingBotFactory {
  static create(platform: MeetingPlatform | string, config: BotConfig): BaseMeetingBot {
    switch (platform) {
      case 'ZOOM':
        return new ZoomBot(config);
      case 'TEAMS':
        return new TeamsBot(config);
      case 'GOOGLE_MEET':
        return new GoogleMeetBot(config);
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }
}

export { BaseMeetingBot, ZoomBot, TeamsBot, GoogleMeetBot };
export type { BotConfig };
