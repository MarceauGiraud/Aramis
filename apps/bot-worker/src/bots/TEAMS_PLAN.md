# Microsoft Teams Browser-Based Bot — Implementation Plan

## Current State of teams.ts

### What's already implemented

The `TeamsBot` class extends `BaseMeetingBot` and has a complete skeleton:

- **URL transformation** (`buildWebClientUrl`): Rewrites `teams.microsoft.com/meet/` to `teams.live.com/meet/`, extracts embedded URLs from launcher wrappers (`/dl/launcher/`), and strips `v2/#` prefixes.
- **Launcher bypass** (`handleWebJoin`): Two strategies — (1) click `[data-tid="joinOnWeb"]` and catch the new tab, (2) extract the meeting path from launcher URL params and navigate directly.
- **Pre-join screen**: Waits for `[data-tid="prejoin-display-name-input"]`, `[data-tid="prejoin-join-button"]`, and various `input[placeholder*="name"]` fallbacks.
- **Name entry**: Fills `[data-tid="prejoin-display-name-input"]` with human-like typing delays.
- **Camera/mic toggle**: Uses `[data-tid="toggle-video"]` and `[data-tid="toggle-mute"]` with aria-state checks.
- **Join button**: Clicks `[data-tid="prejoin-join-button"]` with disabled-state guard.
- **Lobby wait**: Polls for lobby indicators (`[data-tid="lobby-screen"]`, text="Waiting for others") up to 5 minutes.
- **Meeting-end detection** (`checkMeetingEnded`): Checks text indicators ("The meeting has ended", "Call ended"), URL changes, and participant count drop (via roster button or video tile counting).
- **In-meeting detection** (`checkStillInMeeting`): Looks for `[data-tid="hangup-button"]`, `[data-tid="calling-unified-bar"]`, video gallery, etc.
- **Leave**: Clicks `[data-tid="hangup-button"]` with confirmation dialog handling.
- **Participant counting**: Reads roster button text/aria-label for a number, falls back to counting video tiles and roster items.

### What works

- URL transformation logic is sound for the common URL formats.
- Selector lists are reasonable for the "new Teams" web client (teams.live.com).
- The pre-join flow (name, camera, mic, join) follows the correct sequence.
- `BaseMeetingBot` provides CSP bypass (both header stripping and `Page.setBypassCSP` via CDP), stealth scripts, RTCPeerConnection tracking, and per-participant audio infrastructure — all reusable as-is.

### What's broken or missing

1. **Launcher redirect loop**: The `teams.microsoft.com/meet/<id>` -> `teams.live.com/meet/<id>` rewrite often lands on a launcher page anyway. The current `handleWebJoin` fallback may loop between launcher pages because `teams.live.com` itself can redirect back to a launcher for anonymous/guest users. There is no cookie or header manipulation to signal "I am a browser, not a desktop app" before the redirect chain fires.

2. **No join retry loop**: Google Meet has a multi-attempt `join()` with `JoinError` classification (retryable vs non-retryable). Teams has a single-shot join with no retry, no error classification.

3. **No WebRTC readiness check**: Google Meet waits for `__aramisPeerConnections` to show a connected peer with remote tracks before starting recording. Teams starts recording immediately after join verification, which can capture lobby/transition frames.

4. **No WebSocket interception for meeting-end**: The current `checkMeetingEnded` relies on DOM polling (text indicators, participant count). This is fragile — Teams can end a meeting server-side without updating the DOM promptly. Attendee uses WebSocket message interception (`conversation/conversationEnd/`) which is instantaneous.

5. **No per-participant audio**: The `PER_PARTICIPANT_AUDIO_SCRIPT` injection and `PerParticipantAudioManager` from base.ts are available but never wired in the Teams join flow.

6. **No popup/consent handling**: Teams shows various consent dialogs (cookie consent, "Use your mic/camera" prompts, "Allow notifications"). No dismiss logic exists.

7. **Participant count is unreliable**: DOM-based counting via roster button text parsing is brittle. The roster panel may not be open, and the button label format varies by locale.

---

## Attendee's Approach (Reference)

Attendee (open-source meeting bot) handles Teams via these key mechanisms:

### Selectors (new Teams web client — teams.live.com)

| Element | Selector |
|---------|----------|
| Pre-join name input | `[data-tid="prejoin-display-name-input"]` |
| Join button | `[data-tid="prejoin-join-button"]` |
| Microphone toggle | `[data-tid="toggle-mute"]` |
| Camera toggle | `[data-tid="toggle-video"]` |
| Hangup button | `[data-inp="hangup-button"]`, `#hangup-button` |
| Roster/people button | `[data-tid="roster-button"]`, `[data-tid="people-button"]` |

### Meeting-end detection

Attendee intercepts WebSocket frames rather than polling the DOM:

