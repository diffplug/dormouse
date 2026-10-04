import type { AlarmUpsell } from '../lib/alarm-upsell';
import { hostedPageUrl, HOSTED_REFS, type HostedRef } from '../lib/hosted-links';
import { TEXT_LINK_CLASS } from './ExternalTextLink';
import { NO_PLAN_COPY } from './ManagedVoiceSection';
import { NO_PUSH_PLAN_COPY } from './SettingsDialog';
import { SIGN_IN_LABEL } from './HostedSignIn';
import { getPlatform } from '../lib/platform';

/** The Settings topics a line opens: where each sign-in, and adding a phone, live. */
export type UpsellTopic = 'notifications' | 'network';

/**
 * Each offer's words, in the sign-in flow's own (`HostedSignIn.tsx`,
 * `ManagedVoiceSection.tsx`), and where it goes: a Settings topic, or the
 * Hosted plans with the preview's attribution.
 */
const ALARM_UPSELL: Record<AlarmUpsell, { lead?: string; action: string; topic?: UpsellTopic; ref?: HostedRef }> = {
  'sign-in-voice': { action: `${SIGN_IN_LABEL} for a natural ElevenLabs voice`, topic: 'notifications' },
  'sign-in-push': { action: `${SIGN_IN_LABEL} to get push on your phone`, topic: 'network' },
  'plans-voice': { lead: NO_PLAN_COPY, action: 'See Hosted plans', ref: HOSTED_REFS.upsellVoice },
  'plans-push': { lead: NO_PUSH_PLAN_COPY, action: 'See Hosted plans', ref: HOSTED_REFS.upsellPush },
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
  const { lead, action, topic, ref } = ALARM_UPSELL[upsell];
  return (
    <div className="mt-3 border-t border-border pt-2 text-sm leading-relaxed">
      {lead ? <span className="text-muted">{lead} </span> : null}
      <button
        type="button"
        data-alarm-upsell={upsell}
        className={`${TEXT_LINK_CLASS} text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (topic) onShowSettings(topic);
          else getPlatform().openExternal?.(hostedPageUrl('pricing', ref));
          onDone();
        }}
      >
        {action}
      </button>
    </div>
  );
}
