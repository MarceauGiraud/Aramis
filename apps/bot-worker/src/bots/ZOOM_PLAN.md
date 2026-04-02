# Zoom Browser-Based Bot - Implementation Plan

## Current State of zoom.ts

### What's Already Implemented

The `ZoomBot` class extends `BaseMeetingBot` and has a complete skeleton for:

- **Join flow**: `join()` orchestrates navigation, browser join link click, name entry, passcode entry, camera/mic off, join button click, audio prompt handling, and waiting room admission.
- **Browser join detection**: `handleBrowserJoin()` looks for "Join from Your Browser" links and "Launch Meeting" fallback flow.
- **Name/passcode entry**: `enterName()` and `enterPasscode()` with multiple selector fallbacks. Passcode is extracted from URL `?pwd=` param.
- **Media toggle**: `turnOffCamera()` and `turnOffMicrophone()` with aria-label-based selectors.
- **Meeting state detection**: `checkStillInMeeting()` checks DOM selectors and URL patterns. `checkMeetingEnded()` checks end indicators, URL, and participant count.
- **Participant counting**: `getParticipantCount()` with three methods (button text, video tiles, participant list).
- **Waiting room**: `waitForAdmission()` with 5-minute timeout, denial detection, and human-like mouse movement.
- **Breakout rooms**: `checkForBreakoutRoom()` detects invitations and auto-joins (pauses/resumes recording).
- **Leave flow**: `leave()` with confirmation dialog handling.

### What Works vs What's Broken

**Likely works:**
- Basic structure and lifecycle (inherits `initialize()`, `startRecording()`, `stopRecording()`, `cleanup()`, `waitForEnd()` from `BaseMeetingBot`)
- Passcode extraction from URL
- General flow logic

**Likely broken / needs validation:**
- **URL handling**: Goes directly to `meetingUrl` without transforming to web client URL (`zoom.us/wc/join/MEETING_ID`). The "Join from Your Browser" link detection is fragile and adds unnecessary delay.
- **Selectors**: Many selectors reference old Zoom web client DOM (e.g., `#wc-container-left`, `.meeting-client`, `#joinFromBrowser`, `.video-avatar`). Zoom's web client has been rewritten multiple times. These need fresh validation.
- **No state machine**: Unlike `GoogleMeetBot` which has a `detectPageState()` state machine with retry logic, `ZoomBot` uses a linear flow. If any step fails silently, later steps break.
- **No join retry**: `GoogleMeetBot` retries the full join flow up to `BOT_CONFIG.JOIN_MAX_ATTEMPTS` times. `ZoomBot` does not.
- **No WebRTC readiness check**: `GoogleMeetBot` calls `waitForWebRTCReady()` and `waitForMeetingUIReady()` before starting recording. `ZoomBot` calls `startRecording()` immediately after join verification.
- **No popup handling**: Zoom web client shows cookie consent, permission prompts, and feature announcements. No dismissal logic exists.
- **Audio prompt**: The "Join Audio by Computer" dialog is critical for Zoom web client audio. Current selectors may be stale.

### Key Differences from Google Meet

| Aspect | Google Meet | Zoom Web Client |
|--------|-------------|-----------------|
| URL | Direct (`meet.google.com/xxx`) | Needs transform (`zoom.us/j/ID` -> `zoom.us/wc/join/ID`) |
| Auth | Guest mode (no login) | Guest mode, but may require passcode |
| Pre-join | Name input + Join button | Name + optional passcode + Join button |
| Audio | Auto-connected via WebRTC | Explicit "Join Audio by Computer" prompt |
| Waiting room | Common, host admits | Very common, often enabled by default |
| Bot detection | Moderate (stealth plugin handles it) | Lower (web client is less restrictive) |
| DOM stability | Unstable (frequent UI rewrites) | Unstable (React app, class names change) |
| External app redirect | No | Yes - Zoom tries to launch desktop app first |
| Breakout rooms | No | Yes - need to handle invitations |

## Browser-Based Zoom Approach

### URL Transformation

Zoom meeting URLs come in several forms. All must be normalized to the web client URL:

```
Input:                                    Output:
zoom.us/j/1234567890                  ->  zoom.us/wc/join/1234567890
zoom.us/j/1234567890?pwd=abc          ->  zoom.us/wc/join/1234567890?pwd=abc
us02web.zoom.us/j/1234567890          ->  us02web.zoom.us/wc/join/1234567890
app.zoom.us/wc/join/1234567890        ->  (already correct)
```

