import { useCallback, useState, useSyncExternalStore } from 'react';
import { INLINE_ACTION_CLASS, SELECT_CLASS, modalActionButton } from './design';
import { ExternalTextLink } from './ExternalTextLink';
import { HOSTED_PRICING_URL, HostedEnrollmentCode } from './HostedEnrollment';
import { FIELD_LABEL, useBusyAction, useNetworkPolicy } from './remote-control-shared';
import { getPlatform } from '../lib/platform';
import {
  MANAGED_VOICES,
  type ManagedVoiceConfigResult,
  type ManagedVoiceActionResult,
  type ManagedVoicePort,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';

const HINT = 'mt-1 text-sm leading-relaxed text-muted';

const REFUSAL: Record<Exclude<ManagedVoiceConfigResult, { ok: true }>['reason'], string> = {
  'invalid-voice': 'That voice is not one Dormouse Hosted offers.',
  unavailable: 'This app could not save the managed voice setting.',
};

/** What leaves this computer, said before the first request (`docs/specs/alert.md` -> "Settings dialog"). */
export const MANAGED_VOICE_DISCLOSURE =
  'Only the spoken pane label and the voice you choose are sent to voice.dormouse.sh, which has ElevenLabs ' +
  'speak it. ElevenLabs keeps a copy until Dormouse deletes it, usually within minutes, though no limit is ' +
  'guaranteed. If voice.dormouse.sh cannot answer, the alarm uses your system voice.';

/** What a member whose plan lapsed reads after speak says so. */
export const NO_PLAN_COPY = 'Your account has no Hosted plan, so alarms use your system voice.';

/**
 * Where Settings → Network is named from another topic: a link to it inside the
 * dialog, and its path in the Baseboard's preview, which has no topic to reach.
 */
export function NetworkTopicLink({ onShow }: { onShow?: () => void }) {
  if (!onShow) return <>Settings → Network</>;
  return (
    <button type="button" className={INLINE_ACTION_CLASS} onClick={onShow}>
      Network
    </button>
  );
}

/** The port's cached status; `null` without a port or before the host answers. */
function useManagedVoiceStatus(port: ManagedVoicePort | undefined): ManagedVoiceStatus | null {
  const subscribe = useCallback((listener: () => void) => port?.subscribe(listener) ?? (() => {}), [port]);
  const snapshot = useCallback(() => port?.status() ?? null, [port]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Whether this build offers managed voice at all: a Hosted standalone build's port. */
export function useManagedVoiceOffered(): boolean {
  return getPlatform().managedVoice !== undefined;
}

/** Whether a voice token is saved, so alerts may reach Hosted in the managed voice. */
export function useManagedVoiceConfigured(): boolean {
  return useManagedVoiceStatus(getPlatform().managedVoice)?.configured === true;
}

/** Independent managed-voice approval and disconnect; remote control has its own enrollment. */
export function ManagedVoiceSection({ onShowNetwork }: { onShowNetwork?: () => void }) {
  const port = getPlatform().managedVoice;
  const voice = useManagedVoiceStatus(port);
  const networkOff = useNetworkPolicy()?.level === 'nothing';
  const { busy, error, run } = useBusyAction();
  const [confirming, setConfirming] = useState(false);
  if (!port) return null;
  const enrollment = voice?.enrollment;
  const waiting = enrollment?.status === 'waiting' ? enrollment : null;
  const saving = enrollment?.status === 'saving';
  const perform = (action: () => Promise<ManagedVoiceActionResult>) => void run(async () => {
    const result = await action();
    if (!result.ok) throw new Error(result.message);
    setConfirming(false);
  });

  return (
    <div className="mt-3">
      <div className="text-sm text-foreground">Managed voice</div>
      <p className={HINT}>{MANAGED_VOICE_DISCLOSURE}</p>
      {voice?.configured ? (
        <>
          <div className="mt-2 text-sm leading-relaxed text-foreground">
            {voice.notEntitled ? (
              <>{NO_PLAN_COPY} <ExternalTextLink href={HOSTED_PRICING_URL}>See Hosted plans</ExternalTextLink></>
            ) : 'Managed voice is enabled.'}
          </div>
          <label className="mt-2 flex items-center gap-2">
            <span className={FIELD_LABEL}>Voice</span>
            <select
              aria-label="Managed voice"
              className={SELECT_CLASS}
              value={voice.voiceId}
              disabled={busy}
              onChange={(event) => void run(async () => {
                const result = await port.configure({ voiceId: event.target.value });
                if (!result.ok) throw new Error(REFUSAL[result.reason]);
              })}
            >
              {MANAGED_VOICES.map((option) => (
                <option key={option.id} value={option.id}>{option.name} ({option.description})</option>
              ))}
            </select>
          </label>
          {confirming ? (
            <div className="mt-2 text-sm leading-relaxed">
              <p>Disconnect managed voice? Alarms will use your system voice.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busy} className={modalActionButton()} onClick={() => perform(() => port.disconnect())}>
                  Disconnect
                </button>
                <button type="button" disabled={busy} className={modalActionButton()} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" disabled={busy} className={modalActionButton({ className: 'mt-2' })} onClick={() => setConfirming(true)}>
              Disconnect
            </button>
          )}
        </>
      ) : voice?.disconnectFailed ? (
        <div className="mt-2">
          <p className={HINT}>Managed voice is off for this session, but disconnecting did not finish. Retry before restarting Dormouse.</p>
          <button type="button" disabled={busy} className={modalActionButton()} onClick={() => perform(() => port.disconnect())}>
            Retry disconnect
          </button>
        </div>
      ) : waiting ? (
        <HostedEnrollmentCode
          waiting={{ ...waiting, accountFull: false }}
          accountOrigin={new URL(waiting.verificationUrl).origin}
          busy={busy}
          onCancel={() => perform(() => port.cancelEnrollment())}
        />
      ) : saving ? (
        <p className={HINT}>Approved. Enabling managed voice…</p>
      ) : (
        <>
          {enrollment?.status === 'ended' ? <p className={HINT} role="status">{enrollment.message}</p> : null}
          {networkOff ? (
            <p className={HINT}>
              Enabling managed voice reaches Dormouse Hosted. Choose Local networks or Anywhere in <NetworkTopicLink onShow={onShowNetwork} /> to enable it.
            </p>
          ) : (
            <button
              type="button"
              disabled={busy || voice === null}
              className={modalActionButton({ tone: 'primary', className: 'mt-2' })}
              onClick={() => perform(() => port.beginEnrollment())}
            >
              Enable managed voice
            </button>
          )}
        </>
      )}
      {error ? <div className="mt-1.5 text-sm text-error" role="alert">{error}</div> : null}
    </div>
  );
}
