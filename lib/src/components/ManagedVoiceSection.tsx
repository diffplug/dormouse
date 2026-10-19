import { useCallback, useState, useSyncExternalStore } from 'react';
import { INLINE_ACTION_CLASS, SELECT_CLASS, modalActionButton } from './design';
import { ExternalTextLink } from './ExternalTextLink';
import { HOSTED_PRICING_URL, HostedEnrollView, accountHost, accountPage } from './HostedEnrollment';
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
  reenrollBurrow,
  subscribeToBurrowStatus,
} from '../remote/burrow/burrow-status-store';

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

/** Whether this build offers managed voice at all: a Hosted standalone build's port. */
export function useManagedVoiceOffered(): boolean {
  return getPlatform().managedVoice !== undefined;
}

/** Whether a voice token is saved, so alerts may reach Hosted in the managed voice. */
export function useManagedVoiceConfigured(): boolean {
  return useManagedVoiceStatus(getPlatform().managedVoice)?.configured === true;
}

/**
 * Managed voice in Settings → Notifications (`docs/specs/alert.md` ->
 * "Settings dialog"): enrolling with Dormouse Hosted, which is this computer's
 * Hosted enrollment ({@link HostedEnrollView}, shared with Remote control),
 * then the member's voice and Disconnect. Renders nothing in a build without
 * managed voice — a self-host build, VS Code.
 */
export function ManagedVoiceSection({ onShowNetwork }: { onShowNetwork?: () => void }) {
  const port = getPlatform().managedVoice;
  const voice = useManagedVoiceStatus(port);
  const burrow = useSyncExternalStore(subscribeToBurrowStatus, getBurrowStatusSnapshot);
  const networkOff = useNetworkPolicy()?.level === 'nothing';
  // Enroll again spans the flip from enrolled to not, so its busy and error
  // live here, above both views: a begin refused after the clear still has
  // somewhere to say so.
  const enrollAgainAction = useBusyAction();

  if (!port) return null;
  const status = burrow.kind === 'ready' ? burrow.status : null;

  return (
    <div className="mt-3">
      <div className="text-sm text-foreground">Managed voice</div>
      <p className={HINT}>{MANAGED_VOICE_DISCLOSURE}</p>
      {status === null ? null : status.enrolled ? (
        <Enrolled
          status={status}
          voice={voice}
          port={port}
          enrollingAgain={enrollAgainAction.busy}
          onEnrollAgain={() => void enrollAgainAction.run(() => reenrollBurrow(status.suggestedLabel))}
        />
      ) : (
        <>
          <p className={HINT}>Dormouse Hosted members hear alarms in a natural ElevenLabs voice.</p>
          {networkOff ? (
            <p className={HINT}>
              Enrolling reaches Dormouse Hosted, which nothing does while <NetworkTopicLink onShow={onShowNetwork} />{' '}
              is set to Nowhere. Choose Local networks or Anywhere there to enroll.
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
      {enrollAgainAction.error ? <div className="mt-1.5 text-sm text-error">{enrollAgainAction.error}</div> : null}
    </div>
  );
}

/** Enrolled: the plan's standing, the voice, and Disconnect. */
function Enrolled({ status, voice, port, enrollingAgain, onEnrollAgain }: {
  status: BurrowConsoleStatus;
  voice: ManagedVoiceStatus | null;
  port: ManagedVoicePort;
  enrollingAgain: boolean;
  onEnrollAgain: () => void;
}) {
  const { busy: ownBusy, error, run } = useBusyAction();
  const busy = ownBusy || enrollingAgain;
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
        <div className="text-foreground">Enrolled with Dormouse Hosted.</div>
      )}
      {!removed && voice && !voice.configured ? (
        <p className={HINT}>
          This computer enrolled before managed voice. Disconnect and enroll again to use it.
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
            onClick={onEnrollAgain}
          >
            {enrollingAgain ? 'Getting a code…' : 'Enroll again'}
          </button>
        ) : confirming ? (
          <DisconnectConfirm
            busy={busy}
            run={run}
            onDone={() => setConfirming(false)}
            warning="Remote control disconnects too: paired phones will need to pair again."
          />
        ) : (
          <button type="button" disabled={busy} className={modalActionButton()} onClick={() => setConfirming(true)}>
            Disconnect
          </button>
        )}
      </div>
      {page && !removed ? (
        <p className={HINT}>
          Disconnecting is local. <ExternalTextLink href={page}>Remove this computer at {accountHost(status.accountOrigin)}</ExternalTextLink>{' '}
          to revoke it there.
        </p>
      ) : null}
    </div>
  );
}
