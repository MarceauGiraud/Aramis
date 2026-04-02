/**
 * Browser-side JavaScript injected via page.addInitScript() to capture
 * per-participant audio from WebRTC using CSRC (Contributing Sources).
 *
 * This follows Attendee's proven approach: each audio track received via
 * RTCPeerConnection is processed independently through a
 * MediaStreamTrackProcessor pipeline. For each non-silent frame, we look up
 * the receiver's getContributingSources() to identify which participant
 * (CSRC source ID) is speaking, then route the audio accordingly.
 *
 * A ReceiverManager intercepts RTCRtpReceiver.prototype.getContributingSources
 * to cache CSRC data so it is always fresh when frames are processed.
 *
 * Audio is downsampled from 48kHz to 16kHz, converted to Int16 PCM, buffered
 * in 100ms chunks (1600 samples = 3200 bytes), and sent via binary WebSocket
 * to ws://localhost:8765. Falls back to window.__aramisPerParticipantAudio
 * (base64 exposeFunction) if the WebSocket is not connected.
 *
 * Prerequisites (set up in base.ts):
 * - window.__aramisAudioTracks: array of { track, receiver, streamId, pc }
 * - window.__aramisMeetingId: set before page navigates (for WS init)
 * - window.__aramisPerParticipantAudio: exposed function (fallback)
 */

