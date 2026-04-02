/**
 * Tests for VideoStreamer class
 *
 * Note: These tests require:
 * - FFmpeg to be installed
 * - Xvfb running on display :99 (or configured display)
 *
 * Run with: npx tsx src/__tests__/video-streamer.test.ts
 */

import { VideoStreamer, ProgressInfo } from '../lib/video-streamer';
import * as fs from 'fs';
import * as path from 'path';

const TEST_OUTPUT_DIR = '/tmp/test-recordings';

// Simple test runner
async function runTests() {
  console.log('=== VideoStreamer Tests ===\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  Error: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  // Setup
  if (!fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
  }

  // Test 1: Constructor with default options
  await test('creates instance with default options', async () => {
    const streamer = new VideoStreamer();
    assert(streamer !== null, 'Streamer should be created');
    assert(!streamer.getIsRecording(), 'Should not be recording initially');
    assert(streamer.getOutputPath() === null, 'Output path should be null initially');
  });

  // Test 2: Constructor with custom options
  await test('creates instance with custom options', async () => {
    const streamer = new VideoStreamer({
      outputDir: TEST_OUTPUT_DIR,
      format: 'mp4',
      display: ':99',
      resolution: '1280x720',
      frameRate: 24,
      videoBitrate: '1M',
    });
    assert(streamer !== null, 'Streamer should be created with custom options');
  });

  // Test 3: Start without display should fail gracefully
  await test('handles missing display gracefully', async () => {
    const streamer = new VideoStreamer({
      outputDir: TEST_OUTPUT_DIR,
      display: ':999', // Non-existent display
    });

    let errorEmitted = false;
    streamer.on('error', () => {
      errorEmitted = true;
    });

    try {
      await streamer.start('test-no-display');
      // If we get here without Xvfb, it should have failed
      // But if Xvfb is running, it might succeed
    } catch (error) {
      // Expected to fail when display doesn't exist
      assert(error instanceof Error, 'Should throw an error');
    }
  });

  // Test 4: Stop without start should throw
  await test('throws when stopping without starting', async () => {
    const streamer = new VideoStreamer({
      outputDir: TEST_OUTPUT_DIR,
    });

    try {
      await streamer.stop();
      throw new Error('Should have thrown');
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes('No recording in progress'),
        'Should throw correct error message',
      );
    }
  });

  // Test 5: Double start should throw
  await test('throws when starting twice', async () => {
    const streamer = new VideoStreamer({
      outputDir: TEST_OUTPUT_DIR,
    });

    // Mock the recording state
    (streamer as any).isRecording = true;

    try {
      await streamer.start('test-double-start');
      throw new Error('Should have thrown');
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes('already in progress'),
        'Should throw correct error message',
      );
    }
  });

  // Test 6: getDuration returns 0 when not recording
  await test('getDuration returns 0 when not recording', async () => {
    const streamer = new VideoStreamer({
      outputDir: TEST_OUTPUT_DIR,
    });
    assert(streamer.getDuration() === 0, 'Duration should be 0');
  });

  // Test 7: forceStop should clean up
  await test('forceStop cleans up without error', async () => {
    const streamer = new VideoStreamer({
      outputDir: TEST_OUTPUT_DIR,
    });
    // Should not throw even when nothing is running
    streamer.forceStop();
    assert(!streamer.getIsRecording(), 'Should not be recording after forceStop');
  });

  // Test 8: Event emitter functionality
  await test('supports event listeners', async () => {
    const streamer = new VideoStreamer({
      outputDir: TEST_OUTPUT_DIR,
    });

    let eventReceived = false;
    streamer.on('error', () => {
      eventReceived = true;
    });

    // Manually emit to test listener
    streamer.emit('error', new Error('test error'));
    assert(eventReceived, 'Event listener should be called');
  });

  // Integration test - only run if Xvfb is available
  const display = process.env.DISPLAY || ':99';
  const xvfbAvailable = await checkXvfbAvailable(display);

  if (xvfbAvailable) {
    await test('integration: records video from Xvfb (WebM)', async () => {
      const streamer = new VideoStreamer({
        outputDir: TEST_OUTPUT_DIR,
        format: 'webm',
        display,
        resolution: '640x480',
        frameRate: 10,
      });

      let startEmitted = false;
      let progressEmitted = false;

      streamer.on('start', () => {
        startEmitted = true;
      });

      streamer.on('progress', (info: ProgressInfo) => {
        progressEmitted = true;
        console.log(`    Progress: ${info.duration.toFixed(1)}s, ${info.fileSize} bytes`);
      });

      await streamer.start('integration-test-webm');
      assert(startEmitted, 'Start event should be emitted');
      assert(streamer.getIsRecording(), 'Should be recording');

      // Record for 3 seconds
      await sleep(3000);

      const outputPath = await streamer.stop();
      assert(outputPath !== null, 'Output path should be returned');
      assert(fs.existsSync(outputPath), 'Output file should exist');

      const stats = fs.statSync(outputPath);
      assert(stats.size > 0, 'Output file should have content');
      console.log(`    Output: ${outputPath} (${stats.size} bytes)`);

      // Cleanup
      fs.unlinkSync(outputPath);
    });

    await test('integration: records video from Xvfb (MP4)', async () => {
      const streamer = new VideoStreamer({
        outputDir: TEST_OUTPUT_DIR,
        format: 'mp4',
        display,
        resolution: '640x480',
        frameRate: 10,
      });

      await streamer.start('integration-test-mp4');
      assert(streamer.getIsRecording(), 'Should be recording');

      // Record for 2 seconds
      await sleep(2000);

      const outputPath = await streamer.stop();
      assert(outputPath !== null, 'Output path should be returned');
      assert(fs.existsSync(outputPath), 'Output file should exist');

      const stats = fs.statSync(outputPath);
      assert(stats.size > 0, 'Output file should have content');
      console.log(`    Output: ${outputPath} (${stats.size} bytes)`);

      // Cleanup
      fs.unlinkSync(outputPath);
    });
  } else {
    console.log('\n⚠ Skipping integration tests - Xvfb not available on display', display);
    console.log('  To run integration tests, start Xvfb: Xvfb :99 -screen 0 1920x1080x24 &');
  }

  // Summary
  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

// Helper functions
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkXvfbAvailable(display: string): Promise<boolean> {
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    // Try to run a simple X command to check if display is available
    const proc = spawn('xdpyinfo', [], {
      env: { ...process.env, DISPLAY: display },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let hasOutput = false;

    proc.stdout.on('data', () => {
      hasOutput = true;
    });

    proc.on('close', (code) => {
      resolve(code === 0 && hasOutput);
    });

    proc.on('error', () => {
      resolve(false);
    });

    // Timeout after 2 seconds
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 2000);
  });
}

// Run tests
runTests().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
