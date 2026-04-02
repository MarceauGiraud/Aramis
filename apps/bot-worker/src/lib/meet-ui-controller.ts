/**
 * MeetUIController
 *
 * Controls the Google Meet UI to optimize recording quality.
 * Uses DOM manipulation to hide non-video elements, the bot's own tile,
 * the bottom control bar, and popups/overlays.
 *
 * All detection is POSITIONAL (getBoundingClientRect) — no aria-labels,
 * no language-dependent selectors, no jscontroller attributes.
 */

import { Page } from 'playwright';
import { logger } from './logger';
import type { RecordingView } from '@aramis/shared';

// CSS to force speaker view: hide the bot's own tile and let Meet's native
// speaker layout fill the screen. We hide by [data-self-name] (the bot's tile)
// instead of allocation-index, because the bot can be at ANY index.
const MEET_SPEAKER_CSS = `
  /* Hide the bot's own video tile */
  [data-self-name] {
    display: none !important;
  }
  /* Hide the bot's local user overlay / PiP */
  [data-is-local-user="true"] {
    display: none !important;
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

// Minimal CSS for things inside <main> that the DOM approach cannot handle
const MEET_CLEAN_CSS = `
  /* Hide captions overlay */
  [jscontroller="D1tHje"] { display: none !important; }
