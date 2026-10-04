import type { AlarmUpsell } from '../lib/alarm-upsell';
import { hostedPageUrl, HOSTED_REFS, type HostedRef, type HostedSection } from '../lib/hosted-links';
import { ExternalTextLink, TEXT_LINK_CLASS } from './ExternalTextLink';
import { getPlatform } from '../lib/platform';

/**
 * Each offer's one wording, and the Hosted page section it opens with the
 * preview's attribution; `set-up-phone` opens Settings → Network instead.
 */
const ALARM_UPSELL: Record<AlarmUpsell, { copy: string; section?: HostedSection; ref?: HostedRef }> = {
  'hosted-voice': { copy: 'ElevenLabs voices come with Dormouse Hosted', section: 'voice', ref: HOSTED_REFS.upsellVoice },
  'hosted-push': { copy: 'Get Pocket on your phone with Dormouse Hosted', section: 'remote-control', ref: HOSTED_REFS.upsellPush },
  'set-up-phone': { copy: 'Set up a phone in Settings → Network' },
};

/** A Hosted offer as the Settings dialog's prose link: the same words, no attribution. */
export function HostedOfferLink({ offer }: { offer: 'hosted-voice' | 'hosted-push' }) {
  const { copy, section } = ALARM_UPSELL[offer];
  return <ExternalTextLink href={hostedPageUrl(section!)}>{copy}.</ExternalTextLink>;
}

/**
 * The preview's live line. Pressing it never moves focus, so the terminal keeps
 * the keyboard; it is still a button Tab can reach.
 */
export function AlarmUpsellLine({ upsell, onShowNetwork, onDone }: {
  upsell: AlarmUpsell;
  /** Opens Settings at Network, for `set-up-phone`. */
  onShowNetwork: () => void;
  /** The line did its job; the preview closes. */
  onDone: () => void;
}) {
  const { copy, section, ref } = ALARM_UPSELL[upsell];
  return (
    <div className="mt-3 border-t border-border pt-2 text-sm leading-relaxed">
      <button
        type="button"
        data-alarm-upsell={upsell}
        className={`${TEXT_LINK_CLASS} text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (section) getPlatform().openExternal?.(hostedPageUrl(section, ref));
          else onShowNetwork();
          onDone();
        }}
      >
        {copy}
      </button>
    </div>
  );
}
