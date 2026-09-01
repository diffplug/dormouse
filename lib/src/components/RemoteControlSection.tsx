import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ModalReviewBlock, TextInput, modalActionButton } from './design';
import type { RemoteHostConsoleStatus } from '../host/remote/service-protocol';
import type { RemoteHostStatus } from '../remote/host/remote-host';
import {
  clearRemoteHostEnrollment,
  enrollOfferRemoteHost,
  enrollRemoteHost,
  getRemoteHostStatusSnapshot,
  reconnectRemoteHost,
  refreshRemoteHostStatus,
  subscribeToRemoteHostStatus,
} from '../remote/host/host-status-store';

/**
 * How each relay-socket state reads to someone who is not holding the spec.
 * `displaced` is the only one that needs the user to act, so it is the only one
 * that gets a button (`docs/specs/server.md`, "Relay socket policy").
 */
function describeConnection(connection: RemoteHostStatus): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (connection) {
    case 'connected':
      return { text: 'Connected', tone: 'ok' };
    case 'connecting':
      return { text: 'Connecting…', tone: 'muted' };
    case 'disconnected':
      return { text: 'Reconnecting…', tone: 'muted' };
    case 'displaced':
      return {
        text: 'Another Dormouse instance took this server’s slot. This machine stood down and will not retry on its own.',
        tone: 'warn',
      };
    case 'stopped':
      return { text: 'Stopped', tone: 'muted' };
    case 'idle':
      return { text: 'Not connected', tone: 'muted' };
  }
}

const TONE_CLASS = {
  ok: 'text-foreground',
  warn: 'text-error',
  muted: 'text-muted',
} as const;

const FIELD_LABEL = 'text-xs text-muted';

/**
 * A busy/error pair for an action surface with one error location. Enrollment
 * uses the cross-form gate below instead.
 */
function useBusyAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run };
}

type EnrollmentAction = 'offer' | 'form';

/** One synchronous gate shared by both ways an un-enrolled Host can enroll. */
function useEnrollmentActions() {
  const running = useRef(false);
  const [busy, setBusy] = useState<EnrollmentAction | null>(null);
  const [error, setError] = useState<{ action: EnrollmentAction; message: string } | null>(null);

  const run = useCallback(async (action: EnrollmentAction, work: () => Promise<void>) => {
    // State disables the buttons on the next render; the ref closes the smaller
    // window where two click handlers can run before that render happens.
    if (running.current) return false;
    running.current = true;
    setBusy(action);
    setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      setError({ action, message: caught instanceof Error ? caught.message : String(caught) });
      return false;
    } finally {
      running.current = false;
      setBusy(null);
    }
  }, []);

  return { busy, error, run };
}

/** The one field the offer card and the typed form both ask for. */
function MachineNameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="mt-2 block">
      <span className={FIELD_LABEL}>Name for this machine</span>
      <TextInput
        value={value}
        onChange={onChange}
        autoComplete="off"
        placeholder="e.g. Work laptop"
      />
    </label>
  );
}

/**
 * Connect this machine to a coordinating server, so a phone running Dormouse
 * Pocket can pair with it.
 *
 * Renders nothing at all on a build with no Host service behind it (the
 * website, the lib dev server): there is no Host to enroll, and offering the
 * form would promise something the build cannot do.
 *
 * This is the same `enroll` / `enrollOffer` / `status` / `reconnect` /
 * `clearEnrollment` surface as the `window.dormouseRemoteHost` console hook,
 * which stays as the scripting seam (`docs/specs/server.md`, "Host side").
 * Pairing approval is *not* here — it is a modal, because it must interrupt
 * (`docs/specs/remote-security-model.md`, Pairing Ceremony).
 */
export function RemoteControlSection() {
  const state = useSyncExternalStore(subscribeToRemoteHostStatus, getRemoteHostStatusSnapshot);

  // Another window may have enrolled since this dialog last opened, and the
  // service pushes `status` only when it changes.
  useEffect(() => void refreshRemoteHostStatus(), []);

  if (state.kind === 'unsupported') return null;

  return (
    <section className="mt-4 border-t border-border pt-3">
      <div className="text-sm text-foreground">Remote control</div>
      {state.kind === 'loading' ? (
        <div className="mt-1.5 text-sm text-muted">Checking…</div>
      ) : state.kind === 'error' ? (
        <div className="mt-1.5 text-sm leading-relaxed text-muted">
          Could not reach this machine’s Host service: {state.message}
        </div>
      ) : state.status.enrolled ? (
        <EnrolledView
          serverUrl={state.status.serverUrl}
          connection={state.status.connection}
          pairedClients={state.status.pairedClients}
        />
      ) : (
        <EnrollView offer={state.status.offer} suggestedLabel={state.status.suggestedLabel} />
      )}
    </section>
  );
}

