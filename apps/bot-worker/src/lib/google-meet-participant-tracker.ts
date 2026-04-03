/**
 * GoogleMeetParticipantTracker
 *
 * TypeScript wrapper around the browser-injected UserManager that parses
 * Google Meet's internal protobuf data channel (via `browser-inject.ts`).
 *
 * The heavy lifting (protobuf decoding, XHR/fetch interception, data channel
 * capture, RTCRtpReceiver.getContributingSources interception) is already
 * handled by the PER_PARTICIPANT_AUDIO_SCRIPT injected in base.ts. This class
 * provides a typed Node-side API to read participant and speaker data from the
 * `window.__aramisUserManager` global exposed by that script.
 *
 * Usage:
 *   const tracker = new GoogleMeetParticipantTracker(page);
 *   await tracker.initialize();
 *   const participants = await tracker.getParticipants();
 *   const speaker = await tracker.getSpeakerName(streamId);
 */

import type { Page } from 'playwright';
import { logger } from './logger';

// -- Interfaces exposed by the browser-side UserManager ---------------------

export interface ParticipantInfo {
  /** Protobuf device ID (stable across the session) */
  deviceId: string;
  /** Full name from Google account */
  fullName: string;
  /** Display name (may differ from fullName) */
  displayName: string;
  /** 1 = in meeting, 6 = left, 7 = removed */
  status: number;
  /** Non-null when this entry represents a screen share */
  parentDeviceId: string | null;
  /** Whether this participant is the bot itself */
  isCurrentUser: boolean;
  /** Whether this participant is the meeting host */
  isHost: boolean;
}

export interface DeviceOutput {
  deviceId: string;
  /** 1 = audio, 2 = video */
  outputType: number;
  streamId: string;
  disabled: boolean;
  lastUpdated: number;
}

export interface ParticipantSnapshot {
  name: string;
  email?: string;
  isHost?: boolean;
  deviceId?: string;
  status?: number;
}

interface UserManagerState {
  participants: ParticipantSnapshot[];
  activeSpeakerDeviceId: string | null;
  totalUsers: number;
  activeUsers: number;
}

// -- Change callback types --------------------------------------------------

export type ParticipantChangeEvent = {
  joined: ParticipantSnapshot[];
  left: ParticipantSnapshot[];
  updated: ParticipantSnapshot[];
};

type ParticipantChangeCallback = (event: ParticipantChangeEvent) => void;

// -- Tracker class ----------------------------------------------------------

const POLL_INTERVAL_MS = 2000;