1. Hook `WebSocket.prototype.send` before page load.
2. Watch for frames containing `conversation/conversationEnd/` — this is the Teams signaling message that fires when the meeting is terminated server-side.
3. Also intercept `callEnd` and `participantLeft` messages for participant tracking.

### Launcher bypass

Attendee uses a Chrome policy (`BrowserSwitcherUrlList`) to prevent `msteams://` protocol handler redirects. In our Playwright context, the equivalent is:
- `--disable-external-intent-requests` (already set in base.ts)
- Direct navigation to `teams.live.com/meet/<id>?anon=true` (the `anon=true` param forces guest/anonymous mode and skips the "Open in desktop app" interstitial on some URL formats)

### Audio capture

Same WebRTC interception as Google Meet — hook `RTCPeerConnection`, intercept `ontrack`, decode audio via `AudioContext` + `ScriptProcessorNode` / `AudioWorklet`. Already implemented in `base.ts` and `per-participant-audio/browser-inject.ts`.

---

## Implementation Plan

### 1. Join Flow — URL Transformation and Launcher Bypass

**Goal**: Reliably reach the pre-join screen without manual "Continue in browser" clicks.

**Changes to `buildWebClientUrl`**:
- Add `?anon=true` query param to force anonymous/guest flow (skips "Open desktop app" prompt).
- For `/l/meetup-join/` URLs, construct the canonical `teams.live.com/v2/#/l/meetup-join/...` format which loads the new Teams client directly.
- Handle `teams.microsoft.com/dl/launcher/launcher.html?url=...&type=meetup-join` by extracting the context/thread IDs and building a clean `teams.live.com` URL.

**Changes to `handleWebJoin`**:
- Before navigation, set a cookie or intercept the initial request to add `X-Ms-Client-Type: web` header (signals web client preference to Teams backend).
- If still on launcher after all strategies, use `page.evaluate` to extract the meeting join URL from the launcher page's JavaScript globals (`window.__meetingInfo`, `window.__launcherConfig`).

**Add join retry loop** (match Google Meet pattern):
- Wrap `join()` in a retry loop with `JoinError` classification.
- Retryable: launcher redirect, pre-join timeout, network errors.
- Non-retryable: access denied, meeting not found, authentication required.

**Effort**: ~4 hours. Mostly URL manipulation and retry logic.

### 2. Meeting-End Detection — WebSocket Interception

**Goal**: Detect meeting end instantly via signaling messages instead of DOM polling.

**Implementation**:
- Add an `addInitScript` in the Teams join flow (or in base.ts guarded by platform) that hooks `WebSocket.prototype.send` and the `message` event.
- Watch for frames containing:
  - `conversation/conversationEnd/` — meeting terminated
  - `callEnd` — call ended
  - `thread.delete` — meeting thread deleted
- Expose a `window.__aramisTeamsMeetingEnded` flag that `checkMeetingEnded` can read.
- Keep the existing DOM-based checks as fallback.

**Skeleton**:
```typescript
await this.page.addInitScript(() => {
  const OriginalWebSocket = window.WebSocket;
  (window as any).__aramisTeamsMeetingEnded = false;

  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    // Outbound — no action needed
    return origSend.call(this, data);
  };

  // Patch constructor to intercept inbound messages
  (window as any).WebSocket = function(...args: any[]) {
    const ws = new OriginalWebSocket(...args);
    ws.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : '';
      if (text.includes('conversationEnd') || text.includes('callEnd')) {
        (window as any).__aramisTeamsMeetingEnded = true;
        console.log('[ARAMIS] Teams meeting ended (WebSocket signal)');
      }
    });
    return ws;
  };
  (window as any).WebSocket.prototype = OriginalWebSocket.prototype;
});
```

**Effort**: ~2 hours. The pattern is well-established from Attendee's approach.

### 3. Audio Capture — WebRTC Interception

**Goal**: Capture per-participant audio streams for transcription.

**What's already done**:
- `base.ts` hooks `RTCPeerConnection` and tracks instances in `__aramisPeerConnections`.
- `per-participant-audio/browser-inject.ts` has the `PER_PARTICIPANT_AUDIO_SCRIPT` that intercepts `getContributingSources()` for CSRC-based speaker identification.
- `PerParticipantAudioManager` handles audio chunk routing.
- `base.ts` exposes `__aramisPerParticipantAudio` callback to the page.

**What needs to happen**:
- In `TeamsBot.join()`, after joining the meeting, call `this.page.evaluate(PER_PARTICIPANT_AUDIO_SCRIPT)` (or better, inject it via `addInitScript` before navigation so it captures all connections).
- Initialize `this.perParticipantManager` in the Teams join flow.
- Verify that Teams WebRTC connections expose CSRC data (they should — Teams uses standard WebRTC).

**Effort**: ~1 hour. Almost entirely reusing existing infrastructure.

### 4. Key Selectors — Full Reference