/**
 * Un-enrolled, with or without an installer's offer on this machine.
 *
 * With one, the offer leads and the typed form folds away behind a disclosure:
 * a user who ran the installer here has nothing to type, and a server somewhere
 * else is the rarer case. Without one, nothing about the form changes.
 *
 * **One tree, whichever of those it is.** `offer` flips underneath this
 * component — the 2 s poll sees the installer mint one, and sees the file
 * unlinked the moment an enroll redeems it — and a shape that changed with it
 * would unmount whatever the user was in the middle of: a failure landing after
 * the flip would have nowhere to render, leaving silence over a spent
 * single-use token, and a half-typed server URL would vanish because a file
 * appeared on disk (`docs/specs/server.md`).
 */
function EnrollView({
  offer,
  suggestedLabel,
}: {
  offer: RemoteHostConsoleStatus['offer'];
  suggestedLabel: string;
}) {
  const [showForm, setShowForm] = useState(false);
  // Hoisted out of both forms so they share one synchronous enrollment gate,
  // and so an offer failure still has somewhere to render after its file goes.
  const { busy, error, run } = useEnrollmentActions();
  const offerError = error?.action === 'offer' ? error.message : null;
  const formError = error?.action === 'form' ? error.message : null;

  // The origin the card is rendering, which is the offer's while there is one
  // and the last one otherwise — kept only while that card still has something
  // to say (in flight, or holding an error). Once it goes idle with no offer,
  // the card is gone and the typed form is all that is left, unfolded.
  const shown = useRef<string | null>(null);
  if (offer) shown.current = offer.origin;
  const origin =
    offer?.origin ?? (busy === 'offer' || offerError !== null ? shown.current : null);

  return (
    <div>
      {origin !== null ? (
        <>
          {/* Keyed by origin: a different offer is a different form, and its name
              field must re-seed rather than keep what was typed for the old one. */}
          <OfferCard
            key={origin}
            origin={origin}
            suggestedLabel={suggestedLabel}
            busy={busy === 'offer'}
            disabled={busy !== null}
            error={offerError}
            onEnroll={(label) => void run('offer', () => enrollOfferRemoteHost(origin, label))}
          />
          <div className="mt-2">
            <button
              type="button"
              aria-expanded={showForm}
              className={modalActionButton()}
              onClick={() => setShowForm((open) => !open)}
            >
              {/* The same `+`/`−` affordance as Pocket's "First-time setup"
                  disclosure, so a fold reads as one before it is clicked. */}
              {showForm ? '− ' : '+ '}Enroll with a different server…
            </button>
          </div>
        </>
      ) : null}
      {/* Hidden, never unmounted — see the note above. */}
      <EnrollForm
        suggestedLabel={suggestedLabel}
        hidden={origin !== null && !showForm}
        busy={busy === 'form'}
        disabled={busy !== null}
        error={formError}
        onEnroll={(serverUrl, password, label) =>
          run('form', () => enrollRemoteHost(serverUrl, password, label))
        }
      />
    </div>
  );
}

/**
 * One-click enrollment against the server installed on this machine.
 *
 * The origin is shown but not editable, and the label is all the user chooses
 * (`service-protocol.ts` → `RemoteHostConsoleStatus.offer`). Every refusal the
 * typed form can hit applies here too — an installed server can still sit on an
 * origin this build was not compiled to reach — so the error renders in the same
 * place, in the same words. The busy/error pair belongs to {@link EnrollView},
 * because this card is unmounted by a successful enroll and must not be by an
 * offer file that vanished under a failing one.
 */
function OfferCard({
  origin,
  suggestedLabel,
  busy,
  disabled,
  error,
  onEnroll,
}: {
  origin: string;
  suggestedLabel: string;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onEnroll: (label: string) => void;
}) {
  const [label, setLabel] = useState(suggestedLabel);

  const ready = label.trim() !== '';

  return (
    <form
      className="mt-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !disabled) onEnroll(label.trim());
      }}
    >
      <div className="text-sm leading-relaxed text-muted">
        A Dormouse server is installed on this machine.
      </div>
      {/* The origin is the value the user is about to act on, so it gets the
          same framed review block as the other two places that show one
          (ExternalLinkModal, RemotePairingModal). */}
      <ModalReviewBlock className="mt-1.5" wrap="breakAll">
        {origin}
      </ModalReviewBlock>

      <MachineNameField value={label} onChange={setLabel} />

      {error ? <div className="mt-2 text-sm leading-relaxed text-error">{error}</div> : null}

      <div className="mt-2">
        <button
          type="submit"
          disabled={!ready || disabled}
          className={modalActionButton({ tone: 'primary' })}
        >
          {busy ? 'Connecting…' : 'Enroll'}
        </button>
      </div>
    </form>
  );
}