export class GoogleMeetParticipantTracker {
  private page: Page;
  private initialized = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastKnownDeviceIds = new Set<string>();
  private lastKnownSnapshot = new Map<string, ParticipantSnapshot>();
  private changeCallbacks: ParticipantChangeCallback[] = [];

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Initialize the tracker. Waits for the browser-side UserManager to become
   * available (it is created by PER_PARTICIPANT_AUDIO_SCRIPT injected in base.ts).
   * Starts a polling loop to detect participant changes and fire callbacks.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Wait for UserManager to be available (up to 30s).
    // The script is injected before navigation, but the data channel may take
    // a few seconds after joining to deliver the first protobuf message.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const hasUM = await this.page.evaluate(() => {
          const um = (window as unknown as Record<string, unknown>).__aramisUserManager;
          return !!um;
        });
        if (hasUM) {
          logger.info('GoogleMeetParticipantTracker: UserManager available');
          break;
        }
      } catch {
        // Page may be navigating
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    this.initialized = true;

    // Start polling for change detection
    this.pollInterval = setInterval(() => {
      this.pollForChanges().catch((err) => {
        logger.warn(`GoogleMeetParticipantTracker: poll error: ${err}`);
      });
    }, POLL_INTERVAL_MS);

    logger.info('GoogleMeetParticipantTracker initialized');
  }

  /**
   * Get all participants currently known to the UserManager.
   * Returns an array suitable for `extractParticipants()`.
   */
  async getParticipants(): Promise<ParticipantSnapshot[]> {
    if (!this.initialized) return [];

    try {
      const state = await this.queryUserManager();
      if (state && state.participants.length > 0) {
        // Deduplicate by name — the same person can have multiple deviceIds
        // (e.g. one for audio+video and one for a second video stream).
        // Keep the first occurrence so the isHost flag is preserved.
        const seen = new Set<string>();
        const deduped = state.participants.filter((p) => {
          const key = p.name.toLowerCase().trim();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return deduped;
      }
    } catch (err) {
      logger.warn(`GoogleMeetParticipantTracker.getParticipants error: ${err}`);
    }

    return [];
  }

  /**
   * Get the participant name associated with a WebRTC stream ID.
   * Uses the UserManager's deviceOutputMap to resolve streamId -> deviceId -> name.
   */
  async getSpeakerName(streamId: string): Promise<string | null> {
    if (!this.initialized) return null;

    try {
      return await this.page.evaluate((sid: string) => {
        const um = (window as unknown as Record<string, unknown>).__aramisUserManager as {
          getUserByStreamId?: (id: string) => { fullName?: string; displayName?: string } | null;
          getUserByCsrc?: (id: string) => { fullName?: string; displayName?: string } | null;
        } | null;
        if (!um) return null;

        // Try streamId lookup (via deviceOutputMap)
        if (um.getUserByStreamId) {
          const user = um.getUserByStreamId(sid);
          if (user) return user.fullName || user.displayName || null;
        }

        // Try CSRC lookup (the streamId might actually be a CSRC source ID)
        if (um.getUserByCsrc) {
          const user = um.getUserByCsrc(sid);
          if (user) return user.fullName || user.displayName || null;
        }

        return null;
      }, streamId);
    } catch {
      return null;
    }
  }

  /**
   * Get the speaker name from a CSRC (Contributing Source) ID.
   * This is the primary way to identify who is speaking when processing
   * per-participant audio via RTCRtpReceiver.getContributingSources().
   */
  async getSpeakerNameFromCsrc(csrcId: string): Promise<string | null> {
    if (!this.initialized) return null;

    try {
      return await this.page.evaluate((csrc: string) => {
        const um = (window as unknown as Record<string, unknown>).__aramisUserManager as {
          getUserByCsrc?: (id: string) => { fullName?: string; displayName?: string } | null;
        } | null;
        if (!um?.getUserByCsrc) return null;

        const user = um.getUserByCsrc(csrc);
        return user ? user.fullName || user.displayName || null : null;
      }, csrcId);
    } catch {
      return null;
    }
  }

  /**
   * Get the full state including active user counts.
   * Useful for meeting-end detection (all participants left).
   */
  async getState(): Promise<UserManagerState | null> {
    if (!this.initialized) return null;

    try {
      return await this.queryUserManager();
    } catch {
      return null;
    }
  }

  /**
   * Register a callback for participant changes (joins, leaves, updates).
   * The callback is invoked from the polling loop every POLL_INTERVAL_MS.
   */
  onParticipantChange(callback: ParticipantChangeCallback): () => void {
    this.changeCallbacks.push(callback);
    return () => {
      const idx = this.changeCallbacks.indexOf(callback);
      if (idx >= 0) this.changeCallbacks.splice(idx, 1);
    };
  }

  /**
   * Stop polling and clean up.
   */
  dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.changeCallbacks = [];
    this.initialized = false;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Query the browser-side UserManager and return a structured snapshot.
   */
  private async queryUserManager(): Promise<UserManagerState | null> {
    return await this.page.evaluate(() => {
      const um = (window as unknown as Record<string, unknown>).__aramisUserManager as {
        allUsersMap?: Map<string, Record<string, unknown>>;
        deviceOutputMap?: Map<string, Record<string, unknown>>;
        isCurrentUser?: (deviceId: string) => boolean;
      } | null;

      if (!um?.allUsersMap || um.allUsersMap.size === 0) return null;

      const participants: Array<{
        name: string;
        email?: string;
        isHost?: boolean;
        deviceId?: string;
        status?: number;
      }> = [];

      let totalUsers = 0;
      let activeUsers = 0;
      let activeSpeakerDeviceId: string | null = null;

      for (const [deviceId, user] of um.allUsersMap) {
        if (um.isCurrentUser?.(deviceId)) continue; // skip bot

        totalUsers++;
        const status = user.status as number;
        if (status === 1) activeUsers++;

        const fullName = (user.fullName as string) || '';
        const displayName = (user.displayName as string) || '';
        const name = fullName || displayName;
        if (!name) continue;

        // Skip screen-share entries (they have a parentDeviceId)
        if (user.parentDeviceId) continue;

        participants.push({
          name,
          isHost: !!(user.isHost as boolean),
          deviceId,
          status,
        });
      }

      // Try to identify current dominant speaker from device outputs + CSRC data
      const dsData = (window as unknown as Record<string, unknown>).__aramisDominantSpeaker as {
        streamId?: string;
      } | null;
      if (dsData?.streamId && um.allUsersMap) {
        // Look up the device output matching this streamId
        if (um.deviceOutputMap) {
          for (const [, output] of um.deviceOutputMap) {
            if ((output.streamId as string) === dsData.streamId) {
              activeSpeakerDeviceId = output.deviceId as string;
              break;
            }
          }
        }
      }

      return { participants, activeSpeakerDeviceId, totalUsers, activeUsers };
    });
  }

  /**
   * Poll for participant changes and fire callbacks.
   */
  private async pollForChanges(): Promise<void> {
    const state = await this.queryUserManager();
    if (!state || state.participants.length === 0) return;

    const currentIds = new Set<string>();
    const currentMap = new Map<string, ParticipantSnapshot>();
    for (const p of state.participants) {
      const id = p.deviceId ?? p.name;
      currentIds.add(id);
      currentMap.set(id, p);
    }

    const joined: ParticipantSnapshot[] = [];
    const left: ParticipantSnapshot[] = [];
    const updated: ParticipantSnapshot[] = [];

    // Detect new participants
    for (const id of currentIds) {
      if (!this.lastKnownDeviceIds.has(id)) {
        const p = currentMap.get(id);
        if (p) joined.push(p);
      } else {
        // Check for updates (status change, name change)
        const prev = this.lastKnownSnapshot.get(id);
        const curr = currentMap.get(id);
        if (prev && curr && (prev.name !== curr.name || prev.status !== curr.status || prev.isHost !== curr.isHost)) {
          updated.push(curr);
        }
      }
    }

    // Detect departed participants
    for (const id of this.lastKnownDeviceIds) {
      if (!currentIds.has(id)) {
        const prev = this.lastKnownSnapshot.get(id);
        if (prev) left.push(prev);
      }
    }

    // Update state
    this.lastKnownDeviceIds = currentIds;
    this.lastKnownSnapshot = currentMap;

    // Fire callbacks
    if (joined.length > 0 || left.length > 0 || updated.length > 0) {
      const event: ParticipantChangeEvent = { joined, left, updated };
      for (const cb of this.changeCallbacks) {
        try {
          cb(event);
        } catch (err) {
          logger.warn(`GoogleMeetParticipantTracker: change callback error: ${err}`);
        }
      }
    }
  }
}
