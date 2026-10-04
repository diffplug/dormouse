import type { AlarmUpsell } from '../lib/alarm-upsell';
import { HOSTED_REFS, hostedPageUrl } from '../lib/hosted-links';
import { ExternalTextLink } from './ExternalTextLink';
import { getPlatform } from '../lib/platform';

/** The one wording of each offer, shared by the preview line and Settings. */
export const ALARM_UPSELL_COPY: Record<AlarmUpsell, string> = {
  'hosted-voice': 'ElevenLabs voices come with Dormouse Hosted',
  'hosted-push': 'Get Pocket on your phone with Dormouse Hosted',
  'set-up-phone': 'Set up a phone in Settings → Network',
};

/** The push group's Hosted offer inside the Settings dialog. */
export function HostedPushLink() {
  return (
    <ExternalTextLink href={hostedPageUrl('remote-control')}>
      {ALARM_UPSELL_COPY['hosted-push']}.
    </ExternalTextLink>
  );
}

const LINE_ACTION_CLASS =
  'text-left text-foreground underline underline-offset-2 hover:text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring';

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
  const act = (): void => {
    if (upsell === 'set-up-phone') onShowNetwork();
    else {
      const href = upsell === 'hosted-voice'
        ? hostedPageUrl('voice', HOSTED_REFS.upsellVoice)
        : hostedPageUrl('remote-control', HOSTED_REFS.upsellPush);
      getPlatform().openExternal?.(href);
    }
    onDone();
  };
  return (
    <div className="mt-3 border-t border-border pt-2 text-sm leading-relaxed">
      <button
        type="button"
        data-alarm-upsell={upsell}
        className={LINE_ACTION_CLASS}
        onMouseDown={(event) => event.preventDefault()}
        onClick={act}
      >
        {ALARM_UPSELL_COPY[upsell]}
      </button>
    </div>
  );
}
