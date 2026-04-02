import { describe, it, expect } from 'vitest';

// Test the RMS silence detection logic from manager.ts
function isSilent(pcmBuffer: Buffer, threshold = 0.0025): boolean {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount === 0) return true;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms / 32768 < threshold;
}

describe('Silence Detection', () => {
  it('detects silence (all zeros)', () => {
    const buf = Buffer.alloc(3200); // 1600 samples of silence
    expect(isSilent(buf)).toBe(true);
  });

  it('detects speech (loud signal)', () => {
    const buf = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      buf.writeInt16LE(10000, i * 2); // loud signal
    }
    expect(isSilent(buf)).toBe(false);
  });

  it('handles empty buffer', () => {
    expect(isSilent(Buffer.alloc(0))).toBe(true);
  });

  it('handles single sample near zero', () => {
    const buf = Buffer.alloc(2);
    buf.writeInt16LE(10, 0);
    // RMS = 10, normalized = 10/32768 ~ 0.0003 < 0.0025
    expect(isSilent(buf)).toBe(true);
  });

  it('handles single sample above threshold', () => {
    const buf = Buffer.alloc(2);
    buf.writeInt16LE(500, 0);
    // RMS = 500, normalized = 500/32768 ~ 0.015 > 0.0025
    expect(isSilent(buf)).toBe(false);
  });

  it('respects custom threshold', () => {
    const buf = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      buf.writeInt16LE(200, i * 2);
    }
    // RMS = 200, normalized = 200/32768 ~ 0.0061
    expect(isSilent(buf, 0.001)).toBe(false);
    expect(isSilent(buf, 0.01)).toBe(true);
  });

  it('handles negative samples correctly', () => {
    const buf = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      buf.writeInt16LE(-10000, i * 2);
    }
    // Squaring removes sign, so loud negative signal is still detected
    expect(isSilent(buf)).toBe(false);
  });
});
