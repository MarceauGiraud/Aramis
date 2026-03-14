/**
 * Simple in-memory metrics collector with histogram support.
 */

interface HistogramData {
  values: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
}

interface HistogramSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export class MetricsCollector {
  private histograms: Map<string, HistogramData> = new Map();
  private maxValues: number;

  constructor(maxValues: number = 10000) {
    this.maxValues = maxValues;
  }

  /**
   * Track a duration measurement for a named metric.
   */
  track(name: string, durationMs: number): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = { values: [], count: 0, sum: 0, min: Infinity, max: -Infinity };
      this.histograms.set(name, histogram);
    }

    histogram.values.push(durationMs);
    histogram.count++;
    histogram.sum += durationMs;
    histogram.min = Math.min(histogram.min, durationMs);
    histogram.max = Math.max(histogram.max, durationMs);

    // Evict oldest values if over limit
    if (histogram.values.length > this.maxValues) {
      histogram.values = histogram.values.slice(-this.maxValues);
    }
  }

  /**
   * Get histogram summary with percentiles for a named metric.
   */
  getHistogram(name: string): HistogramSummary | null {
    const histogram = this.histograms.get(name);
    if (!histogram || histogram.count === 0) {
      return null;
    }

    const sorted = [...histogram.values].sort((a, b) => a - b);
    const len = sorted.length;

    return {
      count: histogram.count,
      sum: histogram.sum,
      min: histogram.min,
      max: histogram.max,
      mean: histogram.sum / histogram.count,
      p50: sorted[Math.floor(len * 0.5)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.floor(len * 0.99)],
    };
  }

  /**
   * Get all histogram names.
   */
  getNames(): string[] {
    return Array.from(this.histograms.keys());
  }

  /**
   * Reset a specific histogram.
   */
  reset(name: string): void {
    this.histograms.delete(name);
  }

  /**
   * Reset all histograms.
   */
  resetAll(): void {
    this.histograms.clear();
  }
}

// Well-known metric names
export const METRIC_NAMES = {
  JOIN_DURATION: 'join_duration',
  RECORDING_DURATION: 'recording_duration',
  TRANSCRIPTION_DURATION: 'transcription_duration',
  SUMMARY_DURATION: 'summary_duration',
} as const;

// Global singleton instance
export const metrics = new MetricsCollector();