export const PER_PARTICIPANT_AUDIO_SCRIPT = `
(function() {
  'use strict';

  // Guard: only run once (addInitScript fires in every frame/iframe)
  if (window.__aramisPerParticipantInjected) return;
  // Only run in the top frame (not iframes like recaptcha, feedback, etc.)
  if (window !== window.top) return;
  window.__aramisPerParticipantInjected = true;

  window.__aramisMeetingId = null;

  var LOG_PREFIX = '[ARAMIS]';
  var TARGET_SAMPLE_RATE = 16000;
  var SOURCE_SAMPLE_RATE = 48000;
  var BUFFER_DURATION_MS = 100;
  var BUFFER_SAMPLE_COUNT = (TARGET_SAMPLE_RATE * BUFFER_DURATION_MS) / 1000; // 1600
  var TRACK_POLL_INTERVAL_MS = 2000;
  var INIT_POLL_INTERVAL_MS = 500;
  var INIT_TIMEOUT_MS = 180000; // 3 min — Teams SPA takes ~70s to load pre-join

  // Track which audio tracks we have already started processing
  var processedTrackIds = {};

  // Log counters to avoid spamming after the first few occurrences
  var pipelineErrorCount = 0;
  var newTrackLogCount = 0;

  // -------------------------------------------------------------------------
  // ReceiverManager: intercepts getContributingSources to cache CSRC data
  // -------------------------------------------------------------------------
  var ReceiverManager = (function() {
    var receiverMap = new Map();

    return {
      updateContributingSources: function(receiver, result) {
        receiverMap.set(receiver, result);
      },
      getContributingSources: function(receiver) {
        return receiverMap.get(receiver) || [];
      }
    };
  })();

  // Intercept RTCRtpReceiver.prototype.getContributingSources
  try {
    var origGetCS = RTCRtpReceiver.prototype.getContributingSources;
    RTCRtpReceiver.prototype.getContributingSources = function() {
      var result = origGetCS.apply(this, arguments);
      ReceiverManager.updateContributingSources(this, result);
      return result;
    };
    console.log(LOG_PREFIX, 'Intercepted RTCRtpReceiver.getContributingSources');
  } catch (e) {
    console.error(LOG_PREFIX, 'Failed to intercept getContributingSources:', e);
  }

  // -------------------------------------------------------------------------
  // Gzip decompression using Chrome's built-in DecompressionStream
  // -------------------------------------------------------------------------
  async function decompressGzip(data) {
    var ds = new DecompressionStream('gzip');
    var writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    var reader = ds.readable.getReader();
    var chunks = [];
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
    var totalLength = chunks.reduce(function(sum, c) { return sum + c.length; }, 0);
    var output = new Uint8Array(totalLength);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      output.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return output;
  }

  // -------------------------------------------------------------------------
  // Minimal protobuf reader (mirrors protobufjs Reader API)
  // -------------------------------------------------------------------------
  function PbReader(buf) {
    this.buf = buf;
    this.pos = 0;
    this.len = buf.length;
  }

  PbReader.create = function(buf) {
    return new PbReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  };

  PbReader.prototype.uint32 = function() {
    var result = 0, shift = 0;
    while (this.pos < this.len) {
      var b = this.buf[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) return result >>> 0;
    }
    return result >>> 0;
  };

  PbReader.prototype.int64 = function() {
    // Read as varint, return as number (safe for values < 2^53)
    var lo = 0, hi = 0, shift = 0;
    while (shift < 28) {
      if (this.pos >= this.len) return lo;
      var b = this.buf[this.pos++];
      lo |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return lo;
      shift += 7;
    }
    // Continue into high bits
    while (shift < 63) {
      if (this.pos >= this.len) break;
      var b = this.buf[this.pos++];
      hi |= (b & 0x7f) << (shift - 28);
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return hi * 0x10000000 + (lo >>> 0);
  };

  PbReader.prototype.string = function() {
    var length = this.uint32();
    var start = this.pos;
    this.pos += length;
    return new TextDecoder().decode(this.buf.subarray(start, start + length));
  };

  PbReader.prototype.bytes = function() {
    var length = this.uint32();
    var start = this.pos;
    this.pos += length;
    return this.buf.subarray(start, start + length);
  };

  PbReader.prototype.skipType = function(wireType) {
    switch (wireType) {
      case 0: // varint
        while (this.pos < this.len && (this.buf[this.pos++] & 0x80) !== 0) {}
        break;
      case 1: // 64-bit
        this.pos += 8;
        break;
      case 2: // length-delimited
        var len = this.uint32();
        this.pos += len;
        break;
      case 5: // 32-bit
        this.pos += 4;
        break;
      default:
        throw new Error('Unknown wire type: ' + wireType);
    }
  };

  // -------------------------------------------------------------------------
  // Message type definitions (exact field numbers from Attendee source)
  // -------------------------------------------------------------------------
  var messageTypes = [
    {
      name: 'CollectionEvent',
      fields: [
        { name: 'body', fieldNumber: 1, type: 'message', messageType: 'CollectionEventBody' }
      ]
    },
    {
      name: 'CollectionEventBody',
      fields: [
        { name: 'userInfoListWrapperAndChatWrapperWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapperAndChatWrapperWrapper' }
      ]
    },
    {
      name: 'UserInfoListWrapperAndChatWrapperWrapper',
      fields: [
        { name: 'deviceInfoWrapper', fieldNumber: 3, type: 'message', messageType: 'DeviceInfoWrapper' },
        { name: 'userInfoListWrapperAndChatWrapper', fieldNumber: 13, type: 'message', messageType: 'UserInfoListWrapperAndChatWrapper' }
      ]
    },
    {
      name: 'UserInfoListWrapperAndChatWrapper',
      fields: [
        { name: 'userInfoListWrapper', fieldNumber: 1, type: 'message', messageType: 'UserInfoListWrapper' }
      ]
    },
    {
      name: 'DeviceInfoWrapper',
      fields: [
        { name: 'deviceOutputInfoList', fieldNumber: 2, type: 'message', messageType: 'DeviceOutputInfoList', repeated: true }
      ]
    },
    {
      name: 'DeviceOutputInfoList',
      fields: [
        { name: 'deviceOutputType', fieldNumber: 2, type: 'varint' },
        { name: 'streamId', fieldNumber: 4, type: 'string' },
        { name: 'deviceId', fieldNumber: 6, type: 'string' },
        { name: 'deviceOutputStatus', fieldNumber: 10, type: 'message', messageType: 'DeviceOutputStatus' }
      ]
    },
    {
      name: 'DeviceOutputStatus',
      fields: [
        { name: 'disabled', fieldNumber: 1, type: 'varint' }
      ]
    },
    {
      name: 'UserInfoListWrapper',
      fields: [
        { name: 'userInfoList', fieldNumber: 2, type: 'message', messageType: 'UserInfoList', repeated: true }
      ]
    },
    {
      name: 'UserInfoList',
      fields: [
        { name: 'deviceId', fieldNumber: 1, type: 'string' },
        { name: 'fullName', fieldNumber: 2, type: 'string' },
        { name: 'status', fieldNumber: 4, type: 'varint' },
        { name: 'isCurrentUserString', fieldNumber: 7, type: 'string' },
        { name: 'parentDeviceId', fieldNumber: 21, type: 'string' },
        { name: 'displayName', fieldNumber: 29, type: 'string' },
        { name: 'isHost', fieldNumber: 34, type: 'varint' }
      ]
    }
  ];

  // Build decoders from message type definitions
  var messageDecoders = {};

  function createMessageDecoder(messageType) {
    return function decode(reader, length) {
      if (!(reader instanceof PbReader)) {
        reader = PbReader.create(reader);
      }
      var end = (length === undefined) ? reader.len : reader.pos + length;
      var message = {};

      while (reader.pos < end) {
        var tag = reader.uint32();
        var fieldNumber = tag >>> 3;
        var wireType = tag & 7;

        var field = null;
        for (var i = 0; i < messageType.fields.length; i++) {
          if (messageType.fields[i].fieldNumber === fieldNumber) {
            field = messageType.fields[i];
            break;
          }
        }

        if (!field) {
          reader.skipType(wireType);
          continue;
        }

        var value;
        switch (field.type) {
          case 'string':
            value = reader.string();
            break;
          case 'int64':
            value = reader.int64();
            break;
          case 'varint':
            value = reader.uint32();
            break;
          case 'message':
            value = messageDecoders[field.messageType](reader, reader.uint32());
            break;
          default:
            reader.skipType(wireType);
            continue;
        }

        if (field.repeated) {
          if (!message[field.name]) {
            message[field.name] = [];
          }
          message[field.name].push(value);
        } else {
          message[field.name] = value;
        }
      }

      return message;
    };
  }

  for (var i = 0; i < messageTypes.length; i++) {
    messageDecoders[messageTypes[i].name] = createMessageDecoder(messageTypes[i]);
  }

  // -------------------------------------------------------------------------
  // handleCollectionEvent: decode gzip-compressed protobuf from data channel
  // -------------------------------------------------------------------------
  function handleCollectionEvent(data) {
    try {
      var collectionEvent = messageDecoders['CollectionEvent'](data);

      var wrapper = collectionEvent.body &&
        collectionEvent.body.userInfoListWrapperAndChatWrapperWrapper;
      if (!wrapper) return;

      // Extract device outputs (streamId mapping)
      var deviceOutputInfoList = wrapper.deviceInfoWrapper &&
        wrapper.deviceInfoWrapper.deviceOutputInfoList;
      if (deviceOutputInfoList && deviceOutputInfoList.length > 0) {
        userManager.updateDeviceOutputs(deviceOutputInfoList);
      }

      // Extract user info list
      var userInfoList = wrapper.userInfoListWrapperAndChatWrapper &&
        wrapper.userInfoListWrapperAndChatWrapper.userInfoListWrapper &&
        wrapper.userInfoListWrapperAndChatWrapper.userInfoListWrapper.userInfoList;
      if (userInfoList && userInfoList.length > 0) {
        userManager.newUsersListSynced(userInfoList);
      }
    } catch (e) {
      // Not all collection messages match our schema, silently skip
    }
  }

  // -------------------------------------------------------------------------
  // UserManager: maps device IDs to participant names and stream IDs
  // Follows Attendee's exact approach for user/device-output tracking.
  // -------------------------------------------------------------------------
  function UserManager() {
    this.allUsersMap = new Map();        // deviceId -> user object
    this.currentUsersMap = new Map();    // deviceId -> user object (current session)
    this.deviceOutputMap = new Map();    // "deviceId-outputType" -> { deviceId, outputType, streamId, disabled }
    this.csrcToDeviceId = new Map();     // CSRC source (string) -> deviceId
    this.currentUserId = null;
  }

  /**
   * Update device outputs from decoded DeviceOutputInfoList messages.
   * The protobuf fields are: deviceId, deviceOutputType, streamId, deviceOutputStatus.disabled
   */
  UserManager.prototype.updateDeviceOutputs = function(deviceOutputs) {
    for (var i = 0; i < deviceOutputs.length; i++) {
      var output = deviceOutputs[i];
      if (!output.deviceId) continue;
      var key = output.deviceId + '-' + (output.deviceOutputType || 0);
      var deviceOutput = {
        deviceId: output.deviceId,
        outputType: output.deviceOutputType || 0,
        streamId: output.streamId || '',
        disabled: (output.deviceOutputStatus && output.deviceOutputStatus.disabled) ? true : false,
        lastUpdated: Date.now()
      };
      this.deviceOutputMap.set(key, deviceOutput);
    }
    console.log(LOG_PREFIX, 'Device outputs updated:', this.deviceOutputMap.size, 'entries');
    // Log streamId mappings for debugging
    for (var entry of this.deviceOutputMap.values()) {
      if (entry.streamId) {
        var user = this.allUsersMap.get(entry.deviceId);
        console.log(LOG_PREFIX, '  streamId:', entry.streamId, '-> deviceId:', entry.deviceId,
          '-> name:', (user ? user.fullName || user.displayName : '(unknown)'),
          'type:', entry.outputType === 1 ? 'AUDIO' : entry.outputType === 2 ? 'VIDEO' : entry.outputType,
          'disabled:', entry.disabled);
      }
    }
  };

  /**
   * Sync a single user update (merges into current user list and calls newUsersListSynced).
   */
  UserManager.prototype.singleUserSynced = function(user) {
    var allUsers = Array.from(this.currentUsersMap.values());
    allUsers.push(user);
    // Deduplicate by deviceId, keeping the latest entry
    var uniqueMap = new Map();
    for (var i = 0; i < allUsers.length; i++) {
      if (allUsers[i].deviceId) {
        uniqueMap.set(allUsers[i].deviceId, allUsers[i]);
      }
    }
    this.newUsersListSynced(Array.from(uniqueMap.values()));
  };

  /**
   * Full user list sync from decoded UserInfoList messages.
   * Follows Attendee's approach: detects current user via isCurrentUserString,
   * updates allUsersMap and currentUsersMap.
   */
  UserManager.prototype.newUsersListSynced = function(newUsersListRaw) {
    var processed = [];
    for (var i = 0; i < newUsersListRaw.length; i++) {
      var user = newUsersListRaw[i];
      if (!user.deviceId) continue;

      // Detect current user from isCurrentUserString field
      if (user.isCurrentUserString && this.currentUserId === null) {
        this.currentUserId = user.deviceId;
        console.log(LOG_PREFIX, 'Current user detected:', user.deviceId, user.fullName || user.displayName);
      }

      processed.push({
        deviceId: user.deviceId,
        displayName: user.displayName || '',
        fullName: user.fullName || '',
        status: user.status || 0,
        parentDeviceId: user.parentDeviceId || null,
        isCurrentUser: user.deviceId === this.currentUserId,
        isHost: !!user.isHost
      });
    }

    // Update allUsersMap (persistent across the whole meeting)
    for (var i = 0; i < processed.length; i++) {
      this.allUsersMap.set(processed[i].deviceId, processed[i]);
    }

    // Update currentUsersMap (tracks current session state)
    this.currentUsersMap.clear();
    for (var i = 0; i < processed.length; i++) {
      this.currentUsersMap.set(processed[i].deviceId, processed[i]);
    }

    console.log(LOG_PREFIX, 'Users synced:', this.allUsersMap.size, 'total,', processed.length, 'in current list');
    for (var i = 0; i < processed.length; i++) {
      var u = processed[i];
      var label = u.isCurrentUser ? '(self)' : '(participant)';
      console.log(LOG_PREFIX, '  user:', u.fullName || u.displayName || '(no name)', 'deviceId:', u.deviceId,
        'status:', u.status, label);

      // When a NEW non-self user arrives, cross-reference with existing device outputs
      // to resolve any previously-unknown streamId mappings
      if (!u.isCurrentUser && (u.fullName || u.displayName)) {
        var name = u.fullName || u.displayName;
        console.log(LOG_PREFIX, 'New participant resolved: "' + name + '" deviceId:', u.deviceId);
        // Check if we have device outputs for this user's deviceId
        for (var entry of this.deviceOutputMap.values()) {
          if (entry.deviceId === u.deviceId && entry.streamId) {
            console.log(LOG_PREFIX, 'Linked participant "' + name + '" to streamId:', entry.streamId,
              'type:', entry.outputType === 1 ? 'AUDIO' : entry.outputType === 2 ? 'VIDEO' : entry.outputType);
          }
        }
      }
    }
  };

  UserManager.prototype.getUserByStreamId = function(streamId) {
    for (var entry of this.deviceOutputMap.values()) {
      if (entry.streamId === streamId) {
        return this.allUsersMap.get(entry.deviceId) || null;
      }
    }
    return null;
  };

  UserManager.prototype.getUserByDeviceId = function(deviceId) {
    return this.allUsersMap.get(deviceId) || null;
  };

  /**
   * Look up a user by CSRC (RTP Contributing Source).
   * First checks the explicit csrcToDeviceId mapping, then falls back to
   * getUserByStreamId (in case CSRC happens to match a protobuf streamId),
   * and finally tries auto-assignment when there is exactly one non-bot
   * participant with an active audio output.
   */
  UserManager.prototype.getUserByCsrc = function(csrcStr) {
    // 1. Check explicit CSRC -> deviceId mapping
    var deviceId = this.csrcToDeviceId.get(csrcStr);
    if (deviceId) {
      return this.allUsersMap.get(deviceId) || null;
    }

    // 2. Try matching CSRC as a protobuf streamId (unlikely but cheap check)
    var byStream = this.getUserByStreamId(csrcStr);
    if (byStream) {
      this.csrcToDeviceId.set(csrcStr, byStream.deviceId);
      return byStream;
    }

    // 3. Auto-assign: collect non-bot participants with active audio outputs
    var candidateDeviceIds = [];
    for (var entry of this.deviceOutputMap.values()) {
      if (entry.outputType === 1 && !entry.disabled && !this.isCurrentUser(entry.deviceId)) {
        var user = this.allUsersMap.get(entry.deviceId);
        if (user && (user.fullName || user.displayName)) {
          candidateDeviceIds.push(entry.deviceId);
        }
      }
    }

    // Exclude deviceIds that are already mapped to a different CSRC
    var alreadyMappedDeviceIds = new Set(this.csrcToDeviceId.values());
    var unmapped = candidateDeviceIds.filter(function(did) {
      return !alreadyMappedDeviceIds.has(did);
    });

    if (unmapped.length === 1) {
      // Only one unmapped participant — this CSRC must be them
      this.csrcToDeviceId.set(csrcStr, unmapped[0]);
      console.log(LOG_PREFIX, 'Auto-assigned CSRC', csrcStr, 'to deviceId:', unmapped[0],
        'name:', (this.allUsersMap.get(unmapped[0]).fullName || this.allUsersMap.get(unmapped[0]).displayName));
      return this.allUsersMap.get(unmapped[0]) || null;
    }

    return null;
  };

  UserManager.prototype.isCurrentUser = function(deviceId) {
    return deviceId === this.currentUserId;
  };

  UserManager.prototype.getAllUsers = function() {
    return Array.from(this.allUsersMap.values());
  };

  UserManager.prototype.deviceForStreamIsActive = function(streamId) {
    for (var entry of this.deviceOutputMap.values()) {
      if (entry.streamId === streamId) {
        return !entry.disabled;
      }
    }
    return false;
  };

  var userManager = new UserManager();
  window.__aramisUserManager = userManager;
  console.log(LOG_PREFIX, 'UserManager initialized and exposed as window.__aramisUserManager');

  // -------------------------------------------------------------------------
  // Teams main-channel message handler
  // Parses dominant speaker history (dsh), captions, and source requests (sr)
  // -------------------------------------------------------------------------
  function handleTeamsMainChannelMessage(rawData) {
    // Teams main-channel sends binary data with embedded JSON
    // Find the JSON payload by scanning for [ or { characters
    var bytes = new Uint8Array(rawData);
    var jsonStart = -1;
    for (var i = 0; i < bytes.length && i < 200; i++) {
      if (bytes[i] === 0x5B || bytes[i] === 0x7B) { // [ or {
        jsonStart = i;
        break;
      }
    }
    if (jsonStart === -1) return;

    var jsonStr = new TextDecoder().decode(bytes.slice(jsonStart));
    // Try to find valid JSON by trimming trailing garbage
    var parsed = null;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      // Try trimming at last } or ]
      var lastBrace = Math.max(jsonStr.lastIndexOf('}'), jsonStr.lastIndexOf(']'));
      if (lastBrace > 0) {
        try {
          parsed = JSON.parse(jsonStr.substring(0, lastBrace + 1));
        } catch (e2) {
          return;
        }
      }
    }
    if (!parsed) return;

    // Handle array of messages
    var messages = Array.isArray(parsed) ? parsed : [parsed];
    for (var m = 0; m < messages.length; m++) {
      var item = messages[m];
      if (!item || !item.type) continue;

      // Dominant Speaker History
      if (item.type === 'dsh' && item.history) {
        var dominantStreamId = item.history[0];
        console.log(LOG_PREFIX, 'Dominant speaker:', dominantStreamId);
        // Store for audio attribution
        window.__aramisDominantSpeaker = {
          streamId: dominantStreamId,
          timestamp: Date.now()
        };
        // Send to backend
        sendTeamsSignal({
          type: 'DominantSpeaker',
          streamId: dominantStreamId,
          history: item.history
        });
      }

      // Closed Captions (recognitionResults)
      if (item.type === 'recognitionResults' || item.recognitionResults) {
        var results = item.recognitionResults || [item];
        for (var r = 0; r < results.length; r++) {
          var caption = results[r];
          if (caption.text) {
            sendTeamsSignal({
              type: 'Caption',
              userId: caption.userId || caption.participantId || '',
              text: caption.text,
              isFinal: !!caption.isFinal,
              timestamp: caption.timestampAudioSent || Date.now()
            });
          }
        }
      }

      // Source Request (sr) — maps stream MSIDs to source IDs
      if (item.type === 'sr' && item.streams) {
        for (var s = 0; s < item.streams.length; s++) {
          var stream = item.streams[s];
          if (stream.streamMsid && stream.sourceId) {
            if (!window.__aramisStreamMap) window.__aramisStreamMap = {};
            window.__aramisStreamMap[stream.streamMsid] = stream.sourceId;
          }
        }
        sendTeamsSignal({
          type: 'SourceRequest',
          streams: item.streams
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Data channel interception: capture Google Meet's "collections" channel
  // -------------------------------------------------------------------------
  try {
    var OrigRTCPeerConnection = window.RTCPeerConnection;
    var origAddEventListener = RTCPeerConnection.prototype.addEventListener;

    RTCPeerConnection.prototype.addEventListener = function(type, listener, options) {
      origAddEventListener.call(this, type, listener, options);

      // Also add our own datachannel listener on the first call
      if (type === 'track' && !this.__aramisDataChannelHooked) {
        this.__aramisDataChannelHooked = true;
        var pc = this;
        origAddEventListener.call(this, 'datachannel', function(event) {
          var label = event.channel.label;

          if (label === 'collections') {
            console.log(LOG_PREFIX, 'Collections data channel intercepted');
            event.channel.addEventListener('message', async function(msgEvent) {
              try {
                var data = new Uint8Array(msgEvent.data);
                var decompressed = await decompressGzip(data);
                handleCollectionEvent(decompressed);
              } catch (e) {
                // Not all messages are collection events, errors are expected
              }
            });
          }

          // Teams main-channel: carries dominant speaker, captions, source requests
          if (label === 'main-channel' || label === 'reliable-datachannel') {
            console.log(LOG_PREFIX, 'Teams main-channel data channel intercepted:', label);
            event.channel.addEventListener('message', function(msgEvent) {
              try {
                handleTeamsMainChannelMessage(msgEvent.data);
              } catch (e) {
                // Not all messages are parseable
              }
            });
          }
        });
      }
    };

    console.log(LOG_PREFIX, 'RTCPeerConnection.addEventListener intercepted for data channels');
  } catch (e) {
    console.warn(LOG_PREFIX, 'Failed to intercept RTCPeerConnection for data channels:', e);
  }

  // -------------------------------------------------------------------------
  // Fetch interception: secondary source for participant data
  // -------------------------------------------------------------------------
  try {
    var origFetch = window.fetch;
    window.fetch = async function() {
      var args = arguments;
      var response = await origFetch.apply(this, args);
      try {
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        if (url.indexOf('SyncMeetingSpaceCollections') !== -1) {
          var clone = response.clone();
          clone.arrayBuffer().then(function(buf) {
            try {
              var bytes = new Uint8Array(buf);
              handleCollectionEvent(bytes);
            } catch (e) {}
          }).catch(function() {});
        }
      } catch (e) {}
      return response;
    };
    console.log(LOG_PREFIX, 'Fetch intercepted for SyncMeetingSpaceCollections');
  } catch (e) {
    console.warn(LOG_PREFIX, 'Failed to intercept fetch:', e);
  }

  // -------------------------------------------------------------------------
  // Binary WebSocket for per-participant audio transport
  // (replaces base64 exposeFunction which has 33% overhead + CDP latency)
  // -------------------------------------------------------------------------
  var audioWs = null;
  var AUDIO_WS_URL = 'ws://localhost:8765';
  var MESSAGE_TYPE_PER_PARTICIPANT_AUDIO = 100;

  var wsReconnectAttempts = 0;
  var MAX_WS_RECONNECTS = 5;

  function connectAudioWs() {
    if (wsReconnectAttempts >= MAX_WS_RECONNECTS) {
      console.log(LOG_PREFIX, 'Max WebSocket reconnect attempts reached, using exposeFunction fallback');
      return;
    }
    wsReconnectAttempts++;

    try {
      audioWs = new WebSocket(AUDIO_WS_URL);
      audioWs.binaryType = 'arraybuffer';

      audioWs.onopen = function() {
        wsReconnectAttempts = 0; // reset on success
        console.log(LOG_PREFIX, 'Audio WebSocket connected');
        // Send init message to identify this as a per-participant audio source
        audioWs.send(JSON.stringify({ type: 'per-participant-init', meetingId: window.__aramisMeetingId || 'unknown' }));
      };

      audioWs.onclose = function() {
        if (wsReconnectAttempts === 0) {
          console.log(LOG_PREFIX, 'Audio WebSocket closed, reconnecting in 2s...');
        }
        setTimeout(connectAudioWs, 2000);
      };

      audioWs.onerror = function(err) {
        console.warn(LOG_PREFIX, 'Audio WebSocket error');
      };
    } catch (e) {
      console.warn(LOG_PREFIX, 'Could not connect audio WebSocket:', e);
      setTimeout(connectAudioWs, 2000);
    }
  }

  connectAudioWs();

  // Shared signal sender for Teams data channel messages
  function sendTeamsSignal(data) {
    try {
      if (typeof audioWs !== 'undefined' && audioWs && audioWs.readyState === 1) {
        var jsonString = JSON.stringify(data);
        var jsonBytes = new TextEncoder().encode(jsonString);
        var message = new Uint8Array(4 + jsonBytes.length);
        var view = new DataView(message.buffer);
        view.setInt32(0, 1, true);
        message.set(jsonBytes, 4);
        audioWs.send(message.buffer);
      }
    } catch (e) {
      console.error(LOG_PREFIX, 'Failed to send Teams signal:', e);
    }
  }

  // ============================================================
  // Teams WebSocket Interceptor
  // Intercepts Teams' internal WebSocket messages to detect:
  //   - conversationEnd → meeting ended
  //   - rosterUpdate → participant joins/leaves
  // This gives us instant meeting-end detection without DOM polling.
  // Inspired by Attendee (https://github.com/attendee-labs/attendee)
  // ============================================================

  (function setupTeamsWebSocketInterceptor() {
    // Only activate for Teams meetings
    if (!window.location.hostname.includes('teams.microsoft.com') &&
        !window.location.hostname.includes('teams.live.com')) {
      return;
    }

    var OriginalWebSocket = window.WebSocket;

    // Send a JSON signal to our backend via the existing audio WebSocket
    function sendSignal(data) {
      try {
        // Use the audioWs connection if available
        if (typeof audioWs !== 'undefined' && audioWs && audioWs.readyState === 1) {
          // Binary protocol: [4 bytes type=1 (JSON)][JSON payload]
          var jsonString = JSON.stringify(data);
          var jsonBytes = new TextEncoder().encode(jsonString);
          var message = new Uint8Array(4 + jsonBytes.length);
          var view = new DataView(message.buffer);
          view.setInt32(0, 1, true); // type 1 = JSON
          message.set(jsonBytes, 4);
          audioWs.send(message.buffer);
          console.log(LOG_PREFIX, 'Sent signal:', data.type, data.change || '');
        }
      } catch (e) {
        console.error(LOG_PREFIX, 'Failed to send signal:', e);
      }
    }

    // Decode base64+gzip compressed WebSocket body (used by Teams for roster data)
    // Uses Chrome's native DecompressionStream API (no external library needed)
    async function decodeWebSocketBody(encodedData) {
      try {
        var byteArray = Uint8Array.from(atob(encodedData), function(c) { return c.charCodeAt(0); });

        // Method 1: pako if available
        if (typeof pako !== 'undefined') {
          return JSON.parse(pako.inflate(byteArray, { to: 'string' }));
        }

        // Method 2: Chrome native DecompressionStream (available since Chrome 80+)
        if (typeof DecompressionStream !== 'undefined') {
          var ds = new DecompressionStream('gzip');
          var writer = ds.writable.getWriter();
          var reader = ds.readable.getReader();
          writer.write(byteArray);
          writer.close();
          var chunks = [];
          while (true) {
            var result = await reader.read();
            if (result.done) break;
            chunks.push(result.value);
          }
          var totalLength = chunks.reduce(function(acc, c) { return acc + c.length; }, 0);
          var merged = new Uint8Array(totalLength);
          var offset = 0;
          for (var i = 0; i < chunks.length; i++) {
            merged.set(chunks[i], offset);
            offset += chunks[i].length;
          }
          return JSON.parse(new TextDecoder().decode(merged));
        }

        // Method 3: try raw JSON parse (some messages aren't compressed)
        return JSON.parse(new TextDecoder().decode(byteArray));
      } catch (e) {
        console.error(LOG_PREFIX, 'Failed to decode WebSocket body:', e);
        return null;
      }
    }

    async function handleConversationEnd(eventDataObject) {
      var body = {};
      try {
        body = JSON.parse(eventDataObject.body);
      } catch (e) {
        try {
          body = await decodeWebSocketBody(eventDataObject.body);
        } catch (e2) {
          // Couldn't parse body
        }
      }

      var subCode = body && body.subCode;
      console.log(LOG_PREFIX, 'conversationEnd detected, subCode:', subCode);

      if (subCode === 5854) {
        sendSignal({ type: 'MeetingStatusChange', change: 'request_to_join_denied' });
        return;
      }
      if (subCode === 5723) {
        sendSignal({ type: 'MeetingStatusChange', change: 'anonymous_join_disabled' });
        return;
      }

      // Default: meeting actually ended
      sendSignal({ type: 'MeetingStatusChange', change: 'meeting_ended' });
    }

    async function handleRosterUpdate(eventDataObject) {
      try {
        var decodedBody = await decodeWebSocketBody(eventDataObject.body);
        if (!decodedBody || !decodedBody.participants) return;

        var participants = Object.values(decodedBody.participants).filter(function(p) {
          return p.details && p.details.displayName;
        });

        var activeCount = 0;
        var participantNames = [];
        for (var i = 0; i < participants.length; i++) {
          var p = participants[i];
          var isActive = p.state === 'active';
          if (isActive) {
            activeCount++;
            participantNames.push(p.details.displayName);
          }
        }

        console.log(LOG_PREFIX, 'Roster update: ' + activeCount + ' active participants:', participantNames.join(', '));

        sendSignal({
          type: 'RosterUpdate',
          activeParticipantCount: activeCount,
          participants: participants.map(function(p) {
            return {
              deviceId: p.details.id,
              displayName: p.details.displayName,
              state: p.state,
              isActive: p.state === 'active',
            };
          })
        });
      } catch (e) {
        console.error(LOG_PREFIX, 'Error handling roster update:', e);
      }
    }

    // Replace window.WebSocket with a proxy that intercepts Teams signaling
    window.WebSocket = function(url, protocols) {
      var ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);

      ws.addEventListener('message', function(event) {
        try {
          var data = event.data;
          if (typeof data === 'string' && data.startsWith('3:::')) {
            var eventDataObject = JSON.parse(data.slice(4));

            if (eventDataObject.url && eventDataObject.url.endsWith('rosterUpdate/')) {
              handleRosterUpdate(eventDataObject);
            }
            if (eventDataObject.url && eventDataObject.url.endsWith('conversation/conversationEnd/')) {
              handleConversationEnd(eventDataObject);
            }
          }
        } catch (e) {
          // Silently ignore parsing errors on non-signaling messages
        }
      });

      return ws;
    };

    // Preserve prototype chain
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

    console.log(LOG_PREFIX, 'Teams WebSocket interceptor installed');
  })();

  // -------------------------------------------------------------------------
  // Teams callManager integration for authoritative CSRC-to-participant mapping
  // -------------------------------------------------------------------------
  function getTeamsCallManager() {
    try {
      // Try multiple paths to access Teams' internal calling state
      var call = null;
      if (window.callingDebug && window.callingDebug.observableCall) {
        call = window.callingDebug.observableCall;
      } else if (window.msteamscalling) {
        try {
          var service = window.msteamscalling.deref().callingService;
          call = service.getActiveCall();
        } catch (e) {}
      }
      return call;
    } catch (e) {
      return null;
    }
  }

  // Resolve CSRC source ID to participant name using Teams internal API
  function resolveCSRCViaCallManager(csrcSource) {
    var call = getTeamsCallManager();
    if (!call || !call.participants) return null;

    try {
      var participants = call.participants;
      for (var i = 0; i < participants.length; i++) {
        var p = participants[i];
        if (p.hasAudioSource && p.hasAudioSource(csrcSource)) {
          return {
            deviceId: p.id || p.deviceId,
            displayName: p.displayName || (p.details && p.details.displayName) || 'Unknown',
          };
        }
      }
    } catch (e) {}
    return null;
  }

  // Expose for use by the audio pipeline
  window.__aramisResolveCSRC = resolveCSRCViaCallManager;

  // -------------------------------------------------------------------------
  // Teams WebRTC Video Capture
  // Captures raw video from the dominant speaker's video track using
  // MediaRecorder, sending WebM chunks to the backend via WebSocket.
  // This replaces FFmpeg x11grab for Teams with higher quality video.
  // -------------------------------------------------------------------------

  var MESSAGE_TYPE_VIDEO_CHUNK = 200;
  var activeVideoRecorder = null;
  var activeVideoTrack = null;

  function startWebRTCVideoCapture(videoTrack) {
    if (activeVideoRecorder) {
      try { activeVideoRecorder.stop(); } catch (e) {}
    }
    activeVideoTrack = videoTrack;

    var stream = new MediaStream([videoTrack]);

    // Try VP9 first, fall back to VP8
    var mimeType = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm;codecs=vp8';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm';
    }

    var recorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      videoBitsPerSecond: 2000000, // 2 Mbps
    });
    activeVideoRecorder = recorder;

    recorder.ondataavailable = function(event) {
      if (event.data && event.data.size > 0 && audioWs && audioWs.readyState === 1) {
        event.data.arrayBuffer().then(function(buffer) {
          // Binary protocol: [4 bytes type=200][video chunk data]
          var chunk = new Uint8Array(buffer);
          var message = new Uint8Array(4 + chunk.length);
          var view = new DataView(message.buffer);
          view.setInt32(0, MESSAGE_TYPE_VIDEO_CHUNK, true);
          message.set(chunk, 4);
          audioWs.send(message.buffer);
        });
      }
    };

    recorder.onerror = function(e) {
      console.error(LOG_PREFIX, 'MediaRecorder error:', e);
    };

    // Request data every 1 second
    recorder.start(1000);
    console.log(LOG_PREFIX, 'WebRTC video capture started:', mimeType);

    // Send init signal to backend
    sendTeamsSignal({
      type: 'WebRTCVideoStart',
      mimeType: mimeType,
      width: videoTrack.getSettings().width || 1280,
      height: videoTrack.getSettings().height || 720,
    });

    videoTrack.addEventListener('ended', function() {
      console.log(LOG_PREFIX, 'Video track ended, stopping MediaRecorder');
      try { recorder.stop(); } catch (e) {}
      activeVideoRecorder = null;
      sendTeamsSignal({ type: 'WebRTCVideoStop' });
    });
  }

  function stopWebRTCVideoCapture() {
    if (activeVideoRecorder) {
      try { activeVideoRecorder.stop(); } catch (e) {}
      activeVideoRecorder = null;
      sendTeamsSignal({ type: 'WebRTCVideoStop' });
    }
  }

  // Expose for control from Node.js
  window.__aramisStartVideoCapture = startWebRTCVideoCapture;
  window.__aramisStopVideoCapture = stopWebRTCVideoCapture;

  /**
   * Send per-participant audio as a binary WebSocket message.
   * Falls back to exposeFunction (base64) if WebSocket is not connected.
   *
   * Binary message format:
   * [4 bytes: int32 type = 100]
   * [1 byte: speakerId length]
   * [N bytes: speakerId UTF-8]
   * [remaining: Int16 PCM samples]
   */
  function sendBinaryAudio(speakerId, int16Array) {
    if (!audioWs || audioWs.readyState !== WebSocket.OPEN) {
      // Fallback to exposeFunction if WebSocket not connected
      if (window.__aramisPerParticipantAudio) {
        var base64 = int16ToBase64(int16Array);
        window.__aramisPerParticipantAudio(speakerId, base64);
      }
      return;
    }

    var idBytes = new TextEncoder().encode(speakerId);
    var headerSize = 4 + 1 + idBytes.length;
    var message = new Uint8Array(headerSize + int16Array.buffer.byteLength);
    var view = new DataView(message.buffer);

    view.setInt32(0, MESSAGE_TYPE_PER_PARTICIPANT_AUDIO, true); // little-endian
    view.setUint8(4, idBytes.length);
    message.set(idBytes, 5);
    message.set(new Uint8Array(int16Array.buffer), headerSize);

    audioWs.send(message.buffer);
  }

  // Track which speakers we have already logged names for
  var loggedUsers = {};

  // -------------------------------------------------------------------------
  // Audio processing utilities
  // -------------------------------------------------------------------------

  /**
   * Downsample from sourceRate to targetRate with linear interpolation.
   */
  function downsample(samples, sourceRate, targetRate) {
    if (sourceRate === targetRate) return samples;

    var ratio = sourceRate / targetRate;
    var outputLength = Math.floor(samples.length / ratio);
    var output = new Float32Array(outputLength);

    for (var i = 0; i < outputLength; i++) {
      var srcIndex = i * ratio;
      var srcIndexFloor = Math.floor(srcIndex);
      var srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
      var frac = srcIndex - srcIndexFloor;

      output[i] = samples[srcIndexFloor] * (1 - frac) + samples[srcIndexCeil] * frac;
    }

    return output;
  }

  /**
   * Convert Float32 [-1, 1] samples to Int16 [-32768, 32767] PCM.
   */
  function float32ToInt16(float32Array) {
    var int16 = new Int16Array(float32Array.length);
    for (var i = 0; i < float32Array.length; i++) {
      var s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  /**
   * Base64-encode an Int16Array (as its underlying ArrayBuffer bytes).
   */
  function int16ToBase64(int16Array) {
    var bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
    var binary = '';
    var chunkSize = 8192;
    for (var offset = 0; offset < bytes.length; offset += chunkSize) {
      var slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
  }

  // -------------------------------------------------------------------------
  // handleAudioTrack: sets up a MediaStreamTrackProcessor + TransformStream
  // pipeline for one audio track, using CSRC to identify the speaker
  // -------------------------------------------------------------------------
  function handleAudioTrack(trackEntry) {
    var track = trackEntry.track;
    var receiver = trackEntry.receiver;
    var streamId = trackEntry.streamId;
    var trackId = track.id;

    if (processedTrackIds[trackId]) {
      return;
    }
    processedTrackIds[trackId] = true;

    // Check for MediaStreamTrackProcessor support
    if (typeof MediaStreamTrackProcessor === 'undefined') {
      console.warn(LOG_PREFIX, 'MediaStreamTrackProcessor not available. Per-participant audio capture disabled.');
      return;
    }

    if (track.readyState !== 'live') {
      console.warn(LOG_PREFIX, 'Skipping ended track:', trackId, 'streamId:', streamId);
      delete processedTrackIds[trackId];
      return;
    }

    console.log(LOG_PREFIX, 'Processing audio track:', trackId, 'streamId:', streamId);

    // Per-speaker PCM buffers: speakerId -> { buffer: Int16Array, offset: number }
    var speakerBuffers = {};
    var lastSpeakerId = null;

    function getOrCreateBuffer(speakerId) {
      if (!speakerBuffers[speakerId]) {
        speakerBuffers[speakerId] = {
          buffer: new Int16Array(BUFFER_SAMPLE_COUNT),
          offset: 0
        };
      }
      return speakerBuffers[speakerId];
    }

    function flushBuffer(speakerId) {
      var buf = speakerBuffers[speakerId];
      if (!buf || buf.offset === 0) return;

      var toSend = buf.offset < BUFFER_SAMPLE_COUNT
        ? buf.buffer.slice(0, buf.offset)
        : buf.buffer;

      try {
        sendBinaryAudio(speakerId, toSend);
      } catch (e) {
        console.warn(LOG_PREFIX, 'Error sending audio for speaker', speakerId, ':', e);
      }

      buf.offset = 0;
    }

    function flushAllBuffers() {
      var ids = Object.keys(speakerBuffers);
      for (var i = 0; i < ids.length; i++) {
        flushBuffer(ids[i]);
      }
    }

    var processor;
    try {
      processor = new MediaStreamTrackProcessor({ track: track });
    } catch (e) {
      console.error(LOG_PREFIX, 'Failed to create MediaStreamTrackProcessor:', e);
      delete processedTrackIds[trackId];
      return;
    }

    var generator = new MediaStreamTrackGenerator({ kind: 'audio' });

    var transformStream = new TransformStream({
      transform: function(frame, controller) {
        try {
          var numChannels = frame.numberOfChannels;
          var numSamples = frame.numberOfFrames;
          var sampleRate = frame.sampleRate || SOURCE_SAMPLE_RATE;

          // 1. Extract mono audio
          var audioData = new Float32Array(numSamples);

          if (numChannels > 1) {
            var channelData = new Float32Array(numSamples);
            for (var ch = 0; ch < numChannels; ch++) {
              frame.copyTo(channelData, { planeIndex: ch });
              for (var i = 0; i < numSamples; i++) {
                audioData[i] += channelData[i];
              }
            }
            for (var i = 0; i < numSamples; i++) {
              audioData[i] /= numChannels;
            }
          } else {
            frame.copyTo(audioData, { planeIndex: 0 });
          }

          // 2. Skip all-zero frames (silence)
          var allZero = true;
          for (var i = 0; i < audioData.length; i++) {
            if (audioData[i] !== 0) {
              allZero = false;
              break;
            }
          }

          if (allZero) {
            controller.enqueue(frame);
            return;
          }

          // 3. Identify speaker via CSRC
          var contributingSources = ReceiverManager.getContributingSources(receiver);
          var sorted = [];
          for (var i = 0; i < contributingSources.length; i++) {
            var s = contributingSources[i];
            if (s.source !== 0) {
              sorted.push(s);
            }
          }
          sorted.sort(function(a, b) {
            return (b.audioLevel || 0) - (a.audioLevel || 0);
          });

          var dominantSource = sorted[0];

          if (dominantSource && dominantSource.source) {
            var csrcSource = String(dominantSource.source);
            var speakerId = csrcSource;

            // Try Teams callManager first (most authoritative)
            if (window.__aramisResolveCSRC) {
              var resolved = window.__aramisResolveCSRC(csrcSource);
              if (resolved) {
                speakerId = resolved.displayName || resolved.deviceId;
              }
            }

            // Fall back to UserManager CSRC lookup if callManager didn't resolve
            if (speakerId === csrcSource) {
              var user = userManager.getUserByCsrc(csrcSource);
              speakerId = user ? user.deviceId : csrcSource;
            } else {
              var user = null; // resolved via callManager, skip UserManager
            }

            // Log real name on first encounter
            if (user && !loggedUsers[speakerId]) {
              console.log(LOG_PREFIX, 'Speaker identified:', user.fullName || user.displayName, 'deviceId:', speakerId);
              loggedUsers[speakerId] = true;
            }

            // 4. If speaker changed, flush the previous speaker's buffer
            if (lastSpeakerId !== null && lastSpeakerId !== speakerId) {
              flushBuffer(lastSpeakerId);
            }
            lastSpeakerId = speakerId;

            // 5. Downsample from 48kHz to 16kHz
            var downsampled = downsample(audioData, sampleRate, TARGET_SAMPLE_RATE);

            // 6. Convert Float32 to Int16 PCM
            var int16Samples = float32ToInt16(downsampled);

            // 7. Buffer and flush when full
            var buf = getOrCreateBuffer(speakerId);
            var samplesRemaining = int16Samples.length;
            var srcOffset = 0;

            while (samplesRemaining > 0) {
              var spaceInBuffer = BUFFER_SAMPLE_COUNT - buf.offset;
              var toCopy = Math.min(samplesRemaining, spaceInBuffer);

              buf.buffer.set(
                int16Samples.subarray(srcOffset, srcOffset + toCopy),
                buf.offset
              );
              buf.offset += toCopy;
              srcOffset += toCopy;
              samplesRemaining -= toCopy;

              if (buf.offset >= BUFFER_SAMPLE_COUNT) {
                flushBuffer(speakerId);
              }
            }
          }

          controller.enqueue(frame);
        } catch (e) {
          console.warn(LOG_PREFIX, 'Error processing audio frame:', e);
          try { controller.enqueue(frame); } catch (_) {}
        }
      }
    });

    // Handle track ending
    track.addEventListener('ended', function() {
      console.log(LOG_PREFIX, 'Track ended:', trackId, 'streamId:', streamId);
      flushAllBuffers();
      delete processedTrackIds[trackId];
    });

    // Pipe the processor through the transform into the generator
    processor.readable
      .pipeThrough(transformStream)
      .pipeTo(generator.writable)
      .catch(function(e) {
        pipelineErrorCount++;
        if (pipelineErrorCount <= 3) {
          console.warn(LOG_PREFIX, 'Pipeline error for track', trackId, ':', e);
        }
        flushAllBuffers();
        delete processedTrackIds[trackId];
      });

    console.log(LOG_PREFIX, 'Pipeline started for track:', trackId, 'streamId:', streamId);
  }

  // -------------------------------------------------------------------------
  // startCapture: processes existing tracks and polls for new ones
  // -------------------------------------------------------------------------
  function startCapture() {
    console.log(LOG_PREFIX, 'Starting per-participant audio capture (CSRC mode)');

    var audioTracks = window.__aramisAudioTracks;
    if (audioTracks && audioTracks.length > 0) {
      console.log(LOG_PREFIX, 'Found', audioTracks.length, 'initial audio tracks');
      for (var i = 0; i < audioTracks.length; i++) {
        handleAudioTrack(audioTracks[i]);
      }
    }

    // Poll for new tracks that arrive after initial capture starts
    var pollInterval = setInterval(function() {
      try {
        var tracks = window.__aramisAudioTracks;
        if (!tracks) return;

        for (var i = 0; i < tracks.length; i++) {
          var entry = tracks[i];
          if (entry.track && !processedTrackIds[entry.track.id]) {
            if (entry.track.readyState === 'live') {
              newTrackLogCount++;
              if (newTrackLogCount <= 5) {
                console.log(LOG_PREFIX, 'New audio track detected, processing...');
              }
              handleAudioTrack(entry);
            }
          }
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Error polling for new tracks:', e);
      }
    }, TRACK_POLL_INTERVAL_MS);

    // Store cleanup handle
    window.__aramisPPACleanup = function() {
      clearInterval(pollInterval);
      console.log(LOG_PREFIX, 'Stopped polling for new audio tracks');
    };
  }

  // -------------------------------------------------------------------------
  // UI cleanup: hide bot vignette and non-essential chrome for clean recording
  // -------------------------------------------------------------------------
  function cleanupUIForRecording() {
    try {
      var style = document.createElement('style');
      style.id = 'aramis-ui-cleanup';
      style.textContent =
        // Hide self-view / bot's own video tile
        '[data-self-name] { display: none !important; }' +
        // Hide the small floating self-view (picture-in-picture)
        '[data-allocation-index][data-self-name] { display: none !important; }' +
        '[data-is-local-user="true"] { display: none !important; }' +
        // Hide bottom toolbar (controls bar)
        '[jscontroller="kAPMuc"] > div:last-child { opacity: 0 !important; pointer-events: none !important; }' +
        // Hide top bar (meeting title / info)
        '[data-meeting-title] { opacity: 0 !important; }' +
        // Hide captions overlay
        '[jscontroller="D1tHje"] { display: none !important; }' +
        // Hide notification toasts
        '.google-material-color-100 { display: none !important; }' +
        // Hide "You are presenting" bar and similar banners
        '[data-call-ended], [data-recording-indicator] { display: none !important; }';
      document.head.appendChild(style);
      console.log(LOG_PREFIX, 'UI cleanup CSS injected for clean recording');
    } catch (e) {
      console.warn(LOG_PREFIX, 'Failed to inject UI cleanup CSS:', e);
    }
  }

  // -------------------------------------------------------------------------
  // Auto-start: wait for __aramisAudioTracks to be populated
  // -------------------------------------------------------------------------
  var initAttempts = 0;
  var maxInitAttempts = INIT_TIMEOUT_MS / INIT_POLL_INTERVAL_MS; // 120 = 60s at 500ms

  var initInterval = setInterval(function() {
    initAttempts++;

    try {
      var tracks = window.__aramisAudioTracks;
      if (tracks && tracks.length > 0) {
        clearInterval(initInterval);
        console.log(LOG_PREFIX, 'Audio tracks detected after', initAttempts, 'polls (' + (initAttempts * INIT_POLL_INTERVAL_MS / 1000) + 's). Starting capture.');
        cleanupUIForRecording();
        startCapture();
        return;
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Error checking for audio tracks:', e);
    }

    if (initAttempts >= maxInitAttempts) {
      clearInterval(initInterval);
      console.warn(LOG_PREFIX, 'Timed out waiting for audio tracks after', INIT_TIMEOUT_MS / 1000, 'seconds.');
    }
  }, INIT_POLL_INTERVAL_MS);

  // -------------------------------------------------------------------------
  // Auto-start WebRTC video capture for Teams when IN THE MEETING
  // (not during pre-join — the pre-join camera preview track ends immediately)
  // -------------------------------------------------------------------------
  if (window.location.hostname.includes('teams.microsoft.com') ||
      window.location.hostname.includes('teams.live.com')) {
    var videoCapturePollCount = 0;
    var videoCaptureStarted = false;
    console.log(LOG_PREFIX, 'Teams video capture polling started');
    var videoCaptureInterval = setInterval(function() {
      videoCapturePollCount++;
      if (videoCaptureStarted) { clearInterval(videoCaptureInterval); return; }
      if (videoCapturePollCount > 1200) {
        console.log(LOG_PREFIX, 'Video capture polling timed out after 10 minutes');
        clearInterval(videoCaptureInterval);
        return;
      }

      // Log every 10s for debugging
      if (videoCapturePollCount % 20 === 0) {
        var hangupCheck = document.querySelector('[data-inp="hangup-button"], #hangup-button, [data-tid="hangup-button"], button[id*="hangup"], [id*="hangup"]');
        var pcCount = (window.__aramisPeerConnections || []).length;
        var videoTracks = 0;
        var pcsCheck = window.__aramisPeerConnections || [];
        for (var ci = 0; ci < pcsCheck.length; ci++) {
          try {
            var recvs = pcsCheck[ci].pc.getReceivers();
            for (var ri = 0; ri < recvs.length; ri++) {
              if (recvs[ri].track && recvs[ri].track.kind === 'video') videoTracks++;
            }
          } catch (e) {}
        }
        console.log(LOG_PREFIX, 'Video poll #' + videoCapturePollCount + ': hangup=' + !!hangupCheck + ', pcs=' + pcCount + ', videoTracks=' + videoTracks);
      }

      // Check if we're in the meeting - try multiple hangup selectors
      var hangup = document.querySelector('[data-inp="hangup-button"], #hangup-button, [data-tid="hangup-button"], button[id*="hangup"], [id*="hangup"]');
      if (!hangup) return; // Still in pre-join or lobby, wait

      console.log(LOG_PREFIX, 'Hangup button found, looking for video tracks...');

      var pcs = window.__aramisPeerConnections || [];
      for (var i = 0; i < pcs.length; i++) {
        var entry = pcs[i];
        if (!entry.pc || !entry.pc.getReceivers) continue;
        var receivers = entry.pc.getReceivers();
        for (var r = 0; r < receivers.length; r++) {
          var track = receivers[r].track;
          if (track && track.kind === 'video' && track.readyState === 'live' && !videoCaptureStarted) {
            console.log(LOG_PREFIX, 'In meeting — found live video track, starting WebRTC capture');
            videoCaptureStarted = true;
            startWebRTCVideoCapture(track);
            clearInterval(videoCaptureInterval);
            return;
          }
        }
      }
      console.log(LOG_PREFIX, 'Hangup found but no live video tracks yet');
    }, 500);
  }

  console.log(LOG_PREFIX, 'Injection complete. ReceiverManager active. Waiting for audio tracks...');
})();
`;
