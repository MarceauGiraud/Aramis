import { Page } from 'playwright';
import { EventEmitter } from 'events';
import { logger } from './logger';

export interface SpeakerEvent {
  speaker: string;
  startTime: number;
  platform: 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET';
}

/**
 * Détecte le speaker actif en observant le DOM du meeting
 * Utilise les indicateurs visuels natifs des plateformes
 */
export class NativeSpeakerDetector extends EventEmitter {
  private page: Page;
  private platform: 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET';
  private isRunning: boolean = false;
  private currentSpeaker: string | null = null;
  private speakerStartTime: number = 0;
  private recordingStartTime: number = 0;
  private speakerHistory: SpeakerEvent[] = [];

  // Selectors pour chaque plateforme (doivent être maintenus à jour)
  private static PLATFORM_SELECTORS = {
    ZOOM: {
      // Zoom Web Client - le participant actif a une bordure verte
      activeSpeaker: '.video-avatar__avatar--active, .video-avatar--active',
      participantName: '.video-avatar__avatar-title, .video-avatar-image__avatar-title',
      allParticipants: '.video-avatar-image, .video-avatar__avatar',
    },
    TEAMS: {
      // Teams classic + v2 React SPA selectors (tried in order)
      // Classic: data-cid attributes; v2: data-tid, data-stream-type, data-test-segment-type
      activeSpeaker: [
        '[data-cid="calling-participant-video"][data-is-speaking="true"]',
        '[data-stream-type="Video"][data-is-speaking="true"]',
        '[data-tid="active-speaker"]',
        '[data-tid="dominant-speaker"]',
      ].join(', '),
      participantName: [
        '[data-cid="roster-participant-name"]',
        '[data-tid="participant-name"]',
        '[data-tid="roster-participant"]',
      ].join(', '),
      allParticipants: [
        '[data-cid="calling-participant-video"]',
        '[data-stream-type="Video"]',
        '[data-cid="calling-participant-stream"]',
        '[data-test-segment-type="central"] video',
      ].join(', '),
      speakingIndicator: [
        '.speaking-indicator',
        '[data-tid="active-speaker-indicator"]',
        '[data-tid="speaking-indicator"]',
      ].join(', '),
    },
    GOOGLE_MEET: {
      // Google Meet - bordure bleue animée autour du speaker
      activeSpeaker: '[data-self-name][data-is-active-speaker="true"], .IjbFje', // .IjbFje = blue border class
      participantName: '[data-self-name]',
      allParticipants: '[data-participant-id]',
      // Le nom est dans un attribut data
      nameAttribute: 'data-self-name',
    },
  };

  constructor(page: Page, platform: 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET') {
    super();
    this.page = page;
    this.platform = platform;
  }

