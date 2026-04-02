/**
 * Prometheus Metrics
 *
 * Provides production-grade observability via prom-client.
 * Exposes metrics at GET /metrics on the worker's HTTP server.
 */

import { Registry, Gauge, Histogram, Counter, collectDefaultMetrics } from 'prom-client';

// ============================================================================
// Registry
// ============================================================================

export const register = new Registry();

register.setDefaultLabels({ service: 'aramis-bot-worker' });
collectDefaultMetrics({ register });

// ============================================================================
// Custom Metrics
// ============================================================================

/** Number of bot sessions currently active */
export const activeSessions = new Gauge({
  name: 'aramis_active_sessions',
  help: 'Number of bot sessions currently active',
  registers: [register],
});

/** Duration of recorded meetings in seconds */
export const meetingDuration = new Histogram({
  name: 'aramis_meeting_duration_seconds',
  help: 'Duration of recorded meetings in seconds',
  buckets: [60, 300, 600, 1800, 3600, 7200, 14400],
  registers: [register],
});

/** Time taken to join a meeting (JOINING -> RECORDING) in seconds */
export const joinDuration = new Histogram({
  name: 'aramis_join_duration_seconds',
  help: 'Time taken to join a meeting in seconds',
  buckets: [5, 10, 15, 30, 60, 120, 300],
  registers: [register],
});

/** Size of completed recordings in bytes */
export const recordingSize = new Histogram({
  name: 'aramis_recording_size_bytes',
  help: 'Size of completed recordings in bytes',
  buckets: [1e6, 1e7, 5e7, 1e8, 5e8, 1e9],
  registers: [register],
});

/** Total errors by type and phase */
export const errorsTotal = new Counter({
  name: 'aramis_errors_total',
  help: 'Total number of errors by type and phase',
  labelNames: ['error_type', 'phase'] as const,
  registers: [register],
});

/** Number of jobs waiting in each queue */
export const queueDepth = new Gauge({
  name: 'aramis_queue_depth',
  help: 'Number of jobs waiting in each queue',
  labelNames: ['queue'] as const,
  registers: [register],
});

/** Total state transitions by from/to status */
export const stateTransitions = new Counter({
  name: 'aramis_state_transitions_total',
  help: 'Total state transitions by from/to status',
  labelNames: ['from_status', 'to_status'] as const,
  registers: [register],
});

/** Total live transcription segments received */
export const transcriptionSegments = new Counter({
  name: 'aramis_transcription_segments_total',
  help: 'Total live transcription segments received',
  labelNames: ['provider', 'is_final'] as const,
  registers: [register],
});

/** Number of active display allocations */
export const activeDisplays = new Gauge({
  name: 'aramis_active_displays',
  help: 'Number of active Xvfb display allocations',
  registers: [register],
});
