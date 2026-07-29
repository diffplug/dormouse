import type { AlertManager } from './alert-manager';
import {
  DEFAULT_ALERT_SETTINGS,
  normalizeAlertSettings,
  type AlertSettings,
} from './alert-settings';

type AlertSettingsTarget = Pick<AlertManager, 'setInactivityTimeoutMs'>;

/**
 * Coordinates one host-authoritative alarm-settings blob across multiple
 * renderers, the same way `WatchedCommandHost` does for the WATCHING rule set.
 * The first renderer seeds persisted settings after a fresh host start; later
 * renderers receive that canonical state instead of replacing it.
 *
 * Only `inactivityTimeoutMs` means anything to the host's `AlertManager`. The
 * renderer-only fields are held purely so every webview reads back the same
 * values (`docs/specs/alert.md` -> Alarm settings).
 */
export class AlertSettingsHost {
  private initialized = false;
  private settings: AlertSettings = DEFAULT_ALERT_SETTINGS;
  private listeners = new Set<(settings: AlertSettings) => void>();

  constructor(private readonly target: AlertSettingsTarget) {}

  /** Offered by every renderer at startup; only the first offer is taken. */
  initialize(value: unknown): void {
    if (!this.initialized) {
      this.initialized = true;
      this.apply(value);
    }
    this.publish();
  }

  /** An explicit edit from a renderer. Always authoritative. */
  update(value: unknown): void {
    this.initialized = true;
    this.apply(value);
    this.publish();
  }

  subscribe(listener: (settings: AlertSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private apply(value: unknown): void {
    // Renderer input is revalidated here: the host must never install a NaN or
    // absurd timer because a webview sent one (`docs/specs/transport.md`).
    this.settings = normalizeAlertSettings(value);
    this.target.setInactivityTimeoutMs(this.settings.inactivityTimeoutMs);
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.settings);
  }
}
