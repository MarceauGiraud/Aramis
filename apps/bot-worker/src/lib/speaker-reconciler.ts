/**
 * SpeakerReconciler
 *
 * Reconciles anonymous Deepgram diarization labels ("Speaker 0", "Speaker 1")
 * with real participant names detected by NativeSpeakerDetector from the meeting DOM.
 *
 * Algorithm: temporal overlap + majority vote
 * 1. Convert DOM speaker events into intervals [startTime, endTime]
 * 2. For each Deepgram segment, compute overlap with each DOM interval
 * 3. Accumulate votes: deepgramLabel -> realName -> totalOverlapSeconds
 * 4. Assign each label to the real name with the highest overlap
 * 5. Apply confidence threshold (reject low-confidence mappings)
 */

import { logger } from './logger';

/**
 * Minimal shape for a DOM speaker event.
 * Compatible with NativeSpeakerDetector's SpeakerEvent (which adds `platform`).
 * Extra fields are ignored.
 */
export interface DomSpeakerEvent {
  speaker: string;
  startTime: number; // seconds relative to recording start
}

interface DomSpeakerInterval {
  speaker: string;
  startTime: number;
  endTime: number;
}

export interface TranscriptSegmentInput {
  speaker?: string;
  startTime: number;
  endTime: number;
}

export interface SpeakerMapping {
  /** Maps Deepgram label (e.g. "Speaker 1") to real name (e.g. "Alice Martin") */
  labelToName: Map<string, string>;
  /** Confidence for each mapping (0-1) */
  confidence: Map<string, number>;
}

const MIN_CONFIDENCE = 0.3;

export class SpeakerReconciler {
  /**
   * Reconcile Deepgram speaker labels with DOM-detected speaker names.
   *
   * Returns a mapping from anonymous labels to real names, with confidence scores.
   * Labels below the confidence threshold are omitted from the mapping.
   *
   * If domTimeline is empty, returns an empty mapping (graceful no-op).
   */
  reconcile(segments: TranscriptSegmentInput[], domTimeline: DomSpeakerEvent[]): SpeakerMapping {
    const result: SpeakerMapping = {
      labelToName: new Map(),
      confidence: new Map(),
    };

    if (domTimeline.length === 0 || segments.length === 0) {
      return result;
    }

    // Step 1: Convert DOM events to intervals
    const domIntervals = this.buildDomIntervals(domTimeline, segments);

    if (domIntervals.length === 0) {
      return result;
    }

    // Step 2: Build vote table via temporal overlap
    // votes: deepgramLabel -> realName -> totalOverlapSeconds
    const votes = new Map<string, Map<string, number>>();

    for (const segment of segments) {
      if (!segment.speaker) continue;

      const label = segment.speaker;
      if (!votes.has(label)) {
        votes.set(label, new Map());
      }
      const labelVotes = votes.get(label)!;

      for (const interval of domIntervals) {
        const overlap = this.computeOverlap(segment.startTime, segment.endTime, interval.startTime, interval.endTime);

        if (overlap > 0) {
          const current = labelVotes.get(interval.speaker) ?? 0;
          labelVotes.set(interval.speaker, current + overlap);
        }
      }
    }

    // Step 3: For each label, pick the name with the highest total overlap
    for (const [label, nameVotes] of votes) {
      let bestName = '';
      let bestOverlap = 0;
      let totalOverlap = 0;

      for (const [name, overlap] of nameVotes) {
        totalOverlap += overlap;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestName = name;
        }
      }

      if (bestName && totalOverlap > 0) {
        const conf = bestOverlap / totalOverlap;
        if (conf >= MIN_CONFIDENCE) {
          result.labelToName.set(label, bestName);
          result.confidence.set(label, conf);
        } else {
          logger.debug(
            `Speaker reconciliation: skipping "${label}" -> "${bestName}" (confidence ${conf.toFixed(2)} < ${MIN_CONFIDENCE})`,
          );
        }
      }
    }

    logger.info(`Speaker reconciliation complete: ${result.labelToName.size} labels mapped from ${votes.size} total`);

    return result;
  }

  /**
   * Reconcile speaker labels using participant tracker data.
   *
   * - 1 non-bot participant → all labels map to that participant
   * - Same number of speakers and participants → positional mapping
   * - Otherwise returns empty mapping (caller should fall back to DOM reconciliation)
   */
  reconcileWithParticipants(
    speakerLabels: string[],
    participants: Array<{ name: string; email?: string; isHost?: boolean }>,
    botNamePattern = /aramis/i,
  ): SpeakerMapping {
    const result: SpeakerMapping = {
      labelToName: new Map(),
      confidence: new Map(),
    };

    const nonBotParticipants = participants.filter((p) => !botNamePattern.test(p.name));
    if (nonBotParticipants.length === 0 || speakerLabels.length === 0) {
      return result;
    }

    // Single participant: map all labels to that person
    if (nonBotParticipants.length === 1) {
      const name = nonBotParticipants[0].name;
      for (const label of speakerLabels) {
        result.labelToName.set(label, name);
        result.confidence.set(label, 1.0);
      }
      logger.info(`Participant reconciliation: single participant "${name}" mapped to ${speakerLabels.length} labels`);
      return result;
    }

    // Same count: positional mapping (low confidence)
    if (nonBotParticipants.length === speakerLabels.length) {
      for (let i = 0; i < speakerLabels.length; i++) {
        result.labelToName.set(speakerLabels[i], nonBotParticipants[i].name);
        result.confidence.set(speakerLabels[i], 0.5);
      }
      logger.info(`Participant reconciliation: positional mapping for ${speakerLabels.length} speakers/participants`);
      return result;
    }

    return result;
  }

  /**
   * Convert a list of speaker change events into non-overlapping intervals.
   * Each event runs from its startTime until the next event's startTime
   * (or the end of the last segment for the final event).
   */
  private buildDomIntervals(events: DomSpeakerEvent[], segments: TranscriptSegmentInput[]): DomSpeakerInterval[] {
    if (events.length === 0) return [];

    // Sort by startTime
    const sorted = [...events].sort((a, b) => a.startTime - b.startTime);

    // Determine the end of the recording (latest segment endTime)
    const recordingEnd = Math.max(...segments.map((s) => s.endTime));

    const intervals: DomSpeakerInterval[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const endTime = i < sorted.length - 1 ? sorted[i + 1].startTime : recordingEnd;

      // Skip zero-length intervals
      if (endTime > sorted[i].startTime) {
        intervals.push({
          speaker: sorted[i].speaker,
          startTime: sorted[i].startTime,
          endTime,
        });
      }
    }

    return intervals;
  }

  /**
   * Compute the overlap in seconds between two intervals [aStart, aEnd] and [bStart, bEnd].
   */
  private computeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
    const start = Math.max(aStart, bStart);
    const end = Math.min(aEnd, bEnd);
    return Math.max(0, end - start);
  }
}
