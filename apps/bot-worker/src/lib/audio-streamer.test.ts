/**
 * Simple test for AudioStreamer class
 *
 * Run with: npx tsx apps/bot-worker/src/lib/audio-streamer.test.ts
 *
 * Requirements:
 * - PulseAudio installed and available
 * - FFmpeg installed
 * - Running in an environment where audio can be captured
 *
 * Note: Full integration test requires actual audio playback.
 * This test verifies the class structure and initialization.
 */

import { AudioStreamer } from './audio-streamer';
import * as fs from 'fs';
import * as path from 'path';

const TEST_OUTPUT_DIR = '/tmp/audio-streamer-test';

async function runTests(): Promise<void> {
  console.log('=== AudioStreamer Tests ===\n');

  // Clean up test directory
  if (fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

  let passed = 0;
  let failed = 0;

  // Test 1: Class instantiation
  console.log('Test 1: Class instantiation');
  try {
    const streamer = new AudioStreamer();
    console.log('  - Default config: PASS');
    passed++;

    const customStreamer = new AudioStreamer({
      outputDir: TEST_OUTPUT_DIR,
      format: 'wav',
      sampleRate: 44100,
      channels: 2,
      sinkName: 'test_sink',
    });
    console.log('  - Custom config: PASS');
    passed++;
  } catch (error) {
    console.log(`  - FAIL: ${error}`);
    failed++;
  }

  // Test 2: Initial state
  console.log('\nTest 2: Initial state');
  try {
    const streamer = new AudioStreamer({ outputDir: TEST_OUTPUT_DIR });

    if (streamer.isRecording() === false) {
      console.log('  - isRecording() returns false: PASS');
      passed++;
    } else {
      console.log('  - isRecording() should return false: FAIL');
      failed++;
    }

    if (streamer.getOutputPath() === null) {
      console.log('  - getOutputPath() returns null: PASS');
      passed++;
    } else {
      console.log('  - getOutputPath() should return null: FAIL');
      failed++;
    }

    if (streamer.getDuration() === 0) {
      console.log('  - getDuration() returns 0: PASS');
      passed++;
    } else {
      console.log('  - getDuration() should return 0: FAIL');
      failed++;
    }

    if (streamer.getError() === null) {
      console.log('  - getError() returns null: PASS');
      passed++;
    } else {
      console.log('  - getError() should return null: FAIL');
      failed++;
    }
  } catch (error) {
    console.log(`  - FAIL: ${error}`);
    failed++;
  }

  // Test 3: PulseAudio initialization (may fail if PulseAudio not available)
  console.log('\nTest 3: PulseAudio initialization');
  try {
    const streamer = new AudioStreamer({
      outputDir: TEST_OUTPUT_DIR,
      sinkName: 'test_audio_sink_' + Date.now(),
    });

    await streamer.initializePulseAudio();
    console.log('  - PulseAudio initialization: PASS');
    passed++;

    // Cleanup
    await streamer.cleanup();
    console.log('  - Cleanup: PASS');
    passed++;
  } catch (error: any) {
    if (error.message?.includes('PulseAudio') || error.message?.includes('pulseaudio')) {
      console.log('  - SKIP: PulseAudio not available in this environment');
    } else {
      console.log(`  - FAIL: ${error}`);
      failed++;
    }
  }

  // Test 4: Start/stop recording (may fail if PulseAudio not available)
  console.log('\nTest 4: Start/stop recording');
  try {
    const streamer = new AudioStreamer({
      outputDir: TEST_OUTPUT_DIR,
      format: 'wav',
      sinkName: 'test_recording_sink_' + Date.now(),
    });

    const outputPath = await streamer.start('test-meeting-123');
    console.log(`  - Start recording: PASS (${outputPath})`);
    passed++;

    if (streamer.isRecording()) {
      console.log('  - isRecording() returns true: PASS');
      passed++;
    } else {
      console.log('  - isRecording() should return true: FAIL');
      failed++;
    }

    if (outputPath && outputPath.includes('test-meeting-123')) {
      console.log('  - Output path contains meeting ID: PASS');
      passed++;
    } else {
      console.log('  - Output path should contain meeting ID: FAIL');
      failed++;
    }

    // Record for 2 seconds
    console.log('  - Recording for 2 seconds...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const duration = streamer.getDuration();
    if (duration >= 1 && duration <= 5) {
      console.log(`  - getDuration() returns ${duration}s: PASS`);
      passed++;
    } else {
      console.log(`  - getDuration() unexpected value: ${duration}s: FAIL`);
      failed++;
    }

    const stoppedPath = await streamer.stop();
    console.log('  - Stop recording: PASS');
    passed++;

    if (!streamer.isRecording()) {
      console.log('  - isRecording() returns false after stop: PASS');
      passed++;
    } else {
      console.log('  - isRecording() should return false after stop: FAIL');
      failed++;
    }

    // Verify file was created
    if (stoppedPath && fs.existsSync(stoppedPath)) {
      const stats = fs.statSync(stoppedPath);
      console.log(`  - Output file exists (${stats.size} bytes): PASS`);
      passed++;

      // Check file duration
      const fileDuration = await streamer.getFileDuration();
      console.log(`  - File duration: ${fileDuration.toFixed(2)}s`);
    } else {
      console.log('  - Output file not found: FAIL');
      failed++;
    }

    await streamer.cleanup();
  } catch (error: any) {
    if (
      error.message?.includes('PulseAudio') ||
      error.message?.includes('pulseaudio') ||
      error.message?.includes('FFmpeg')
    ) {
      console.log('  - SKIP: Audio system not available in this environment');
    } else {
      console.log(`  - FAIL: ${error}`);
      failed++;
    }
  }

  // Test 5: Double start prevention
  console.log('\nTest 5: Double start prevention');
  try {
    const streamer = new AudioStreamer({
      outputDir: TEST_OUTPUT_DIR,
      sinkName: 'test_double_start_sink_' + Date.now(),
    });

    const path1 = await streamer.start('test-double-1');
    const path2 = await streamer.start('test-double-2');

    if (path1 === path2) {
      console.log('  - Second start returns same path: PASS');
      passed++;
    } else {
      console.log('  - Second start should return same path: FAIL');
      failed++;
    }

    await streamer.cleanup();
  } catch (error: any) {
    if (error.message?.includes('PulseAudio') || error.message?.includes('pulseaudio')) {
      console.log('  - SKIP: PulseAudio not available');
    } else {
      console.log(`  - FAIL: ${error}`);
      failed++;
    }
  }

  // Test 6: Stop without start
  console.log('\nTest 6: Stop without start');
  try {
    const streamer = new AudioStreamer({ outputDir: TEST_OUTPUT_DIR });
    const result = await streamer.stop();

    if (result === null) {
      console.log('  - Stop without start returns null: PASS');
      passed++;
    } else {
      console.log('  - Stop without start should return null: FAIL');
      failed++;
    }
  } catch (error) {
    console.log(`  - FAIL: ${error}`);
    failed++;
  }

  // Summary
  console.log('\n=== Test Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);

  // Cleanup test directory
  try {
    fs.rmSync(TEST_OUTPUT_DIR, { recursive: true });
    console.log('\nTest directory cleaned up.');
  } catch {
    // Ignore cleanup errors
  }

  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
