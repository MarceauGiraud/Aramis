/**
 * Display Allocator
 *
 * Allocates unique Xvfb display numbers and PulseAudio sinks per bot instance,
 * preventing display contention when running concurrent bots.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import { logger } from './logger';

// ============================================================================
// Types
// ============================================================================

export interface DisplayAllocation {
  /** Display number (e.g., 99, 100, 101) */
  displayNumber: number;
  /** Display string for DISPLAY env var (e.g., ':99') */
  displayName: string;
  /** PulseAudio sink name */
  pulseAudioSink: string;
  /** PulseAudio source (monitor) for recording */
  pulseAudioSource: string;
  /** Xvfb child process */
  xvfbProcess: ChildProcess | null;
  /** Matchbox window manager process */
  wmProcess: ChildProcess | null;
  /** PulseAudio module index for cleanup */
  pulseModuleIndex: number | null;
  /** PulseAudio module index for the silent mic source */
  pulseSilenceModuleIndex: number | null;
}

// ============================================================================
// DisplayAllocator
// ============================================================================

export class DisplayAllocator {
  private allocations: Map<string, DisplayAllocation> = new Map();
  private usedDisplays: Set<number> = new Set();
  private baseDisplay: number;
  private resolution: { width: number; height: number };

  // Xvfb is 110px taller than the target video to accommodate Chrome's toolbar
  // plus a small safety margin. FFmpeg crops the top N pixels (measured dynamically)
  // for a clean video without browser chrome or black bands.
  constructor(baseDisplay: number = 99, resolution = { width: 1280, height: 830 }) {
    this.baseDisplay = baseDisplay;
    this.resolution = resolution;
  }

  /**
   * Allocate a unique display + PulseAudio sink for a meeting bot.
   */
  async allocate(meetingId: string): Promise<DisplayAllocation> {
    // If already allocated for this meeting, return existing
    const existing = this.allocations.get(meetingId);
    if (existing) {
      logger.warn(`Display already allocated for meeting ${meetingId}: ${existing.displayName}`);
      return existing;
    }

    const displayNumber = this.findNextDisplay();
    const displayName = `:${displayNumber}`;
    const sinkName = `virtual_speaker_${displayNumber}`;

    logger.info(`Allocating display ${displayName} for meeting ${meetingId}`);

    let xvfbProcess: ChildProcess | null = null;
    let wmProcess: ChildProcess | null = null;
    let pulseModuleIndex: number | null = null;
    let pulseSilenceModuleIndex: number | null = null;

    try {
      // Start Xvfb
      xvfbProcess = await this.startXvfb(displayNumber);

      // Start matchbox window manager for clean fullscreen (no window decorations)
      wmProcess = spawn('matchbox-window-manager', ['-use_titlebar', 'no', '-use_cursor', 'no'], {
        env: { ...process.env, DISPLAY: `:${displayNumber}` },
        stdio: 'ignore',
        detached: false,
      });

      // Give matchbox a moment to start
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create PulseAudio null sink and wait for monitor source
      pulseModuleIndex = await this.createPulseAudioSink(sinkName);

      // Create a silent source for mic input (prevents Chrome from using real mic / feedback loop)
      pulseSilenceModuleIndex = this.createSilentSource(displayNumber);
    } catch (error) {
      // Clean up on failure
      if (wmProcess) {
        try {
          wmProcess.kill('SIGTERM');
        } catch {}
      }
      if (xvfbProcess) {
        xvfbProcess.kill('SIGTERM');
      }
      if (pulseModuleIndex !== null) {
        this.destroyPulseAudioSink(pulseModuleIndex);
      }
      if (pulseSilenceModuleIndex !== null) {
        this.destroyPulseAudioSink(pulseSilenceModuleIndex);
      }
      throw error;
    }

    const allocation: DisplayAllocation = {
      displayNumber,
      displayName,
      pulseAudioSink: sinkName,
      pulseAudioSource: `${sinkName}.monitor`,
      xvfbProcess,
      wmProcess,
      pulseModuleIndex,
      pulseSilenceModuleIndex,
    };

    this.allocations.set(meetingId, allocation);
    this.usedDisplays.add(displayNumber);

    logger.info(`Display allocated for meeting ${meetingId}: display=${displayName}, sink=${sinkName}`);

    return allocation;
  }

  /**
   * Release a display allocation, cleaning up Xvfb and PulseAudio resources.
   */
  async release(meetingId: string): Promise<void> {
    const allocation = this.allocations.get(meetingId);
    if (!allocation) {
      logger.debug(`No display allocation found for meeting ${meetingId}`);
      return;
    }

    logger.info(`Releasing display ${allocation.displayName} for meeting ${meetingId}`);

    // Kill matchbox window manager
    if (allocation.wmProcess && !allocation.wmProcess.killed) {
      try {
        allocation.wmProcess.kill('SIGTERM');
      } catch {}
    }

    // Kill Xvfb process
    if (allocation.xvfbProcess && !allocation.xvfbProcess.killed) {
      try {
        allocation.xvfbProcess.kill('SIGTERM');
        // Give it a moment, then force kill
        setTimeout(() => {
          if (allocation.xvfbProcess && !allocation.xvfbProcess.killed) {
            allocation.xvfbProcess.kill('SIGKILL');
          }
        }, 2000);
      } catch (error) {
        logger.warn(`Failed to kill Xvfb for display ${allocation.displayName}: ${error}`);
      }
    }

    // Unload PulseAudio modules
    if (allocation.pulseModuleIndex !== null) {
      this.destroyPulseAudioSink(allocation.pulseModuleIndex);
    }
    if (allocation.pulseSilenceModuleIndex !== null) {
      this.destroyPulseAudioSink(allocation.pulseSilenceModuleIndex);
    }

    this.allocations.delete(meetingId);
    this.usedDisplays.delete(allocation.displayNumber);

    logger.info(`Display ${allocation.displayName} released for meeting ${meetingId}`);
  }

