/**
 * Participant Resolver
 *
 * Maps stream IDs to participant display names by periodically querying the
 * Google Meet DOM. Since Google Meet does not directly expose which stream
 * belongs to which participant, we use a simple order-of-appearance heuristic:
 * new stream IDs are assigned to participants in the order they first appear.
 *
 * Future improvement: correlate audio energy spikes with the DOM's "speaking"
 * indicator to produce more accurate mappings.
 */

import type { Page } from 'playwright';
import { logger } from '../logger';

const POLL_INTERVAL_MS = 2000;

export class ParticipantResolver {
  private streamIdToName: Map<string, string> = new Map();
  private page: Page | null = null;
  private pollInterval: NodeJS.Timeout | null = null;

  /** Ordered list of participant names discovered from the DOM */
  private participantNames: string[] = [];

  /** Tracks which participant index to assign to the next unknown streamId */
  private nextAssignIndex = 0;

  /**
   * Start polling the page DOM for participant information.
   */
  start(page: Page): void {
    this.page = page;

    // Run an initial poll immediately, then schedule recurring polls.
    this.pollParticipants().catch((err) => {
      logger.warn('Initial participant poll failed', { error: String(err) });
    });

    this.pollInterval = setInterval(() => {
      this.pollParticipants().catch((err) => {
        logger.warn('Participant poll failed', { error: String(err) });
      });
    }, POLL_INTERVAL_MS);
  }

  /**
   * Query participant names from UserManager (protobuf data) first,
   * then fall back to DOM scraping.
   */
  private async pollParticipants(): Promise<void> {
    if (!this.page) return;

    try {
      // Primary: query the UserManager populated from Google Meet's data channel.
      // Also fetch the browser-side CSRC -> deviceId mapping so we can back-fill
      // name resolution for raw CSRC keys on the Node side.
      const userManagerData = await this.page
        .evaluate(() => {
          const um = (window as any).__aramisUserManager;
          if (!um) return null;
          // Use allUsersMap directly (a Map<deviceId, user>) instead of
          // getAllUsers() which returns an Array and loses the deviceId keys.
          const usersMap = um.allUsersMap;
          const outputs = um.deviceOutputMap;
          if (!usersMap || usersMap.size === 0) return null;

          const users: Array<{ deviceId: string; name: string; streamId?: string }> = [];
          for (const [deviceId, user] of usersMap) {
            if (um.isCurrentUser(deviceId)) continue; // skip the bot
            const name = (user as any).fullName || (user as any).displayName;
            if (!name) continue;

            // Find audio streamId for this device
            let streamId: string | undefined;
            if (outputs) {
              for (const [, output] of outputs) {
                if ((output as any).deviceId === deviceId && (output as any).outputType === 1) {
                  streamId = (output as any).streamId;
                }
              }
            }
            users.push({ deviceId, name, streamId });
          }

          // Collect CSRC -> deviceId mappings built by getUserByCsrc()
          const csrcMappings: Array<{ csrc: string; deviceId: string }> = [];
          if (um.csrcToDeviceId) {
            for (const [csrc, did] of um.csrcToDeviceId) {
              csrcMappings.push({ csrc, deviceId: did });
            }
          }

          return { users, csrcMappings };
        })
        .catch(() => null);

      if (userManagerData && userManagerData.users.length > 0) {
        const { users, csrcMappings } = userManagerData;

        // Map streamIds and deviceIds to names. The browser-side
        // getUserByCsrc() resolves CSRC -> deviceId, so the speaker IDs
        // arriving on the Node side should be deviceIds when successfully
        // resolved, or raw CSRC numbers when resolution failed.
        for (const user of users) {
          if (user.streamId) {
            const prev = this.streamIdToName.get(user.streamId);
            if (prev && prev !== user.name) {
              logger.info('Updating stale participant name', {
                streamId: user.streamId,
                oldName: prev,
                newName: user.name,
              });
            }
            this.streamIdToName.set(user.streamId, user.name);
          }
          // Also map deviceId directly -- this is the primary key used when
          // the browser successfully resolves CSRC -> deviceId.
          this.streamIdToName.set(user.deviceId, user.name);
        }
        this.participantNames = users.map((u) => u.name);

        // Apply browser-side CSRC -> deviceId mappings to resolve raw CSRC
        // keys that the Node side may have stored before the browser resolved them.
        if (csrcMappings.length > 0) {
          for (const { csrc, deviceId } of csrcMappings) {
            const name = this.streamIdToName.get(deviceId);
            if (name) {
              const prev = this.streamIdToName.get(csrc);
              if (!prev || prev.startsWith('Participant ')) {
                this.streamIdToName.set(csrc, name);
                if (prev && prev !== name) {
                  logger.info('CSRC mapping resolved name', {
                    csrc,
                    deviceId,
                    oldName: prev,
                    newName: name,
                  });
                }
              }
            }
          }
        }

        // Back-fill: for any session key (CSRC) that still has a fallback
        // name, try to assign a real name. When there is only one non-bot
        // participant, any unresolved CSRC must belong to them.
        if (users.length === 1) {
          const singleName = users[0].name;
          for (const [key, name] of this.streamIdToName) {
            if (name.startsWith('Participant ')) {
              logger.info('Back-filling single-participant name for CSRC', {
                csrc: key,
                name: singleName,
              });
              this.streamIdToName.set(key, singleName);
            }
          }
        }

        logger.info('Participant names from UserManager', {
          count: users.length,
          names: users.map((u) => u.name),
          csrcMappings: csrcMappings.length,
        });
        return; // UserManager data is authoritative, skip DOM
      }

      // Fallback: DOM scraping (only used when UserManager has no data)
      // Note: DOM scraping is fragile and can pick up Google Meet UI text.
      // When UserManager is active (data channel connected), this path is
      // skipped entirely — the UserManager just hasn't received user data yet.
      const names: string[] = await this.page.evaluate(() => {
        // If UserManager exists and has a data channel connection, skip DOM
        // scraping entirely — user data will arrive via protobuf shortly.
        const um = (window as any).__aramisUserManager;
        if (um && um.deviceOutputMap && um.deviceOutputMap.size > 0) {
          // Device outputs have arrived, meaning the data channel is active.
          // User info will follow shortly. Don't pollute with DOM names.
          return [];
        }

        const result: string[] = [];

        // Blocklist of Google Meet UI phrases that are NOT participant names
        const uiTextBlocklist = [
          'video',
          'mute',
          'Turn',
          'Others',
          'settings',
          'Leave',
          'ctrl',
          'keyboard',
          'might',
          'still',
          'see',
          'your',
          'full',
          'camera',
          'microphone',
          'present',
          'meeting',
          'recording',
          'caption',
          'chat',
          'activities',
          'people',
          'hand',
          'reaction',
          'raised',
          'layout',
          'apply',
          'background',
          'effect',
          'visual',
          'host',
          'admit',
          'deny',
          'remove',
          'pin',
          'spotlight',
        ];

        function isUiText(text: string): boolean {
          const lower = text.toLowerCase();
          for (const word of uiTextBlocklist) {
            if (lower.includes(word.toLowerCase())) return true;
          }
          // Filter out text that looks like a sentence (contains spaces and is long)
          if (text.length > 30) return true;
          return false;
        }

        // Strategy 1: participant tiles in the meeting view
        const tiles = document.querySelectorAll('[data-participant-id]');
        tiles.forEach((el) => {
          const selfName = el.getAttribute('data-self-name');
          if (selfName && selfName.length < 60 && !isUiText(selfName)) {
            result.push(selfName);
            return;
          }
        });

        // Strategy 2: participant panel list items (if panel is open)
        if (result.length === 0) {
          const listItems = document.querySelectorAll('[role="listitem"]');
          listItems.forEach((el) => {
            const tooltip = el.getAttribute('data-tooltip');
            if (tooltip && tooltip.length < 60 && !isUiText(tooltip)) {
              result.push(tooltip);
              return;
            }
            // Try inner spans
            const spans = el.querySelectorAll('span');
            for (const span of Array.from(spans)) {
              const text = span.textContent?.trim();
              if (
                text &&
                text.length > 1 &&
                text.length < 60 &&
                span.children.length === 0 &&
                !text.includes('_') &&
                !isUiText(text)
              ) {
                result.push(text);
                break;
              }
            }
          });
        }

        // Deduplicate
        return [...new Set(result)];
      });

      if (names.length > 0) {
        this.participantNames = names;
        logger.debug('Polled participant names', { count: names.length, names });
      }
    } catch (err) {
      // Page may have navigated or been closed; this is expected during teardown.
      logger.debug('Could not poll participants from DOM', { error: String(err) });
    }
  }