Document and verify these selectors against the current Teams web client:

**Pre-join screen**:
| Element | Primary selector | Fallbacks |
|---------|-----------------|-----------|
| Name input | `[data-tid="prejoin-display-name-input"]` | `[data-tid="prejoin-name-input"]`, `input[placeholder*="name" i]` |
| Join button | `[data-tid="prejoin-join-button"]` | `#prejoin-join-button`, `button[data-tid*="join" i]` |
| Camera toggle | `[data-tid="toggle-video"]` | `[data-tid="prejoin-camera-toggle"]` |
| Mic toggle | `[data-tid="toggle-mute"]` | `[data-tid="prejoin-mic-toggle"]` |

**In-meeting controls**:
| Element | Primary selector | Fallbacks |
|---------|-----------------|-----------|
| Hangup | `[data-tid="hangup-button"]` | `#hangup-button`, `[data-inp="hangup-button"]` |
| Roster button | `[data-tid="roster-button"]` | `[data-tid="people-button"]` |
| Chat button | `[data-tid="chat-button"]` | — |
| Video gallery | `[data-tid="video-gallery"]` | `[data-tid="participant-gallery"]` |
| Call controls bar | `[data-tid="calling-unified-bar"]` | `[data-tid="call-controls"]` |

**State indicators**:
| State | Selector/signal |
|-------|----------------|
| In lobby | `[data-tid="lobby-screen"]`, text="Waiting for others to let you in" |
| Meeting ended | WebSocket `conversationEnd`, text="The meeting has ended" |
| Access denied | text="You were denied access", `[data-tid="lobby-denied"]` |
| Kicked | text="removed from the meeting" |

### 5. CSP Handling

**Already handled in base.ts**:
- `Page.setBypassCSP` via CDP — bypasses all CSP enforcement, including `connect-src` restrictions that would block `ws://localhost:8765` for per-participant audio.
- Route interception strips `content-security-policy` headers from responses.
- `--disable-features=IsolateOrigins,BlockInsecurePrivateNetworkRequests` allows localhost WebSocket from teams.live.com origin.

**Teams-specific concern**:
- Teams uses a Service Worker that can enforce its own CSP. If per-participant audio WebSocket connections fail, we may need to unregister the Service Worker via:
  ```typescript
  await this.page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const reg of registrations) await reg.unregister();
  });
  ```
- This should be done after initial page load but before injecting the audio capture script.

**Effort**: ~30 minutes. Mostly verification; fallback SW unregistration if needed.

### 6. Popup/Consent Handling

**Add a `handlePopups` method** (similar to Google Meet's):
- Cookie consent: `button:has-text("Accept")`, `[data-tid="cookie-banner-accept"]`
- Notification prompts: `button:has-text("Block")`, `button:has-text("Not now")`
- "Use microphone" prompt: `button:has-text("Allow")`, `button:has-text("Block")`
- Generic dismiss: `[aria-label="Close" i]`, `[aria-label="Dismiss" i]`

Call this after page load and after joining.

**Effort**: ~1 hour.

---

## Estimated Effort Summary

| Task | Effort | Reuse from existing code |
|------|--------|------------------------|
| Join flow (URL transform, launcher bypass, retry) | 4h | Retry pattern from GoogleMeetBot |
| WebSocket interception for meeting-end | 2h | Pattern from Attendee research |
| Per-participant audio wiring | 1h | 95% reuse from base.ts + browser-inject.ts |
| Selector verification and updates | 2h | Existing selectors are ~80% correct |
| CSP / Service Worker handling | 0.5h | base.ts CSP bypass already works |
| Popup/consent handling | 1h | Pattern from GoogleMeetBot |
| Integration testing | 3h | — |
| **Total** | **~13.5h** | |

## Priority Order

1. **Join flow** — nothing works without this. The launcher redirect is the #1 blocker.
2. **WebSocket meeting-end detection** — critical for reliability; DOM polling misses server-side meeting termination.
3. **Popup handling** — blocks join flow if consent dialogs appear.
4. **Per-participant audio** — needed for transcription quality.
5. **Selector updates** — ongoing; Teams updates its web client frequently.
6. **CSP / Service Worker** — only needed if per-participant audio fails.

## Key Risks

- **Teams web client instability**: Microsoft updates `teams.live.com` frequently. `data-tid` attributes are the most stable selectors but can still change. Plan for a selector refresh every 2-3 months.
- **Anonymous join restrictions**: Some Teams meetings require authentication. The bot cannot sign in — these meetings will fail with a non-retryable error.
- **Launcher redirect variants**: Microsoft has at least 4 different URL formats and 3 different launcher pages. The URL transformation logic needs to handle all of them. Testing with real meeting URLs from different Teams tenants is essential.
- **WebSocket message format**: The `conversationEnd` signal format may vary between Teams versions. Need to test with both "classic" and "new" Teams web clients.