`;

/**
 * Browser-side function: hide the bottom control bar (positional) and
 * dismiss popups/overlays. No aria-labels — language-independent.
 */
function cleanupUIInBrowser(main: Element): void {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const bottomThreshold = vh * 0.78;

  // --- 1. Hide bottom control bar by position ---
  const alreadyHidden = document.querySelector('[data-aramis-hidden="bottom-bar"]');
  if (alreadyHidden) {
    (alreadyHidden as HTMLElement).style.display = 'none';
  } else {
    // Scan divs inside <main> for the control bar:
    // wide (>60% viewport), short (30-150px), in bottom 22% of screen
    const elements = main.querySelectorAll('div');
    for (const el of elements) {
      const htmlEl = el as HTMLElement;
      if (htmlEl.querySelector('[data-allocation-index]')) continue;
      if (htmlEl.getAttribute('data-aramis-hidden')) continue;
      const rect = htmlEl.getBoundingClientRect();
      if (
        rect.width > vw * 0.6 &&
        rect.height > 30 &&
        rect.height < 150 &&
        rect.top >= bottomThreshold &&
        rect.bottom <= vh + 5
      ) {
        htmlEl.style.display = 'none';
        htmlEl.setAttribute('data-aramis-hidden', 'bottom-bar');
        break;
      }
    }
  }

  // --- 2. Dismiss dialogs and popups ---
  // Google Meet shows popups: "Your meeting's ready", "Add others",
  // consent dialogs, "You're presenting", etc.
  // Click dismiss buttons inside [role="dialog"] / [role="alertdialog"]
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
  for (const dialog of dialogs) {
    const htmlDialog = dialog as HTMLElement;
    // Try clicking any button inside the dialog (dismiss/close/ok/got it)
    const buttons = htmlDialog.querySelectorAll('button');
    if (buttons.length > 0) {
      // Click the last button (usually "Got it" / "OK" / "Dismiss")
      (buttons[buttons.length - 1] as HTMLElement).click();
    }
    // If still visible, hide it
    htmlDialog.style.display = 'none';
    htmlDialog.setAttribute('data-aramis-hidden', 'popup');
  }

  // --- 3. Hide floating overlays/toasts ---
  // Small fixed/absolute positioned elements that are NOT video tiles
  const allEls = document.querySelectorAll('body > div');
  for (const el of allEls) {
    const htmlEl = el as HTMLElement;
    if (htmlEl.tagName === 'MAIN' || htmlEl.contains(main) || main.contains(htmlEl)) continue;
    if (htmlEl.getAttribute('data-aramis-hidden')) continue;
    const style = window.getComputedStyle(htmlEl);
    if (style.display === 'none') continue;
    const rect = htmlEl.getBoundingClientRect();
    // Floating overlay: not full-width, not tiny, positioned
    if (
      (style.position === 'fixed' || style.position === 'absolute') &&
      rect.width > 80 &&
      rect.width < vw * 0.85 &&
      rect.height > 30 &&
      rect.height < vh * 0.6 &&
      !htmlEl.querySelector('video') &&
      !htmlEl.querySelector('[data-allocation-index]')
    ) {
      htmlEl.style.display = 'none';
      htmlEl.setAttribute('data-aramis-hidden', 'popup');
    }
  }
}

// Serialized version for injection into page context
const CLEANUP_UI_FN = cleanupUIInBrowser.toString();

export class MeetUIController {
  private page: Page;
  private currentView: RecordingView = 'speaker';
  private styleHandle: string | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Inject the cleanup helper into the page's global scope.
   */
  private async injectHelpers(): Promise<void> {
    await this.page.evaluate((fnBody: string) => {
      if (!(window as any).__aramisCleanupUI) {
        // eslint-disable-next-line no-eval
        (window as any).__aramisCleanupUI = eval('(' + fnBody + ')');
      }
    }, CLEANUP_UI_FN);
  }

  /**
   * Hide everything outside of <main> (the video grid container),
   * plus the bottom control bar and popups inside <main>.
   */
  async hideNonVideoUI(): Promise<void> {
    await this.injectHelpers();
    await this.page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return;

      // Hide everything outside <main>
      const ancestors = new Set<Element>();
      let current: Element | null = main;
      while (current && current !== document.body) {
        ancestors.add(current);
        current = current.parentElement;
      }

      document.querySelectorAll('body *').forEach((el) => {
        if (el === main || ancestors.has(el) || main.contains(el)) return;
        (el as HTMLElement).style.display = 'none';
      });

      // Hide bottom bar + dismiss popups
      const cleanup = (window as any).__aramisCleanupUI;
      if (cleanup) cleanup(main);
    });
  }

  /**
   * Minimize the bot's own video tile using Meet's native context menu,
   * then hide the resulting PiP element.
   */
  async minimizeBotTile(): Promise<void> {
    await this.page.evaluate(() => {
      const um = (window as any).__aramisUserManager;
      if (!um || !um.currentUserId) return;

      const botDeviceId = um.currentUserId;

      // Find the bot's video tile
      const botTile = document.querySelector(`[data-participant-id="${botDeviceId}"]`);
      if (!botTile) return;

      // Click "More options" button on the bot's tile (use the 3-dot icon, not aria-label)
      // The 3-dot button is typically the last button inside the tile overlay
      const buttons = botTile.querySelectorAll('button');
      const moreBtn = buttons.length > 0 ? buttons[buttons.length - 1] : null;
      if (moreBtn) {
        (moreBtn as HTMLElement).click();

        // Wait for context menu to appear, then click "Minimize" (last menu item typically)
        let attempts = 0;
        const interval = setInterval(() => {
          const menuItems = document.querySelectorAll('[role="menuitem"]');
          // "Minimize" / "Réduire" is usually the last menu item
          if (menuItems.length > 0) {
            const lastItem = menuItems[menuItems.length - 1] as HTMLElement;
            lastItem.click();
            clearInterval(interval);

            // After minimize, hide the minimized PiP element
            setTimeout(() => {
              const pip = document.querySelector('div[jsname="Qiayqc"]');
              if (pip) (pip as HTMLElement).style.display = 'none';

              // Hide any remaining self-view overlays
              document.querySelectorAll('[data-self-name]').forEach((el) => {
                const container = el.closest('[data-allocation-index]') || el;
                const rect = container.getBoundingClientRect();
                if (rect.width < 300 && rect.height < 200) {
                  (container as HTMLElement).style.display = 'none';
                }
              });
            }, 500);
          }
          attempts++;
          if (attempts > 15) clearInterval(interval);
        }, 100);
      }
    });
  }

  /**
   * Set up a periodic interval that re-hides non-video UI, popups,
   * and the bottom bar. Google Meet re-renders parts of its DOM periodically.
   */
  private async setupPeriodicCleanup(): Promise<void> {
    await this.page.evaluate(() => {
      if ((window as any).__aramisUICleanupInterval) return;
      (window as any).__aramisUICleanupInterval = setInterval(() => {
        const main = document.querySelector('main');
        if (!main) return;

        // Re-hide non-main elements
        const ancestors = new Set<Element>();
        let current: Element | null = main;
        while (current && current !== document.body) {
          ancestors.add(current);
          current = current.parentElement;
        }
        document.querySelectorAll('body > *').forEach((el) => {
          if (el.tagName === 'MAIN' || el.contains(main!) || main!.contains(el)) return;
          (el as HTMLElement).style.display = 'none';
        });

        // Re-hide PiP
        const pip = document.querySelector('div[jsname="Qiayqc"]');
        if (pip) (pip as HTMLElement).style.display = 'none';

        // Re-run full cleanup (bottom bar + popups)
        const cleanup = (window as any).__aramisCleanupUI;
        if (cleanup) cleanup(main);
      }, 5000);
    });
  }

  /**
   * Set the recording view mode.
   */
  async setView(view: RecordingView): Promise<void> {
    if (view === this.currentView && this.styleHandle) {
      return;
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
      await this.page.evaluate(
        ({ css, id }: { css: string; id: string }) => {
          const style = document.createElement('style');
          style.id = id;
          style.textContent = css;
          document.head.appendChild(style);
        },
        { css: fullCss, id: styleId },
      );

      this.styleHandle = styleId;
      this.currentView = view;

      await this.hideNonVideoUI();
      await this.minimizeBotTile();
      await this.setupPeriodicCleanup();

      logger.info(`Meet view set to: ${view}`);
    } catch (error) {
      logger.warn(`Failed to set Meet view: ${error}`);
    }
  }

  getView(): RecordingView {
    return this.currentView;
  }

  /**
   * Restore UI elements so the leave button is clickable.
   */
  async restoreForLeave(): Promise<void> {
    try {
      await this.page.evaluate(() => {
        if ((window as any).__aramisUICleanupInterval) {
          clearInterval((window as any).__aramisUICleanupInterval);
          (window as any).__aramisUICleanupInterval = null;
        }
      });

      await this.page.evaluate(() => {
        document.querySelectorAll('[data-aramis-hidden]').forEach((el) => {
          (el as HTMLElement).style.display = '';
          el.removeAttribute('data-aramis-hidden');
        });
        document.querySelectorAll('body *').forEach((el) => {
          const htmlEl = el as HTMLElement;
          if (htmlEl.style.display === 'none') {
            htmlEl.style.display = '';
          }
        });
      });
    } catch {
      // Page may already be closed
    }

    await this.cleanup();
  }

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