The `/wc/join/` path bypasses the "Launch Meeting" / "Open Zoom" interstitial entirely, going straight to the browser-based client. This eliminates the need for `handleBrowserJoin()`.

### Join Flow (Revised)

1. **Transform URL** to `/wc/join/` format
2. **Navigate** with `domcontentloaded` (not `networkidle` - Zoom loads lazily)
3. **Dismiss popups** (cookie consent, feature announcements)
4. **Enter name** in the pre-join input
5. **Enter passcode** if prompted (extract from URL `?pwd=` or config)
6. **Turn off camera/mic** on pre-join screen
7. **Click Join** button
8. **Handle "Join Audio by Computer"** prompt (critical for audio capture)
9. **Wait for admission** if in waiting room
10. **Verify in-meeting** state via DOM + WebRTC
11. **Wait for WebRTC ready** (reuse base class RTCPeerConnection hooks)
12. **Start recording**

### Waiting Room Handling

Zoom's waiting room is more common than Meet's. The current implementation is reasonable but needs:
- Updated selectors for the current Zoom web client
- Integration with the bot state machine approach (detect WAITING_ROOM state)
- Configurable timeout via `options.waitingRoomTimeoutMs`

### Meeting End Detection

Current approach is sound but needs selector updates. Key signals:
- Text indicators: "This meeting has been ended by host", "You have been removed"
- URL change: redirect to `/postattendee` or home page
- Participant count dropping to 1 (bot alone)
- WebRTC disconnection (all peer connections closed/failed)

## Audio Capture

### Can We Reuse the Per-Participant CSRC Approach?

**Yes, with caveats.**

The base class already:
1. Hooks `RTCPeerConnection` via `addInitScript` to track all peer connections
2. Intercepts `getContributingSources()` to map CSRC IDs to audio levels
3. Stores audio track references in `__aramisAudioTracks`
4. Exposes `__aramisPerParticipantAudio` callback for browser-to-Node audio chunks
5. Starts `PerParticipantAudioManager` in `startRecording()`

Zoom's web client uses WebRTC for audio/video transport, same as Google Meet. The CSRC-based per-participant audio interception should work because:
- Zoom web client creates `RTCPeerConnection` instances (hooked by base class)
- Audio tracks arrive via `ontrack` events (already tracked)
- `getContributingSources()` returns CSRC entries for mixed audio streams

**Potential issues:**
- Zoom may use a different WebRTC topology (e.g., single mixed stream vs per-participant streams). Need to validate whether CSRCs are actually populated.
- Zoom's web client may use WebAssembly-based audio processing that bypasses standard WebRTC APIs.
- The "Join Audio by Computer" step must complete before any audio tracks arrive.

**Fallback:** Mixed audio capture via PulseAudio/FFmpeg (already handled by `RecordingOrchestrator`) works regardless of WebRTC topology.

## Key Selectors (To Validate)

These need fresh validation against the current Zoom web client. Listed as best-known starting points:

### Pre-Join Screen
```
Name input:       #inputname, input[placeholder*="name" i]
Passcode input:   #inputpasscode, input[placeholder*="passcode" i]
Join button:      button.preview-join-button, button:has-text("Join"), #joinBtn
Camera toggle:    button[aria-label*="video" i], #preview-video-control-button
Mic toggle:       button[aria-label*="audio" i], #preview-audio-control-button
```

### Audio Join Prompt
```
Join audio:       button:has-text("Join Audio by Computer"), .join-audio-by-voip
```

### In-Meeting Indicators
```
Meeting container:  #wc-content, .meeting-app, [class*="meeting-client"]
Video tiles:        .video-avatar, [data-user-id], .video-tile
Participant count:  [aria-label*="participant" i], .participants-header
Leave button:       button[aria-label*="Leave" i], .footer-leave
```

### Meeting Ended
```
Ended text:       text=This meeting has been ended, text=Meeting Ended
Removed text:     text=You have been removed
Post-meeting URL: /postattendee, /leaveurl
```

### Waiting Room
```
Waiting text:     text=Please wait, the meeting host will let you in soon
                  text=Waiting for the host
Denied text:      text=The host has denied your request
```