  /**
   * Release all allocations (for graceful shutdown).
   */
  async releaseAll(): Promise<void> {
    const meetingIds = Array.from(this.allocations.keys());
    for (const meetingId of meetingIds) {
      await this.release(meetingId);
    }
  }

  /**
   * Get allocation for a meeting (if any).
   */
  getAllocation(meetingId: string): DisplayAllocation | undefined {
    return this.allocations.get(meetingId);
  }

  /**
   * Get count of active allocations.
   */
  getActiveCount(): number {
    return this.allocations.size;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private findNextDisplay(): number {
    let display = this.baseDisplay;
    while (this.usedDisplays.has(display)) {
      display++;
    }
    return display;
  }

  private startXvfb(displayNumber: number): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      // Clean up stale lock file from previous crash
      try {
        const lockFile = `/tmp/.X${displayNumber}-lock`;
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
          logger.info(`Removed stale Xvfb lock file: ${lockFile}`);
        }
      } catch {
        /* ignore */
      }

      const { width, height } = this.resolution;
      const args = [
        `:${displayNumber}`,
        '-screen',
        '0',
        `${width}x${height}x24`,
        '-ac', // disable access control
        '-nolisten',
        'tcp',
      ];

      const proc = spawn('Xvfb', args, {
        stdio: 'ignore',
        detached: false,
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Xvfb on :${displayNumber}: ${err.message}`));
      });

      // Give Xvfb a moment to start up
      const timeout = setTimeout(() => {
        if (proc.killed || proc.exitCode !== null) {
          reject(new Error(`Xvfb exited immediately on :${displayNumber}`));
        } else {
          resolve(proc);
        }
      }, 500);

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== null && code !== 0) {
          logger.warn(`Xvfb on :${displayNumber} exited with code ${code}`);
        }
      });
    });
  }

  /**
   * Check whether the PulseAudio monitor source for a sink is registered and
   * available for capture.
   */
  verifySinkReady(sinkName: string): boolean {
    const monitorSource = `${sinkName}.monitor`;
    try {
      const sources = execSync('pactl list sources short', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return sources.includes(monitorSource);
    } catch {
      return false;
    }
  }

  private async createPulseAudioSink(sinkName: string): Promise<number | null> {
    try {
      const result = execSync(
        `pactl load-module module-null-sink sink_name=${sinkName} rate=48000 sink_properties=device.description="${sinkName}"`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();

      const moduleIndex = parseInt(result, 10);
      if (isNaN(moduleIndex)) {
        logger.warn(`Failed to parse PulseAudio module index: ${result}`);
        return null;
      }

      logger.debug(`PulseAudio sink created: ${sinkName} (module ${moduleIndex})`);

      // Wait for the monitor source to become available (max 1 second)
      const monitorSource = `${sinkName}.monitor`;
      const maxRetries = 5;
      const retryDelayMs = 200;
      let ready = false;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (this.verifySinkReady(sinkName)) {
          ready = true;
          logger.debug(`PulseAudio monitor source ${monitorSource} ready after ${attempt} attempt(s)`);
          break;
        }
        logger.debug(`Waiting for monitor source ${monitorSource} (attempt ${attempt}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }

      if (!ready) {
        logger.warn(`PulseAudio monitor source ${monitorSource} not available after ${maxRetries} retries`);
      }

      // NOTE: We no longer call `pactl set-default-sink` here because it is
      // a global operation that causes a race condition when multiple bots run
      // concurrently. Instead, each Chrome process uses the PULSE_SINK env var
      // to route audio to its dedicated sink (set in base.ts at launch).

      return moduleIndex;
    } catch (error) {
      logger.warn(`Failed to create PulseAudio sink ${sinkName}: ${error}`);
      return null;
    }
  }

  /**
   * Create a silent PulseAudio source (null-source) to serve as a fake mic input.
   * Chrome will use this via the PULSE_SOURCE env var, preventing feedback loops.
   */
  private createSilentSource(displayNumber: number): number | null {
    const sourceName = `virtual_silence_${displayNumber}`;
    try {
      const result = execSync(
        `pactl load-module module-null-source source_name=${sourceName} source_properties=device.description=Silent_Mic_${displayNumber}`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();

      const moduleIndex = parseInt(result, 10);
      if (isNaN(moduleIndex)) {
        logger.warn(`Failed to parse silent source module index: ${result}`);
        return null;
      }

      logger.debug(`PulseAudio silent source created: ${sourceName} (module ${moduleIndex})`);
      return moduleIndex;
    } catch (error) {
      logger.warn(`Failed to create silent source ${sourceName}: ${error}`);
      return null;
    }
  }

  private destroyPulseAudioSink(moduleIndex: number): void {
    try {
      execSync(`pactl unload-module ${moduleIndex}`, { timeout: 5000 });
      logger.debug(`PulseAudio module ${moduleIndex} unloaded`);
    } catch (error) {
      logger.warn(`Failed to unload PulseAudio module ${moduleIndex}: ${error}`);
    }
  }
}

// Singleton instance
export const displayAllocator = new DisplayAllocator();