  /**
   * Démarre la détection du speaker actif
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.recordingStartTime = Date.now();
    logger.info(`Starting native speaker detection for ${this.platform}`);

    // Injecter un script pour observer les changements de speaker
    await this.injectSpeakerObserver();

    // Polling de backup (au cas où l'observer rate des events)
    this.startPolling();
  }

  /**
   * Injecte un MutationObserver dans la page pour détecter les changements de speaker
   */
  private async injectSpeakerObserver(): Promise<void> {
    const selectors = NativeSpeakerDetector.PLATFORM_SELECTORS[this.platform];

    await this.page.evaluate(
      ({ platform, selectors }) => {
        // Créer un canal de communication avec Playwright
        (window as any).__speakerEvents = [];

        const detectActiveSpeaker = (): string | null => {
          let speakerName: string | null = null;

          if (platform === 'ZOOM') {
            // Zoom: chercher l'élément avec la classe active
            const activeEl = document.querySelector(selectors.activeSpeaker);
            if (activeEl) {
              const nameEl =
                activeEl.querySelector(selectors.participantName) ||
                activeEl.closest('[class*="video-avatar"]')?.querySelector(selectors.participantName);
              speakerName = nameEl?.textContent?.trim() || null;
            }
          } else if (platform === 'TEAMS') {
            // Teams: chercher l'indicateur de speaking (classic + v2 selectors)
            const activeEl = document.querySelector(selectors.activeSpeaker);
            if (activeEl) {
              // Try multiple name resolution strategies (classic then v2)
              const nameEl = activeEl.querySelector(selectors.participantName);
              const nameFromAttr =
                activeEl.getAttribute('data-participant-name') || activeEl.getAttribute('aria-label');
              speakerName = nameEl?.textContent?.trim() || nameFromAttr || null;
            }
          } else if (platform === 'GOOGLE_MEET') {
            // Google Meet: chercher l'élément avec bordure active
            const allParticipants = document.querySelectorAll(selectors.allParticipants);
            for (const participant of allParticipants) {
              // Vérifier si le participant a la bordure bleue (speaking indicator)
              const rect = participant.getBoundingClientRect();
              const styles = window.getComputedStyle(participant);
              const hasActiveBorder =
                styles.borderColor.includes('66, 133, 244') || // Google blue
                participant.classList.contains('IjbFje') ||
                participant.querySelector('.IjbFje');

              if (hasActiveBorder) {
                speakerName =
                  participant.getAttribute('data-self-name') ||
                  participant.querySelector('[data-self-name]')?.getAttribute('data-self-name') ||
                  null;
                break;
              }
            }
          }

          return speakerName;
        };

        // Observer les mutations du DOM
        const observer = new MutationObserver((mutations) => {
          const speaker = detectActiveSpeaker();
          if (speaker && speaker !== (window as any).__lastSpeaker) {
            (window as any).__lastSpeaker = speaker;
            (window as any).__speakerEvents.push({
              speaker,
              timestamp: Date.now(),
            });
          }
        });

        // Observer le container principal
        const container = document.body;
        observer.observe(container, {
          attributes: true,
          attributeFilter: [
            'class',
            'style',
            'data-is-speaking',
            'data-is-active-speaker',
            // Teams v2 attributes
            'data-stream-type',
            'data-tid',
            'aria-label',
          ],
          childList: true,
          subtree: true,
        });

        // Vérification initiale
        const initialSpeaker = detectActiveSpeaker();
        if (initialSpeaker) {
          (window as any).__lastSpeaker = initialSpeaker;
          (window as any).__speakerEvents.push({
            speaker: initialSpeaker,
            timestamp: Date.now(),
          });
        }

        (window as any).__speakerObserver = observer;
      },
      { platform: this.platform, selectors } as { platform: string; selectors: Record<string, string> },
    );

    // Collecter les events périodiquement
    this.collectEventsFromPage();
  }

  /**
   * Collecte les events de speaker depuis la page
   */
  private async collectEventsFromPage(): Promise<void> {
    const collectInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(collectInterval);
        return;
      }

