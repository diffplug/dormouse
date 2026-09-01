import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ModalReviewBlock, TextInput, modalActionButton } from './design';
import type { RemoteHostConsoleStatus, SetupQrResult } from '../host/remote/service-protocol';
import type { RemoteHostStatus } from '../remote/host/remote-host';
import {
  clearRemoteHostEnrollment,
  enrollOfferRemoteHost,
  enrollRemoteHost,
  getRemoteHostStatusSnapshot,
  mintSetupQr,
  reconnectRemoteHost,
  refreshRemoteHostStatus,
  subscribeToRemoteHostStatus,
  subscribeToSetupTokenRedeemed,
} from '../remote/host/host-status-store';

/**
 * The QR encoder (`uqr`) is only ever reached by one panel inside one dialog on
 * an enrolled machine, so it is lazy for the same reason `Wall.tsx` lazies
 * `RemotePairingModalHost`: otherwise every build — the website included, where
 * this section renders nothing at all — ships it in the main chunk.
 */
const QrCode = lazy(() => import('./QrCode').then((m) => ({ default: m.QrCode })));

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
 * How far ahead of `expiresAt` the phone-setup panel mints a replacement code.
 *
 * The panel can sit open while someone goes to find their phone, and a code is
 * short-lived by design (`docs/specs/server.md` → Setup tokens) — so it replaces
 * its own rather than going quietly unscannable. The lead is what keeps a camera
 * opening on the old code from redeeming one that has already died.
 */
const SETUP_QR_REFRESH_LEAD_MS = 20_000;

/** Whole minutes until a setup code stops redeeming; never negative. */
function minutesUntil(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

/**
 * The busy/error pair every action in this section runs behind, so a rejection
 * from any of them lands in the same place and reads in the same words.
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

/**
 * Everything the phone-setup panel can be showing, as one value.
 *
 * `null` is the closed panel. The rest are open: waiting on a mint, holding a
 * live code, or spent — and `failed` is the mint that was refused, whose message
 * is in the section's shared error slot rather than here.
 */
type SetupQrState =
  | null
  | { phase: 'minting' }
  | { phase: 'live'; qr: SetupQrResult }
  | { phase: 'spent' }
  | { phase: 'failed' };

/**
 * The phone-setup panel's whole lifecycle: mint on open, replace the code before
 * it dies, and flip to spent when the Server says the phone used it.
 *
 * Minting runs through the caller's {@link useBusyAction} `run`, so a refusal
 * lands in the section's one error slot beside Reconnect's and Disconnect's —
 * but the panel's own copy comes from {@link SetupQrState}, so an unrelated
 * action being busy never reads as "getting a code".
 */
function useSetupQr(run: (action: () => Promise<void>) => Promise<void>) {
  const [state, setState] = useState<SetupQrState>(null);
  /**
   * Bumped synchronously by every mint and by closing. Two jobs, both about a
   * code that exists on the Server whether or not anyone can see it: it disarms
   * the pending auto-refresh the instant a mint starts, so the fetch window
   * cannot produce a second one, and it gates the write below, so a mint
   * resolving after the panel closed leaves no live-but-undisplayed token.
   */
  const mintSeq = useRef(0);

  const mint = useCallback(() => {
    const mine = ++mintSeq.current;
    setState({ phase: 'minting' });
    void run(async () => {
      let qr: SetupQrResult;
      try {
        qr = await mintSetupQr();
      } catch (error) {
        // Superseded answers are dropped whichever way they went: the failure
        // belongs to a request nobody is waiting on, and reporting it would put
        // a stale message in a slot the panel may no longer even be under.
        if (mintSeq.current !== mine) return;
        setState({ phase: 'failed' });
        throw error;
      }
      if (mintSeq.current !== mine) return;
      setState({ phase: 'live', qr });
    });
  }, [run]);

  const close = useCallback(() => {
    mintSeq.current++;
    setState(null);
  }, []);

  // Replace the code before it dies: the panel can sit open while someone goes
  // to find their phone. Not once it is spent — that code is used and the next
  // step is on the phone — and not while a mint is already running, which is
  // what the sequence check is for: the timer was armed against a code the panel
  // may no longer be showing.
  useEffect(() => {
    if (state?.phase !== 'live') return;
    const armed = mintSeq.current;
    const delay = Math.max(0, state.qr.expiresAt - Date.now() - SETUP_QR_REFRESH_LEAD_MS);
    const timer = setTimeout(() => {
      if (mintSeq.current === armed) mint();
    }, delay);
    return () => clearTimeout(timer);
  }, [state, mint]);

  // The Server announces a spent token to the Host that minted it
  // (`docs/specs/server.md` → Relay), which is the only way this panel can know
  // its code was used: the redemption happens on the phone. Bumping the sequence
  // makes it terminal — a mint that was in flight cannot paint a code over it.
  const open = state !== null;
  useEffect(() => {
    if (!open) return;
    return subscribeToSetupTokenRedeemed(() => {
      mintSeq.current++;
      setState({ phase: 'spent' });
    });
  }, [open]);

  return { state, mint, close };
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
  // Hoisted out of the card so it outlives the offer: this is the state that
  // has to still be here when a rejected enroll lands after the file went away.
  const { busy, error, run } = useBusyAction();

  // The origin the card is rendering, which is the offer's while there is one
  // and the last one otherwise — kept only while that card still has something
  // to say (in flight, or holding an error). Once it goes idle with no offer,
  // the card is gone and the typed form is all that is left, unfolded.
  const shown = useRef<string | null>(null);
  if (offer) shown.current = offer.origin;
  const origin = offer?.origin ?? (busy || error !== null ? shown.current : null);

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
            busy={busy}
            error={error}
            onEnroll={(label) => void run(() => enrollOfferRemoteHost(origin, label))}
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
      <EnrollForm suggestedLabel={suggestedLabel} hidden={origin !== null && !showForm} />
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
  error,
  onEnroll,
}: {
  origin: string;
  suggestedLabel: string;
  busy: boolean;
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
        if (ready && !busy) onEnroll(label.trim());
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
          disabled={!ready || busy}
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
  // The mint runs on this view's busy/error pair, so a refusal renders in its one
  // error slot — the same rule the offer card follows.
  const setup = useSetupQr(run);
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
          <>
            <button
              type="button"
              disabled={busy}
              aria-expanded={setup.state !== null}
              className={modalActionButton({ tone: setup.state ? 'secondary' : 'primary' })}
              onClick={() => (setup.state ? setup.close() : setup.mint())}
            >
              Set up a phone
            </button>
            <button
              type="button"
              disabled={busy}
              className={modalActionButton()}
              onClick={() => setConfirmingDisconnect(true)}
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      {setup.state ? (
        <SetupPhonePanel state={setup.state} onNewCode={setup.mint} onDone={setup.close} />
      ) : null}
    </div>
  );
}

