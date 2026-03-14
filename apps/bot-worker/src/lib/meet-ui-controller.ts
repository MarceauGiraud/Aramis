/**
 * MeetUIController
 *
 * Controls the Google Meet UI to produce clean video recordings:
 * - Hides all chrome (toolbar, self-view, panels, notifications)
 * - Forces spotlight layout (main speaker fills viewport)
 * - Manages black overlay for precise video trimming
 */

import { Page } from 'playwright';
import { logger } from './logger';

/** CSS to hide all Google Meet chrome and force main speaker fullscreen */
const MEET_CLEAN_CSS = `
/* ===== Black overlay for precise trim ===== */
#__aramis-overlay {
  position: fixed !important;
  top: 0 !important; left: 0 !important;
  width: 100vw !important; height: 100vh !important;
  background: #000 !important;
  z-index: 999999 !important;
  pointer-events: none !important;
}

/* ===== Hide bottom toolbar ===== */
[jsname="EaZ7Cc"],
[jscontroller="kAPMuc"] > div:last-child,
div[jsname="RKOdsc"],
div[data-tooltip-id],
.VfPpkd-Bz112c-LgbsSe {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ===== Hide top bar (meeting info, time) ===== */
[data-meeting-title],
header,
[jsname="NJG6G"],
[jsname="VIpgJd"],
[jscontroller="AXYg3e"] {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ===== Hide self-view thumbnail ===== */
[data-self-name],
[data-is-self-view="true"],
[jsname="BEjVAc"] {
  display: none !important;
}

/* ===== Hide side panels (chat, participants, activities) ===== */
[jsname="az1Ob"],
[jsname="ME4pUb"],
[data-panel-id],
[role="complementary"] {
  display: none !important;
}

/* ===== Hide notification toasts ===== */
[jsname="r4nke"],
[jsname="VIpgJd"],
.J1XFef,
[data-snackbar],
[role="status"],
[aria-live="polite"] {
  display: none !important;
}

/* ===== Hide caption bar ===== */
[jsname="dsyhDe"],
[class*="caption" i],
[class*="subtitle" i] {
  display: none !important;
}

/* ===== Hide "Camera not found" and other overlays ===== */
[data-error-dialog],
[role="alertdialog"],
[role="dialog"] {
  display: none !important;
}

/* ===== Force main speaker to fill viewport ===== */
[data-allocation-index="0"] {
  position: fixed !important;
  top: 0 !important; left: 0 !important;
  width: 100vw !important; height: 100vh !important;
  z-index: 10 !important;
  border: none !important;
  outline: none !important;
  border-radius: 0 !important;
  margin: 0 !important;
}
[data-allocation-index="0"] video {
  object-fit: cover !important;
  width: 100% !important; height: 100% !important;
}

/* ===== Hide all other participant tiles ===== */
[data-allocation-index]:not([data-allocation-index="0"]) {
  display: none !important;
}

/* ===== Hide any remaining grid containers ===== */
[data-allocation-index="0"] ~ * {
  display: none !important;
}
`;

const OVERLAY_ID = '__aramis-overlay';

export class MeetUIController {
  private page: Page;
  private styleInjected = false;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Inject the black overlay. Call during waiting room / pre-join
   * so the Playwright video file starts with pure black frames.
   * Uses CDP Runtime.evaluate to bypass Google Meet's CSP restrictions.
   */
  async injectBlackOverlay(): Promise<void> {
    const overlayScript = `
      if (!document.getElementById('${OVERLAY_ID}')) {
        var el = document.createElement('div');
        el.id = '${OVERLAY_ID}';
        el.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:999999;pointer-events:none';
        (document.documentElement || document.body || document).appendChild(el);
      }
    `;
    try {
      // Try CDP first to bypass CSP on Google Meet
      const cdp = await this.page.context().newCDPSession(this.page);
      await cdp.send('Runtime.evaluate', { expression: overlayScript });
      await cdp.detach();
      logger.info('Black overlay injected via CDP');
    } catch (e) {
      // Fallback to page.evaluate for non-Chromium or early page states
      try {
        await this.page.evaluate(overlayScript);
        logger.info('Black overlay injected via page.evaluate');
      } catch (e2) {
        logger.warn(`Failed to inject black overlay: ${e2}`);
      }
    }
  }

  /**
   * Remove the black overlay. Call when recording should begin.
   * Uses CDP Runtime.evaluate to bypass Google Meet's CSP restrictions.
   */
  async removeBlackOverlay(): Promise<void> {
    const removeScript = `
      var el = document.getElementById('${OVERLAY_ID}');
      if (el) el.remove();
    `;
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      await cdp.send('Runtime.evaluate', { expression: removeScript });
      await cdp.detach();
      logger.info('Black overlay removed via CDP');
    } catch (e) {
      try {
        await this.page.evaluate(removeScript);
        logger.info('Black overlay removed via page.evaluate');
      } catch (e2) {
        logger.warn(`Failed to remove black overlay: ${e2}`);
      }
    }
  }

  /**
   * Hide all Meet chrome and force spotlight layout.
   * Uses CDP Page.addScriptToEvaluateOnNewDocument for persistence,
   * plus immediate injection via CSS.insertStyleSheet (bypasses CSP entirely).
   */
  async hideAllChrome(): Promise<void> {
    if (this.styleInjected) return;
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      // insertStyleSheet is a DevTools-level injection that completely bypasses CSP
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (function() {
            var s = document.createElement('style');
            s.setAttribute('data-aramis', 'clean');
            s.textContent = ${JSON.stringify(MEET_CLEAN_CSS)};
            var target = document.head || document.documentElement;
            if (target) target.appendChild(s);
            // Also re-inject when head becomes available
            new MutationObserver(function() {
              if (document.head && !document.querySelector('[data-aramis="clean"]')) {
                document.head.appendChild(s.cloneNode(true));
              }
            }).observe(document.documentElement, { childList: true, subtree: true });
          })();
        `,
      });
      // Also inject immediately for the current page
      await cdp.send('Runtime.evaluate', {
        expression: `
          (function() {
            if (document.querySelector('[data-aramis="clean"]')) return;
            var s = document.createElement('style');
            s.setAttribute('data-aramis', 'clean');
            s.textContent = ${JSON.stringify(MEET_CLEAN_CSS)};
            (document.head || document.documentElement).appendChild(s);
          })();
        `,
      });
      await cdp.detach();
      this.styleInjected = true;
      logger.info('Meet UI chrome hidden via CDP');
    } catch (e) {
      logger.warn(`Failed to hide Meet chrome: ${e}`);
    }
  }

  /**
   * Restore UI for leaving the meeting (unhide leave button).
   */
  async restoreForLeave(): Promise<void> {
    const restoreScript = `
      // Remove our injected style to restore all UI
      var cleanStyle = document.querySelector('[data-aramis="clean"]');
      if (cleanStyle) cleanStyle.remove();
      // Force leave button visible
      var btns = document.querySelectorAll('[aria-label*="Leave" i], [aria-label*="leave" i], [jsname="CQylAd"]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].style.cssText = 'opacity:1 !important; pointer-events:auto !important; visibility:visible !important; display:inline-flex !important;';
      }
    `;
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      await cdp.send('Runtime.evaluate', { expression: restoreScript });
      await cdp.detach();
    } catch {
      try { await this.page.evaluate(restoreScript); } catch { /* best effort */ }
    }
  }
}
