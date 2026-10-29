import type { AlarmUpsell } from '../lib/alarm-upsell';
import { HOSTED_REFS, type HostedRef } from '../lib/hosted-links';
import { TEXT_LINK_CLASS } from './ExternalTextLink';
import { HostedPlansLink } from './HostedEnrollment';
import { NO_PLAN_COPY } from './ManagedVoiceSection';
import type { TopicId } from './SettingsDialog';

/** The Settings topics a line opens: managed voice's, and the Relay's. */
export type UpsellTopic = Extract<TopicId, 'notifications' | 'network'>;

/** Choosing a network level, in Network's own words, for an offer Nothing blocks. */
const CHOOSE_LEVEL = 'Choose Local networks or Anywhere in Settings → Network';

/**
 * Each offer: an action opening a Settings topic, or the plans with the
 * offer's ref. Push's no-plan line has no lead because the preview's inert
 * device line above it already says why no push is sent.
 */
const OFFERS: Record<AlarmUpsell, { lead?: string } & ({ action: string; topic: UpsellTopic } | { plans: HostedRef })> = {
  'voice-turn-on': { action: 'Turn on Natural Voice in Settings → Notifications', topic: 'notifications' },
  'voice-network': { action: `${CHOOSE_LEVEL} to turn on Natural Voice`, topic: 'network' },
  'voice-plans': { lead: NO_PLAN_COPY, plans: HOSTED_REFS.upsellVoice },
  'push-hosted-relay': { action: 'Get push on your phone with the Hosted Relay in Settings → Network', topic: 'network' },
  'push-network': { action: `${CHOOSE_LEVEL} to get push on your phone`, topic: 'network' },
  'push-plans': { plans: HOSTED_REFS.upsellPush },
  'push-set-up-phone': { action: 'Set up a phone in Settings → Network', topic: 'network' },
};

/**
 * The preview's live line. Pressing it never moves focus, so the terminal
 * keeps the keyboard; its button is still one Tab reaches.
 */
export function AlarmUpsellLine({ upsell, onShowSettings, onDone }: {
  upsell: AlarmUpsell;
  onShowSettings: (topic: UpsellTopic) => void;
  /** The line did its job; the preview closes. */
  onDone: () => void;
}) {
  const offer = OFFERS[upsell];
  return (
    <div
      data-alarm-upsell={upsell}
      className="mt-3 border-t border-border pt-2 text-sm leading-relaxed"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button')) onDone();
      }}
    >
      {offer.lead ? <span className="text-muted">{offer.lead} </span> : null}
      {'plans' in offer ? (
        <HostedPlansLink from={offer.plans} />
      ) : (
        <button
          type="button"
          className={`${TEXT_LINK_CLASS} text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring`}
          onClick={() => onShowSettings(offer.topic)}
        >
          {offer.action}
        </button>
      )}
    </div>
  );
}