      try {
        const events = await this.page.evaluate(() => {
          const events = (window as any).__speakerEvents || [];
          (window as any).__speakerEvents = []; // Vider après lecture
          return events;
        });

        for (const event of events) {
          this.handleSpeakerChange(event.speaker, event.timestamp);
        }
      } catch (error) {
        // Page peut être fermée
        if (this.isRunning) {
          logger.warn('Failed to collect speaker events:', error as Error);
        }
      }
    }, 100); // Collecter toutes les 100ms
  }

  /**
   * Polling de backup pour détecter le speaker
   */
  private startPolling(): void {
    const poll = async () => {
      if (!this.isRunning) return;

      try {
        const speaker = await this.detectCurrentSpeaker();
        if (speaker && speaker !== this.currentSpeaker) {
          this.handleSpeakerChange(speaker, Date.now());
        }
      } catch (error) {
        // Ignorer les erreurs de polling
      }

      setTimeout(poll, 500); // Poll toutes les 500ms
    };

    poll();
  }

  /**
   * Détecte le speaker actuel via Playwright
   */
  private async detectCurrentSpeaker(): Promise<string | null> {
    const selectors = NativeSpeakerDetector.PLATFORM_SELECTORS[this.platform];

    try {
      switch (this.platform) {
        case 'ZOOM':
          return await this.page.evaluate((sel) => {
            const active = document.querySelector(sel);
            if (!active) return null;
            const nameEl = active.closest('[class*="video-avatar"]')?.querySelector('.video-avatar__avatar-title');
            return nameEl?.textContent?.trim() || null;
          }, selectors.activeSpeaker);

        case 'TEAMS':
          return await this.page.evaluate(
            ({ activeSpeaker, participantName }) => {
              const active = document.querySelector(activeSpeaker);
              if (!active) return null;
              // Try attribute first, then child element selectors
              const name =
                active.getAttribute('data-participant-name') ||
                active.getAttribute('aria-label') ||
                active.querySelector(participantName)?.textContent?.trim() ||
                null;
              return name;
            },
            { activeSpeaker: selectors.activeSpeaker, participantName: selectors.participantName },
          );

        case 'GOOGLE_MEET':
          return await this.page.evaluate(() => {
            // Google Meet: chercher l'élément avec la bordure bleue active
            const participants = document.querySelectorAll('[data-participant-id]');
            for (const p of participants) {
              const hasBlueBorder =
                p.querySelector('.IjbFje') || getComputedStyle(p).boxShadow.includes('66, 133, 244');
              if (hasBlueBorder) {
                return p.getAttribute('data-self-name') || null;
              }
            }
            return null;
          });

        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Gère un changement de speaker
   */
  private handleSpeakerChange(speaker: string, timestamp: number): void {
    const relativeTime = (timestamp - this.recordingStartTime) / 1000;

    // Émettre l'event de fin pour l'ancien speaker
    if (this.currentSpeaker) {
      const duration = relativeTime - this.speakerStartTime;
      this.emit('speakerEnd', {
        speaker: this.currentSpeaker,
        startTime: this.speakerStartTime,
        endTime: relativeTime,
        duration,
      });
    }

    // Nouveau speaker
    this.currentSpeaker = speaker;
    this.speakerStartTime = relativeTime;

    const event: SpeakerEvent = {
      speaker,
      startTime: relativeTime,
      platform: this.platform,
    };

    this.speakerHistory.push(event);
    this.emit('speakerChange', event);

    logger.debug(`Speaker changed to: ${speaker} at ${relativeTime.toFixed(1)}s`);
  }

  /**
   * Arrête la détection. Idempotent — safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    // Final collection of any pending events before stopping
    try {
      const events = await this.page.evaluate(() => {
        const events = (window as any).__speakerEvents || [];
        (window as any).__speakerEvents = [];
        return events;
      });
      for (const event of events) {
        this.handleSpeakerChange(event.speaker, event.timestamp);
      }
    } catch {
      // Page may be closed — any uncollected events are lost (non-fatal)
    }

    // Finaliser le dernier segment
    if (this.currentSpeaker) {
      const endTime = (Date.now() - this.recordingStartTime) / 1000;
      this.emit('speakerEnd', {
        speaker: this.currentSpeaker,
        startTime: this.speakerStartTime,
        endTime,
        duration: endTime - this.speakerStartTime,
      });
    }

    // Nettoyer l'observer dans la page
    try {
      await this.page.evaluate(() => {
        if ((window as any).__speakerObserver) {
          (window as any).__speakerObserver.disconnect();
        }
      });
    } catch {
      // Page peut être fermée
    }

    logger.info(`Speaker detection stopped. Total speakers detected: ${this.speakerHistory.length}`);
  }

  /**
   * Retourne l'historique des speakers
   */
  getSpeakerHistory(): SpeakerEvent[] {
    return [...this.speakerHistory];
  }

  /**
   * Associe les segments audio avec les speakers détectés
   */
  matchAudioWithSpeakers(
    audioSegments: Array<{ text: string; startTime: number; endTime: number }>,
  ): Array<{ text: string; startTime: number; endTime: number; speaker: string }> {
    return audioSegments.map((segment) => {
      // Trouver le speaker actif au moment de ce segment
      const matchingSpeaker = this.speakerHistory.find((s, index) => {
        const nextSpeaker = this.speakerHistory[index + 1];
        const speakerEndTime = nextSpeaker?.startTime || Infinity;
        return segment.startTime >= s.startTime && segment.startTime < speakerEndTime;
      });

      return {
        ...segment,
        speaker: matchingSpeaker?.speaker || 'Unknown',
      };
    });
  }
}

/**
 * Factory function
 */
export function createSpeakerDetector(page: Page, platform: 'ZOOM' | 'TEAMS' | 'GOOGLE_MEET'): NativeSpeakerDetector {
  return new NativeSpeakerDetector(page, platform);
}