function EnrolledView({
  serverUrl,
  connection,
  pairedClients,
}: {
  serverUrl: string | null;
  connection: RemoteHostStatus;
  pairedClients: number;
}) {
  const { busy, error, run } = useBusyAction();
  // Disconnecting drops every paired phone until they pair again, so it asks
  // once rather than acting on the first click.
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const described = describeConnection(connection);

  return (
    <div className="mt-1.5 text-sm leading-relaxed">
      <div className="font-mono break-all text-foreground">{serverUrl ?? 'Unknown server'}</div>
      <div className={`mt-0.5 ${TONE_CLASS[described.tone]}`}>{described.text}</div>
      <div className="mt-0.5 text-muted">
        {pairedClients === 0
          ? 'No phone has paired with this machine yet.'
          : `${pairedClients} paired ${pairedClients === 1 ? 'device' : 'devices'}.`}
      </div>

      {error ? <div className="mt-1.5 text-error">{error}</div> : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {connection === 'displaced' ? (
          <button
            type="button"
            disabled={busy}
            className={modalActionButton({ tone: 'primary' })}
            onClick={() => void run(reconnectRemoteHost)}
          >
            Reconnect
          </button>
        ) : null}
        {confirmingDisconnect ? (
          <>
            <span className="text-xs text-muted">Paired phones will need to pair again.</span>
            <button
              type="button"
              disabled={busy}
              className={modalActionButton({ tone: 'primary' })}
              onClick={() =>
                void run(async () => {
                  await clearRemoteHostEnrollment();
                  setConfirmingDisconnect(false);
                })
              }
            >
              Disconnect
            </button>
            <button
              type="button"
              disabled={busy}
              className={modalActionButton()}
              onClick={() => setConfirmingDisconnect(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            className={modalActionButton()}
            onClick={() => setConfirmingDisconnect(true)}
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The three-field form, prefilled with the same suggested name the card uses.
 *
 * `hidden` rather than an unmount, because what is typed here has to survive
 * both of the things that fold it away: refolding the disclosure, and an offer
 * file appearing on disk mid-typing ({@link EnrollView}).
 */
function EnrollForm({
  suggestedLabel,
  hidden,
  busy,
  disabled,
  error,
  onEnroll,
}: {
  suggestedLabel: string;
  hidden?: boolean;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onEnroll: (serverUrl: string, password: string, label: string) => Promise<boolean>;
}) {
  const [serverUrl, setServerUrl] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState(suggestedLabel);

  const ready = serverUrl.trim() !== '' && password !== '' && label.trim() !== '';

  const submit = useCallback(
    () =>
      onEnroll(serverUrl.trim(), password, label.trim()).then((succeeded) => {
        if (!succeeded) return;
        // Only on success: a failed enroll is usually a typo in one of the other
        // fields, and clearing the password would make every retry a re-fetch
        // from the password manager.
        setPassword('');
      }),
    [onEnroll, serverUrl, password, label],
  );

  return (
    <form
      className="mt-1.5"
      hidden={hidden}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !disabled) void submit();
      }}
    >
      <div className="text-sm leading-relaxed text-muted">
        Connect this machine to a Dormouse server to control it from your phone.
      </div>

      <label className="mt-2 block">
        <span className={FIELD_LABEL}>Server</span>
        <TextInput
          value={serverUrl}
          onChange={setServerUrl}
          type="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://your-server"
        />
      </label>

      <label className="mt-2 block">
        <span className={FIELD_LABEL}>Setup password</span>
        <TextInput
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="off"
          placeholder="From the server operator"
        />
      </label>

      <MachineNameField value={label} onChange={setLabel} />

      {error ? <div className="mt-2 text-sm leading-relaxed text-error">{error}</div> : null}

      <div className="mt-2">
        <button
          type="submit"
          disabled={!ready || disabled}
          className={modalActionButton({ tone: 'primary' })}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}
