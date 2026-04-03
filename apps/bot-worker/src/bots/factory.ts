import { BaseMeetingBot, BotConfig, BotOptions } from './base';
import { ZoomBot } from './zoom';
import { TeamsBot } from './teams';
import { GoogleMeetBot } from './google-meet';
import { MeetingPlatform } from '@aramis/shared';

export class MeetingBotFactory {
  static create(platform: MeetingPlatform | string, config: BotConfig, options?: BotOptions): BaseMeetingBot {
    const normalized = platform.toUpperCase().replace('-', '_');
    switch (normalized) {
      case 'ZOOM':
        return new ZoomBot(config, options);
      case 'TEAMS':
        return new TeamsBot(config, options);
      case 'GOOGLE_MEET':
        return new GoogleMeetBot(config, options);
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }
}

export { BaseMeetingBot, ZoomBot, TeamsBot, GoogleMeetBot };
export type { BotConfig, BotOptions };