/**
 * The QR a phone scans to set itself up against this machine's server, inline
 * in the Settings dialog (`docs/specs/server.md` → "Remote control, in the
 * Settings dialog").
 *
 * Purely what to draw for a {@link SetupQrState}; {@link useSetupQr} owns every
 * transition between them.
 */
function SetupPhonePanel({
  state,
  onNewCode,
  onDone,
}: {
  state: NonNullable<SetupQrState>;
  onNewCode: () => void;
  onDone: () => void;
}) {
  const expiresAt = state.phase === 'live' ? state.qr.expiresAt : null;
  const [now, setNow] = useState(() => Date.now());

  // The copy names whole minutes, so re-render on the minute rather than on a
  // clock tick: a 1 Hz interval bought ~300 renders per code for five numbers,
  // and left Storybook repainting forever after the code expired.
  useEffect(() => {
    if (expiresAt === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      const at = Date.now();
      setNow(at);
      const remaining = expiresAt - at;
      // Expired: the number cannot change again, so nothing re-arms.
      if (remaining <= 0) return;
      timer = setTimeout(arm, remaining % 60_000 || 60_000);
    };
    arm();
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return (
    <div className="mt-2 rounded border border-border p-2">
      <div className={FIELD_LABEL}>Set up a phone</div>
      {state.phase === 'spent' ? (
        <>
          <div className="mt-1 text-sm leading-relaxed text-foreground">
            Scanned. Finish on the phone — it registers a passkey, then asks to pair, and that
            request interrupts you here.
          </div>
          <div className="mt-1 text-xs text-muted">This code is used up.</div>
        </>
      ) : state.phase === 'live' ? (
        <>
          <div className="mt-1 text-sm leading-relaxed text-muted">
            Point the phone’s camera at this. Nothing to type — no address, no password.
          </div>
          <div className="mt-2 flex justify-center">
            {/* Nothing while the encoder chunk arrives: it is one import away,
                and a placeholder the size of a QR would flash on every open. */}
            <Suspense fallback={null}>
              <QrCode value={state.qr.url} label="Setup code for this machine" />
            </Suspense>
          </div>
          <div className="mt-1.5 text-center text-xs text-muted">
            {minutesUntil(state.qr.expiresAt, now) > 0
              ? `Sets up one phone, within ${minutesUntil(state.qr.expiresAt, now)} min.`
              : 'This code has expired — get a new one.'}
          </div>
        </>
      ) : (
        <div className="mt-1 text-sm text-muted">
          {state.phase === 'minting' ? 'Getting a code…' : 'No code — try again.'}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={state.phase === 'minting'}
          className={modalActionButton()}
          onClick={onNewCode}
        >
          New code
        </button>
        <button type="button" className={modalActionButton()} onClick={onDone}>
          Done
        </button>
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
function EnrollForm({ suggestedLabel, hidden }: { suggestedLabel: string; hidden?: boolean }) {
  const [serverUrl, setServerUrl] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState(suggestedLabel);
  const { busy, error, run } = useBusyAction();

  const ready = serverUrl.trim() !== '' && password !== '' && label.trim() !== '';

  const submit = useCallback(
    () =>
      run(async () => {
        await enrollRemoteHost(serverUrl.trim(), password, label.trim());
        // Only on success: a failed enroll is usually a typo in one of the other
        // fields, and clearing the password would make every retry a re-fetch
        // from the password manager.
        setPassword('');
      }),
    [run, serverUrl, password, label],
  );

  return (
    <form
      className="mt-1.5"
      hidden={hidden}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void submit();
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
          disabled={!ready || busy}
          className={modalActionButton({ tone: 'primary' })}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}
