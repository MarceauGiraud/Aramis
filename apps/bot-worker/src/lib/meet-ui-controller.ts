/**
 * MeetUIController
 *
 * Controls the Google Meet UI to optimize recording quality.
 * Injects CSS to control the meeting view (speaker vs gallery).
 */

import { Page } from 'playwright';
import { logger } from './logger';
import type { RecordingView } from '@aramis/shared';

// CSS to force speaker view (single participant focused)
const MEET_SPEAKER_CSS = `
  /* Hide gallery tiles, focus on active speaker */
  [data-allocation-index]:not([data-allocation-index="0"]) {
    display: none !important;
  }
  [data-allocation-index="0"] {
    width: 100% !important;
    height: 100% !important;
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
  }
`;

// CSS to force gallery view (all participant tiles visible)
const MEET_GALLERY_CSS = `
  /* Keep all participant tiles visible in a grid */
  [data-allocation-index] {
    display: flex !important;
    visibility: visible !important;
  }
  /* Hide self-view overlay to maximize space for participants */
  [data-self-name][data-is-local-user="true"] {
    position: relative !important;
  }
`;

// CSS to hide meeting chrome for cleaner recording
const MEET_CLEAN_CSS = `
  /* Hide bottom toolbar */
  [jscontroller="kAPMuc"] > div:last-child {
    opacity: 0 !important;
    pointer-events: none !important;
  }
  /* Hide top bar */
  [data-meeting-title] {
    opacity: 0 !important;
  }
  /* Hide captions if shown */
  [jscontroller="D1tHje"] {
    display: none !important;
  }
`;

export class MeetUIController {
  private page: Page;
  private currentView: RecordingView = 'speaker';
  private styleHandle: string | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Set the recording view mode
   */
  async setView(view: RecordingView): Promise<void> {
    if (view === this.currentView && this.styleHandle) {
      return; // Already in the correct view
    }

    logger.info(`Setting Meet view to: ${view}`);

    // Remove existing injected styles
    if (this.styleHandle) {
      try {
        await this.page.evaluate((id: string) => {
          const el = document.getElementById(id);
          if (el) el.remove();
        }, this.styleHandle);
      } catch {
        // Page may have navigated
      }
    }

    const css = view === 'gallery' ? MEET_GALLERY_CSS : MEET_SPEAKER_CSS;
    const fullCss = css + MEET_CLEAN_CSS;
    const styleId = `aramis-view-${Date.now()}`;

    try {
      await this.page.evaluate(({ css, id }: { css: string; id: string }) => {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        document.head.appendChild(style);
      }, { css: fullCss, id: styleId });

      this.styleHandle = styleId;
      this.currentView = view;
      logger.info(`Meet view set to: ${view}`);
    } catch (error) {
      logger.warn(`Failed to set Meet view: ${error}`);
    }
  }

  /**
   * Get the current view mode
   */
  getView(): RecordingView {
    return this.currentView;
  }

  /**
   * Remove all injected styles
   */
  async cleanup(): Promise<void> {
    if (this.styleHandle) {
      try {
        await this.page.evaluate((id: string) => {
          const el = document.getElementById(id);
          if (el) el.remove();
        }, this.styleHandle);
      } catch {
        // Page may already be closed
      }
      this.styleHandle = null;
    }
  }
}
