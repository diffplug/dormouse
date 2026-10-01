import type { AlertSessionInfo } from '../host/alert-protocol';
import { sameAlertDeliveryOverrides, type AlertDeliveryOverrides } from './alert-delivery-model';
import { subscribeToAlertDeliveryPolicy } from './alert-delivery-policy';
import { startAlertSpeech } from './alert-speech';
import { getPlatform } from './platform';
import { getActivitySnapshot, subscribeToActivity } from './session-activity-store';
import { deriveSessionLabels } from './session-label';
import { getTerminalPaneStateSnapshot, subscribeToTerminalPaneState } from './terminal-state-store';
import { getWorkspace, getWorkspacesSnapshot } from './workspace-store';
import { getWorkspaceSurfacesSnapshot } from './workspace-surfaces';

/**
 * This realm's half of ring delivery (`docs/specs/alert.md` -> Alarm
 * settings). The host decides when a ring is spoken or pushed, and sends the
 * push itself; the realm tells it what only the renderer knows — each
 * Session's Pane label and its Workspace's overrides — and speaks what it is
 * handed, which needs `window.speechSynthesis`.
 */

/** How long a label change waits to be published: Claude Code animates its
 *  title about ten times a second, and only a due push reads the label. */
export const LABEL_PUBLISH_THROTTLE_MS = 2_000;

const NO_OVERRIDES: AlertDeliveryOverrides = {};

export function startAlertDelivery(): () => void {
  const platform = getPlatform();
  const speaker = startAlertSpeech();
  const stopPublishing = publishAlertSessions((sessions) => platform.alertPublishSessions(sessions));
  const stopSpeaking = platform.onAlertSpeak(({ id, episodeId }) => speaker.speak(id, episodeId));
  return () => {
    stopSpeaking();
    stopPublishing();
    speaker.stop();
  };
}

/**
 * Publish every member Session whenever what the host reads of it changed: a
 * membership or override change at the end of the task that made it, so
 * disabling a sink consumes its pending work at once, and a label change on a
 * trailing throttle.
 */
function publishAlertSessions(send: (sessions: Record<string, AlertSessionInfo>) => void): () => void {
  let sent = new Map<string, AlertSessionInfo>();
  /** The snapshots the last pass read; the same four mean nothing changed. */
  let inputs: readonly unknown[] = [];
  /** Sessions whose label may have changed since that pass; `null` for all. */
  let stale: Set<string> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = 0;

  function schedule(delayMs: number): void {
    const at = Date.now() + delayMs;
    if (timer !== null) {
      if (dueAt <= at) return;
      clearTimeout(timer);
    }
    dueAt = at;
    timer = setTimeout(flush, delayMs);
  }

  function labelMayChange(changedId?: string): void {
    if (changedId === undefined) stale = null;
    else stale?.add(changedId);
    schedule(LABEL_PUBLISH_THROTTLE_MS);
  }

  function flush(): void {
    timer = null;
    const surfaces = getWorkspaceSurfacesSnapshot();
    const next = [surfaces, getWorkspacesSnapshot(), getTerminalPaneStateSnapshot(), getActivitySnapshot()];
    if (next.every((input, index) => input === inputs[index])) return;
    inputs = next;

    const derive: string[] = [];
    for (const ids of surfaces.values()) {
      for (const id of ids) if (!stale || stale.has(id) || !sent.has(id)) derive.push(id);
    }
    const labels = deriveSessionLabels(derive);
    stale = new Set();

    const published = new Map<string, AlertSessionInfo>();
    let changed = false;
    for (const [workspaceId, ids] of surfaces) {
      const overrides = getWorkspace(workspaceId)?.alertDelivery ?? NO_OVERRIDES;
      for (const id of ids) {
        const prior = sent.get(id);
        const label = labels.get(id) ?? prior!.label;
        const same = prior !== undefined && prior.label === label && sameAlertDeliveryOverrides(prior.overrides, overrides);
        published.set(id, same ? prior : { label, overrides });
        if (!same) changed = true;
      }
    }
    if (!changed && published.size === sent.size) return;
    sent = published;
    send(Object.fromEntries(published));
  }

  const stops = [
    subscribeToAlertDeliveryPolicy(() => schedule(0)),
    subscribeToTerminalPaneState(labelMayChange),
    subscribeToActivity(labelMayChange),
  ];
  // Folded into the first membership change when the Wall is still mounting.
  schedule(0);
  return () => {
    stops.forEach((stop) => stop());
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