  /**
   * Get the display name for a given streamId.
   *
   * Always re-checks the UserManager for fresh data on every call, since user
   * info may arrive after device outputs (and after initial getName() calls
   * that returned a fallback like "Participant 4140").
   *
   * If no UserManager data is available, falls back to participant names from
   * the DOM list, and finally to a short ID based on the CSRC.
   */
  getName(csrcId: string): string {
    // The pollParticipants() cycle continuously pushes UserManager data into
    // this.streamIdToName, overwriting stale fallback names. So the map
    // lookup below will return fresh data once a poll cycle resolves it.
    const existing = this.streamIdToName.get(csrcId);
    // Return cached name ONLY if it's a real name (not a fallback like "Participant 4140")
    if (existing && !existing.startsWith('Participant ')) return existing;

    // When there is exactly one known participant, any unresolved CSRC must
    // be them — assign directly without round-robin.
    if (this.participantNames.length === 1) {
      const name = this.participantNames[0];
      this.streamIdToName.set(csrcId, name);
      logger.info('Assigned sole participant name to CSRC', { csrc: csrcId, name });
      return name;
    }

    // Multiple participants: assign from the list using round-robin.
    // This is a best-effort heuristic; real name resolution happens via the
    // browser-side CSRC -> deviceId mapping (getUserByCsrc) which sends
    // deviceIds that match the streamIdToName map directly.
    if (this.participantNames.length > 0) {
      const name = this.participantNames[this.nextAssignIndex % this.participantNames.length];
      this.nextAssignIndex++;
      this.streamIdToName.set(csrcId, name);
      logger.info('Assigned participant name to CSRC (round-robin)', { csrc: csrcId, name });
      return name;
    }

    // Fallback: use last 4 digits of CSRC for readability.
    // Do NOT cache this — a subsequent poll may resolve the real name.
    const shortId = csrcId.replace(/.*\//, '').slice(-4);
    return `Participant ${shortId}`;
  }

  /**
   * Return all known participant names (including muted participants who may
   * never have produced audio and thus have no CSRC / streamId mapping).
   */
  getAllParticipantNames(): string[] {
    return [...this.participantNames];
  }

  /**
   * Manually set a streamId to name mapping.
   * Called when we can correlate a streamId to a specific participant through
   * external means (e.g., speaking indicator correlation).
   */
  updateMapping(csrcId: string, name: string): void {
    this.streamIdToName.set(csrcId, name);
    logger.info('Updated streamId to name mapping', { streamId: csrcId, name });
  }

  /**
   * Stop polling and release resources.
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.page = null;
  }
}
