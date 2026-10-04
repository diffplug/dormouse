import { useCallback, useState, useSyncExternalStore } from 'react';
import { INLINE_ACTION_CLASS, SELECT_CLASS, modalActionButton } from './design';
import { ExternalTextLink } from './ExternalTextLink';
import { HOSTED_PRICING_URL, HostedEnrollView, accountHost, accountPage } from './HostedSignIn';
import { DisconnectConfirm, removedCopy } from './RemoteControlSection';
import { FIELD_LABEL, useBusyAction, useNetworkPolicy } from './remote-control-shared';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import { getPlatform } from '../lib/platform';
import {
  MANAGED_VOICES,
  type ManagedVoiceConfigResult,
  type ManagedVoicePort,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';
import {
  getBurrowStatusSnapshot,
  signInAgain,
  subscribeToBurrowStatus,
} from '../remote/burrow/burrow-status-store';

const HINT = 'mt-1 text-sm leading-relaxed text-muted';

const REFUSAL: Record<Exclude<ManagedVoiceConfigResult, { ok: true }>['reason'], string> = {
  'invalid-voice': 'That voice is not one Dormouse Hosted offers.',
  unavailable: 'This app could not save the managed voice setting.',
};

/** What leaves this computer, said before the first request (`docs/specs/pricing.md` -> "Managed voice"). */
export const MANAGED_VOICE_DISCLOSURE =
  'Only the spoken pane label and the voice you choose are sent to voice.dormouse.sh, which has ElevenLabs ' +
  'speak it. Dormouse asks ElevenLabs to delete its copy shortly after each alarm and sweeps every five ' +
  'minutes for any it missed; no deletion time is guaranteed. If Hosted cannot answer, the alarm uses your ' +
  'system voice.';

/** What a member whose plan lapsed reads, where the relay socket or speak said so. */
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

/** Whether this build offers managed voice at all: a Hosted desktop build's port. */
export function useManagedVoiceOffered(): boolean {
  return getPlatform().managedVoice !== undefined;
}

/** Whether a voice token is saved, so alerts may reach Hosted in the managed voice. */
export function useManagedVoiceConfigured(): boolean {
  return useManagedVoiceStatus(getPlatform().managedVoice)?.configured === true;
}

/**
 * Managed voice in Settings → Notifications (`docs/specs/alert.md` ->
 * "Settings dialog"): signing in to Dormouse Hosted, which is this computer's
 * Hosted enrollment ({@link HostedEnrollView}, shared with Remote control),
 * then the member's voice and Sign out. Renders nothing in a build without
 * managed voice — a self-host build.
 */
export function ManagedVoiceSection({ onShowNetwork }: { onShowNetwork?: () => void }) {
  const port = getPlatform().managedVoice;
  const voice = useManagedVoiceStatus(port);
  const burrow = useSyncExternalStore(subscribeToBurrowStatus, getBurrowStatusSnapshot);
  const networkOff = useNetworkPolicy()?.level === 'nothing';
  // Sign in again spans the flip from signed in to not, so its busy and error
  // live here, above both views: a begin refused after the clear still has
  // somewhere to say so.
  const signInAgainAction = useBusyAction();

  if (!port) return null;
  const status = burrow.kind === 'ready' ? burrow.status : null;

  return (
    <div className="mt-3">
      <div className="text-sm text-foreground">Managed voice</div>
      <p className={HINT}>{MANAGED_VOICE_DISCLOSURE}</p>
      {status === null ? null : status.enrolled ? (
        <SignedIn
          status={status}
          voice={voice}
          port={port}
          signingInAgain={signInAgainAction.busy}
          onSignInAgain={() => void signInAgainAction.run(() => signInAgain(status.suggestedLabel))}
        />
      ) : (
        <>
          <p className={HINT}>Dormouse Hosted members hear alarms in a natural ElevenLabs voice.</p>
          {networkOff ? (
            <p className={HINT}>
              Signing in reaches Dormouse Hosted, which nothing does while <NetworkTopicLink onShow={onShowNetwork} />{' '}
              is set to Nothing. Choose Local networks or Anywhere there to sign in.
            </p>
          ) : (
            <HostedEnrollView
              enrollment={status.hostedEnrollment}
              accountOrigin={status.accountOrigin}
              suggestedLabel={status.suggestedLabel}
              askName={false}
            />
          )}
        </>
      )}
      {signInAgainAction.error ? <div className="mt-1.5 text-sm text-error">{signInAgainAction.error}</div> : null}
    </div>
  );
}

/** Signed in: the plan's standing, the voice, and Sign out. */
function SignedIn({ status, voice, port, signingInAgain, onSignInAgain }: {
  status: BurrowConsoleStatus;
  voice: ManagedVoiceStatus | null;
  port: ManagedVoicePort;
  signingInAgain: boolean;
  onSignInAgain: () => void;
}) {
  const { busy: ownBusy, error, run } = useBusyAction();
  const busy = ownBusy || signingInAgain;
  const [confirming, setConfirming] = useState(false);
  const page = accountPage(status.accountOrigin);
  const lapsed = status.connection === 'not-entitled' || voice?.notEntitled === true;
  const removed = status.connection === 'removed';

  const choose = (voiceId: string) =>
    void run(async () => {
      const result = await port.configure({ voiceId });
      if (!result.ok) throw new Error(REFUSAL[result.reason]);
    });

  return (
    <div className="mt-2 text-sm leading-relaxed">
      {removed ? (
        <div className="text-error">{removedCopy(status)}</div>
      ) : lapsed ? (
        <div className="text-foreground">
          {NO_PLAN_COPY} <ExternalTextLink href={HOSTED_PRICING_URL}>See Hosted plans</ExternalTextLink>
        </div>
      ) : (
        <div className="text-foreground">Signed in to Dormouse Hosted.</div>
      )}
      {!removed && voice && !voice.configured ? (
        <p className={HINT}>
          This computer signed in before managed voice. Sign out and sign in again to use it.
        </p>
      ) : null}
      {!removed && voice?.configured ? (
        <label className="mt-2 flex items-center gap-2">
          <span className={FIELD_LABEL}>Voice</span>
          <select
            aria-label="Managed voice"
            className={SELECT_CLASS}
            value={voice.voiceId}
            disabled={busy}
            onChange={(event) => choose(event.target.value)}
          >
            {MANAGED_VOICES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({option.description})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {error ? <div className="mt-1.5 text-error">{error}</div> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {removed ? (
          <button
            type="button"
            disabled={busy}
            className={modalActionButton({ tone: 'primary' })}
            onClick={onSignInAgain}
          >
            {signingInAgain ? 'Getting a code…' : 'Sign in again'}
          </button>
        ) : confirming ? (
          <DisconnectConfirm
            busy={busy}
            run={run}
            onDone={() => setConfirming(false)}
            label="Sign out"
            warning="Remote control signs out too: paired phones will need to pair again."
          />
        ) : (
          <button type="button" disabled={busy} className={modalActionButton()} onClick={() => setConfirming(true)}>
            Sign out
          </button>
        )}
      </div>
      {page && !removed ? (
        <p className={HINT}>
          Signing out is local. <ExternalTextLink href={page}>Remove this computer at {accountHost(status.accountOrigin)}</ExternalTextLink>{' '}
          to revoke it there.
        </p>
      ) : null}
    </div>
  );
}
