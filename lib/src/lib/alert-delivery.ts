import type { AlertDelivery } from './alert-delivery-scheduler';
import { collectDeliveryOverrides } from './alert-delivery-policy';
import { startAlertSpeech } from './alert-speech';
import { getPlatform } from './platform';
import { deriveSessionLabel } from './session-label';
import { subscribeToWorkspaces } from './workspace-store';
import { subscribeToWorkspaceSurfaces } from './workspace-surfaces';

/**
 * This realm's half of ring delivery (`docs/specs/alert.md` -> Alarm
 * settings). The host decides when a ring is spoken or pushed; the realm tells
 * it what only the renderer knows — which Workspace each Session is in, and
 * that Workspace's overrides — and performs what it is handed, which needs the
 * Pane's label and, for speech, `window.speechSynthesis`.
 */

/** The running performer, if any. The platform keeps its handlers for the
 *  renderer's lifetime, so this stable one is registered and never removed. */
let perform: ((delivery: AlertDelivery) => void) | null = null;
const onDeliver = (delivery: AlertDelivery): void => perform?.(delivery);

export function startAlertDelivery(): () => void {
  const platform = getPlatform();
  const speaker = startAlertSpeech();

  let published: string | null = null;
  const publish = (): void => {
    const overrides = collectDeliveryOverrides();
    // Every Lath commit and Workspace edit lands here; only a change is news.
    const key = JSON.stringify(overrides);
    if (key === published) return;
    published = key;
    platform.alertPublishDeliveryPolicy(overrides);
  };
  const stops = [subscribeToWorkspaces(publish), subscribeToWorkspaceSurfaces(publish)];
  publish();

  platform.onAlertDeliver(onDeliver);
  perform = (delivery) => {
    if (delivery.sink === 'speech') {
      speaker.speak(delivery.id, delivery.episodeId);
      return;
    }
    // The Burrow's service reads its own ACL at send time; a host with none
    // has no link, and an un-enrolled one sends nothing.
    void platform.burrow?.command('push', { sessionId: delivery.id, title: deriveSessionLabel(delivery.id) })
      .catch(() => {});
  };

  return () => {
    perform = null;
    stops.forEach((stop) => stop());
    speaker.stop();
  };
}