### Popups/Dialogs
```
Cookie consent:   button:has-text("Accept"), button:has-text("Got it")
Feature prompts:  button[aria-label="Close"], button:has-text("OK")
```

## Implementation Plan

### Phase 1: URL Handling and State Machine (1-2 days)

**New/changed:**
- Add `private transformToWebClientUrl(url: string): string` method
- Add `detectPageState(): Promise<PageState>` state machine (similar to GoogleMeetBot)
- Add `hasAnySelector()` helper (or extract from GoogleMeetBot to base class)
- Add join retry loop wrapping `attemptJoin()`

**Reuse from base class:**
- `initialize()`, `cleanup()`, `waitForEnd()`
- RTCPeerConnection hooks (addInitScript)
- Per-participant audio infrastructure
- `humanClick()`, `sleep()`, `takeDebugScreenshot()`

### Phase 2: Join Flow Rewrite (2-3 days)

**Rewrite `join()` to match GoogleMeetBot pattern:**
1. `attemptJoin()` with step-by-step state detection
2. Remove `handleBrowserJoin()` entirely (URL transform handles this)
3. Add `handlePopups()` method for Zoom-specific dialogs
4. Update all selectors (requires manual testing against live Zoom web client)
5. Add `waitForWebRTCReady()` call before `startRecording()`
6. Add `waitForMeetingUIReady()` with Zoom-specific selectors

### Phase 3: Audio and Meeting Detection (1-2 days)

**Audio:**
- Validate CSRC approach works with Zoom's WebRTC implementation
- Ensure "Join Audio by Computer" is clicked before recording starts
- Test fallback to mixed PulseAudio capture

**Meeting detection:**
- Update `checkStillInMeeting()` and `checkMeetingEnded()` selectors
- Add WebRTC-based meeting end detection (all connections disconnected)
- Integrate with `getParticipantCount()` for zombie watchdog

### Phase 4: Edge Cases (1 day)

- Breakout room handling (existing code, update selectors)
- Passcode from config (not just URL)
- Host-only meetings (bot joins before host)
- Reconnection after network drop
- Multiple Zoom subdomain support (us02web, us04web, etc.)

### Phase 5: Testing (1-2 days)

- Manual testing against live Zoom meetings (free account)
- Test waiting room admission flow
- Test passcode-protected meetings
- Test meeting end detection (host ends, all leave, bot kicked)
- Test breakout room transition
- Validate per-participant audio capture

## Estimated Effort

| Component | Effort | Notes |
|-----------|--------|-------|
| URL transform + state machine | 1 day | Straightforward, follows Meet pattern |
| Join flow rewrite | 2 days | Selector validation is the bottleneck |
| Audio validation | 1 day | May "just work" via base class hooks |
| Meeting detection updates | 0.5 day | Selector updates + WebRTC check |
| Edge cases | 1 day | Breakout rooms, passcode, reconnect |
| Testing | 2 days | Manual testing against live meetings |
| **Total** | **~7 days** | |

## What's Reused vs Built

**Reused from BaseMeetingBot (no changes needed):**
- Browser initialization with stealth, CSP bypass, fake media
- RTCPeerConnection hooks and CSRC interception
- Per-participant audio manager and browser inject script
- RecordingOrchestrator (FFmpeg video/audio capture, S3 upload)
- Chat capturer and speaker detector infrastructure
- `humanClick()`, `sleep()`, `takeDebugScreenshot()`, `captureScreenshot()`
- `waitForEnd()` loop with zombie watchdog
- `startRecording()`, `stopRecording()`, `saveRecording()`
- `cleanup()` with full resource teardown

**Needs to be built/rewritten in ZoomBot:**
- URL transformation logic (~30 lines)
- State machine (`detectPageState`) (~60 lines)
- Join retry wrapper (~30 lines, mirrors GoogleMeetBot)
- Updated selector constants (~80 lines, needs live validation)
- Popup handling (~30 lines)
- `waitForMeetingUIReady()` with Zoom selectors (~20 lines)

**Could be extracted to base class (optional refactor):**
- `hasAnySelector()` helper (currently duplicated in GoogleMeetBot)
- `JoinError` class (useful for all platforms)
- `PageState` type (if platforms share the same states)
- `waitForWebRTCReady()` (already would work for Zoom, but lives in GoogleMeetBot)
