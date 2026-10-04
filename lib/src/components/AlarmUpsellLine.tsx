import type { AlarmUpsell } from '../lib/alarm-upsell';
import { hostedPricingUrl, HOSTED_REFS, type HostedRef } from '../lib/hosted-links';
import { TEXT_LINK_CLASS } from './ExternalTextLink';
import { NO_PLAN_COPY, NO_PUSH_PLAN_COPY } from './ManagedVoiceSection';
import type { TopicId } from './SettingsDialog';
import { PLANS_LABEL, SIGN_IN_LABEL } from './HostedSignIn';
import { getPlatform } from '../lib/platform';

/** The Settings topics a line opens: where each sign-in, and adding a phone, live. */
export type UpsellTopic = Extract<TopicId, 'notifications' | 'network'>;

/**
 * Each offer's words, in the sign-in flow's own (`HostedSignIn.tsx`,
 * `ManagedVoiceSection.tsx`), and where it goes: a Settings topic, or the
 * Hosted plans with the preview's attribution.
 */
type UpsellAction = { lead?: string; action: string } & (
  | { topic: UpsellTopic; ref?: never }
  | { ref: HostedRef; topic?: never }
);
const ALARM_UPSELL: Record<AlarmUpsell, UpsellAction> = {
  'sign-in-voice': { action: `${SIGN_IN_LABEL} for a natural ElevenLabs voice`, topic: 'notifications' },
  'sign-in-push': { action: `${SIGN_IN_LABEL} to get push on your phone`, topic: 'network' },
  'plans-voice': { lead: NO_PLAN_COPY, action: PLANS_LABEL, ref: HOSTED_REFS.upsellVoice },
  'plans-push': { lead: NO_PUSH_PLAN_COPY, action: PLANS_LABEL, ref: HOSTED_REFS.upsellPush },
  'set-up-phone': { action: 'Set up a phone in Settings → Network', topic: 'network' },
};

/**
 * The preview's live line. Pressing it never moves focus, so the terminal keeps
 * the keyboard; it is still a button Tab can reach.
 */
export function AlarmUpsellLine({ upsell, onShowSettings, onDone }: {
  upsell: AlarmUpsell;
  /** Opens Settings at a topic. */
  onShowSettings: (topic: UpsellTopic) => void;
  /** The line did its job; the preview closes. */
  onDone: () => void;
}) {
  const offer = ALARM_UPSELL[upsell];
  const { lead, action } = offer;
  return (
    <div className="mt-3 border-t border-border pt-2 text-sm leading-relaxed">
      {lead ? <span className="text-muted">{lead} </span> : null}
      <button
        type="button"
        data-alarm-upsell={upsell}
        className={`${TEXT_LINK_CLASS} text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (offer.topic) onShowSettings(offer.topic);
          else getPlatform().openExternal?.(hostedPricingUrl(offer.ref));
          onDone();
        }}
      >
        {action}
      </button>
    </div>
  );
}
