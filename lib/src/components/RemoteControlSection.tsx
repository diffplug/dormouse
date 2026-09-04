import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { DEFAULT_PAIRING_TTL_MS } from 'server-lib-common';
import { ModalReviewBlock, TextInput, modalActionButton } from './design';
import { ExternalTextLink } from './ExternalTextLink';
import type { RemoteHostConsoleStatus, SetupQrResult } from '../host/remote/service-protocol';
import type {
  PairingOutcome,
  RemoteHostStatus,
  TerminalInvitationState,
} from '../remote/host/remote-host';
import { SCAN_LABEL } from '../remote/setup-copy';
import {
  clearRemoteHostEnrollment,
  enrollOfferRemoteHost,
  enrollRemoteHost,
  getRemoteHostStatusSnapshot,
  mintSetupQr,
  reconnectRemoteHost,
  refreshRemoteHostStatus,
  subscribeToRemoteHostStatus,
  subscribeToInvitation,
} from '../remote/host/host-status-store';

/**
 * The QR encoder (`uqr`) is only ever reached by one panel inside one dialog on
 * an enrolled machine, so it is lazy for the same reason `Wall.tsx` lazies
 * `RemotePairingModalHost`: otherwise every build — the website included, where
 * this section renders nothing at all — ships it in the main chunk.
 *
 * A factory rather than a module constant because retry needs a *fresh* one:
 * `lazy` memoizes the rejected promise against the component's identity, so
 * re-rendering the same one re-throws the same chunk failure forever.
 */
function makeQrCode() {
  return lazy(() => import('./QrCode').then((m) => ({ default: m.QrCode })));
}

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
const HOSTED_REMOTE_URL = 'https://dormouse.sh/hosted/#remote-control';

/**
 * How far ahead of `expiresAt` the phone-setup panel mints a replacement code.
 *
 * The panel can sit open while someone goes to find their phone, and a code is
 * short-lived by design (`docs/specs/server.md` → Setup tokens) — so it replaces
 * its own rather than going quietly unscannable. The lead is what keeps a camera
 * opening on the old code from redeeming one that has already died.
 */
const SETUP_QR_REFRESH_LEAD_MS = 20_000;

/**
 * Floor on that delay, because `expiresAt` is the *Server's* clock and the
 * subtraction is against the webview's. A laptop a few minutes fast computes a
 * delay at or below zero and re-mints in a tight loop — several POSTs a second,
 * each spending a real single-use token on the Server. The floor turns clock
 * skew into a slightly early refresh instead.
 */
const SETUP_QR_MIN_REFRESH_MS = 30_000;

/**
 * Ceiling for a webview clock behind the Server. Its computed lifetime can be
 * arbitrarily long, but the token has at most the shared TTL on the Server;
 * keep the same lead so its replacement lands before real expiry.
 */
const SETUP_QR_MAX_REFRESH_MS = DEFAULT_PAIRING_TTL_MS - SETUP_QR_REFRESH_LEAD_MS;

/** When to replace a code that expires at `expiresAt`, clock skew and all. */
function refreshDelay(expiresAt: number, now: number): number {
  return Math.min(
    Math.max(expiresAt - now - SETUP_QR_REFRESH_LEAD_MS, SETUP_QR_MIN_REFRESH_MS),
    SETUP_QR_MAX_REFRESH_MS,
  );
}

/** Whole minutes until a setup code stops redeeming; never negative. */
function minutesUntil(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

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

/**
 * Everything the phone-setup panel can be showing, as one value.
 *
 * `null` is the closed panel. The rest are open: waiting on a mint, holding a
 * live code, in one of the four terminal phases, or refused. `minting` carries
 * the code being replaced when there is one, so an auto-refresh never blanks a
 * QR a camera is pointed at.
 */
type SetupQrState =
  | null
  | { phase: 'minting'; prev?: SetupQrResult }
  | { phase: 'live'; qr: SetupQrResult }
  /** Carries its own id: the outcome is a second event about the same code. */
  | { phase: 'scanned'; inviteId: string }
  | { phase: Exclude<TerminalPhase, 'scanned'> }
  | { phase: 'failed'; message: string };

/**
 * **Four different facts, and they read differently.** `scanned` means a phone
 * completed the handshake and the next step is the pairing request about to
 * interrupt this machine; `finished` means that request has been answered,
 * either way; `dropped` means this Host discarded the code un-scanned — the
 * relay socket went, or a newer mint evicted it; `expired` means its TTL ran
 * out before anyone scanned it. **Only `scanned` sends the user to a phone**
 * (`docs/specs/remote-security-model.md` → Pairing).
 */
type TerminalPhase = 'scanned' | 'finished' | 'dropped' | 'expired';

/**
 * How each terminal invitation state reads in the panel. Exhaustive over the
 * states the Host publishes, so a fifth one cannot quietly fall through to
 * "scanned" — the one sentence that must never be shown for a code nobody
 * touched.
 */
const TERMINAL_PHASE: Record<TerminalInvitationState, TerminalPhase> = {
  reserved: 'scanned',
  consumed: 'finished',
  dropped: 'dropped',
  expired: 'expired',
};

/**
 * What each terminal phase says. A table rather than four JSX branches, so the
 * exhaustiveness {@link TERMINAL_PHASE} promises holds on the render side too.
 */
const TERMINAL_COPY: Record<TerminalPhase, { headline: string; detail: string }> = {
  scanned: {
    headline:
      'A phone scanned this code. It will ask to pair — that request interrupts you here with two digits to type.',
    detail: 'This code is used up.',
  },
  // The frame left when a code was spent and nobody decided anything — a lost
  // socket, a teardown. **It deliberately does not claim the pairing
  // succeeded**: a ceremony a person answered carries an outcome and gets
  // {@link PAIRING_OUTCOME_COPY}'s sentence instead.
  finished: {
    headline: 'This setup code is finished.',
    detail: 'Pair another phone with a new code, or close this.',
  },
  dropped: {
    headline: 'This code is no longer valid — nobody scanned it.',
    detail: 'This machine lost its connection to the server, or replaced the code. Get a new one.',
  },
  expired: {
    headline: 'This code expired — nobody scanned it.',
    detail: 'Get a new one.',
  },
};

/**
 * A lookup into one of this panel's copy tables, answering only for a key the
 * table actually holds.
 *
 * **Never the `in` operator.** Every one of these tables is keyed by a string
 * the Host chose and a bridge relayed, and `in` walks the prototype chain — so
 * `'toString'` would answer "yes, there is copy for that" and hand back
 * `Object.prototype.toString` to render. The store checks that those fields are
 * strings and deliberately *not* that they are members of the closed set
 * (`host-status-store.ts`), so this is where a stranger stops.
 * `hasOwnProperty.call` rather than `Object.hasOwn`, which is ES2022 and this
 * build's lib is ES2020.
 */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The terminal copy for a state, or `undefined` while the panel is still live. */
function terminalCopy(state: SetupQrState): { headline: string; detail: string } | undefined {
  return state ? own(TERMINAL_COPY, state.phase) : undefined;
}

/**
 * The accessible name of the region that reports how a pairing ended.
 *
 * A contract, not copy: it is what the pairing walkthrough waits on
 * (`scripts/pairing-walkthrough/steps.mjs`), the same way Pocket's two-digit
 * region is. Pinned by `lib/src/lib/mirrored-constants.test.ts`.
 */
export const PAIRING_OUTCOME_LABEL = 'Pairing outcome';

/**
 * The half of every failure sentence that is the same: the code is gone, get
 * another.
 *
 * **Only where nothing on screen already is another.** An outcome belongs to
 * the code its ceremony used, and the panel may since have minted a newer one —
 * telling the reader to get a fresh code directly above a fresh code is the one
 * thing this sentence must not do.
 */
const SPENT_GET_ANOTHER = 'This setup code is spent — get a new one and try again.';

/**
 * What each pairing outcome says to the person at this machine.
 *
 * **Fixed copy chosen by code.** The outcome is a closed member this machine's
 * own Host decided, and the sentence for it is written here — nothing on this
 * screen is ever rendered from something that arrived on a wire
 * (`docs/specs/remote-security-model.md` → Pairing). Exhaustive over
 * {@link PairingOutcome} for the same reason {@link TERMINAL_COPY} is over the
 * phases: an outcome with no sentence would report a ceremony ended and say
 * nothing about how.
 *
 * Every failure names what did *not* happen — "nothing was paired" — because
 * the paired count above it moves for none of them ({@link PairingOutcome}).
 * `paired` is the only member with nothing to add: it did not spend a code the
 * user needs to replace, so it never takes {@link SPENT_GET_ANOTHER}.
 *
 * `expired` covers **both** ways a deadline ends a ceremony — the reaper firing
 * with the modal unanswered, and a confirmation typed after it — so it says the
 * request ran out of time rather than that nobody answered it
 * (`RemoteHost.#approvePairing` checks the deadline after spending its one
 * attempt).
 */
export const PAIRING_OUTCOME_COPY: Record<PairingOutcome, string> = {
  paired: 'This phone is paired with this machine.',
  'code-mismatch': 'The two digits did not match, so nothing was paired.',
  cancelled: 'You cancelled this request, so nothing was paired.',
  expired: 'The request ran out of time, so nothing was paired.',
  superseded: 'Another pairing request replaced this one, so nothing was paired.',
  'host-error': 'This machine could not finish pairing, so nothing was paired.',
};

/**
 * How a finished ceremony went, announced.
 *
 * `role="status"` rather than `alert`: the person is looking at this dialog —
 * they just answered a modal on top of it — so it is a result, not an
 * interruption.
 */
function PairingOutcomeReport({ sentence }: { sentence: string }) {
  return (
    <div
      role="status"
      aria-label={PAIRING_OUTCOME_LABEL}
      className="mt-1 text-sm leading-relaxed text-foreground"
    >
      {sentence}
    </div>
  );
}

/**
 * What to say about an outcome, or `undefined` for one this build has no
 * sentence for — which is the whole of the fallback to the state-only copy.
 *
 * `replaced` says a scannable code is already on screen, which is what decides
 * whether {@link SPENT_GET_ANOTHER} is still advice or a contradiction.
 */
function outcomeSentence(
  outcome: PairingOutcome | undefined,
  replaced: boolean,
): string | undefined {
  const sentence = outcome ? own(PAIRING_OUTCOME_COPY, outcome) : undefined;
  if (sentence === undefined || outcome === 'paired' || replaced) return sentence;
  return `${sentence} ${SPENT_GET_ANOTHER}`;
}

/**
 * The phone-setup panel's whole lifecycle: mint on open, replace the code before
 * it dies, and flip to spent when the Server says the phone used it.
 *
 * **Its own busy and error, not the section's {@link useBusyAction}.** A mint
 * here fires on a timer rather than on a click: running it through the shared
 * pair would clear the enrolled view's error slot — wiping a Reconnect failure
 * the user is still reading — on a schedule nobody asked for. `useBusyAction`
 * stays for user actions; the re-entrancy this needs and that boolean does not
 * have is the sequence below.
 */
function useSetupQr() {
  const [state, setState] = useState<SetupQrState>(null);
  /** How the last ceremony this machine answered ended; see the subscription below. */
  const [outcome, setOutcome] = useState<PairingOutcome | undefined>(undefined);
  /**
   * Bumped synchronously by every mint and by closing. Two jobs, both about a
   * code that exists on the Server whether or not anyone can see it: it disarms
   * the pending auto-refresh the instant a mint starts, so the fetch window
   * cannot produce a second one, and it gates the writes below, so a mint
   * resolving after the panel closed leaves no live-but-undisplayed token.
   */
  const mintSeq = useRef(0);

  const mint = useCallback(() => {
    const mine = ++mintSeq.current;
    // Carry the code being replaced through the round trip: the refresh lead
    // exists precisely so a camera mid-scan keeps something live to read.
    setState((current) => ({ phase: 'minting', prev: displayedQr(current) }));
    void (async () => {
      try {
        const qr = await mintSetupQr();
        // Superseded answers are dropped whichever way they went: they belong to
        // a request nobody is waiting on, and painting one would put a stale
        // code — or a stale message — under a panel that has moved on.
        if (mintSeq.current !== mine) return;
        setState({ phase: 'live', qr });
      } catch (error) {
        if (mintSeq.current !== mine) return;
        setState({
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, []);

  /**
   * The user asking for a code — opening the panel, or **New code**.
   *
   * **Not the same entry point as the refresh timer's**, which is the whole
   * reason this wrapper exists rather than a `setOutcome(undefined)` inside
   * {@link mint}. Clearing the report is an acknowledgement, and only a person
   * can make one: the panel re-mints on its own anywhere from 30 s to nearly
   * the full TTL later, and a sentence erased by that timer is one nobody read
   * — leaving the absolute paired count, which does not move for any failure,
   * as the only thing that ever said anything.
   */
  const newCode = useCallback(() => {
    // The report goes with the code it was about: its sentence ends in "get a
    // new one and try again", and this is the user doing that.
    setOutcome(undefined);
    mint();
  }, [mint]);

  const close = useCallback(() => {
    mintSeq.current++;
    // The report goes with the panel it was shown in: Done is the user
    // acknowledging it, and a sentence they dismissed must not reappear under
    // the section with nothing left that could clear it but minting again.
    setOutcome(undefined);
    setState(null);
  }, []);

  // Replace the code before it dies: the panel can sit open while someone goes
  // to find their phone. Only from `live` — a spent code is used and the next
  // step is on the phone, a failed one is waiting on the user, and a mint in
  // flight will arm its own — and the sequence check covers the timer that was
  // armed against a code the panel no longer shows.
  useEffect(() => {
    if (state?.phase !== 'live') return;
    const armed = mintSeq.current;
    const timer = setTimeout(() => {
      if (mintSeq.current === armed) mint();
    }, refreshDelay(state.qr.expiresAt, Date.now()));
    return () => clearTimeout(timer);
  }, [state, mint]);

  // The Host reports its own invitation states, which is the only way this
  // panel can know its code was used: the scan happens on the phone. The
  // *phase* is only for the invitation this panel is following — a second
  // window offering a different code stays live — and bumping the sequence
  // makes it terminal, so a mint already in flight cannot paint a code over it.
  //
  // **The outcome is not filtered that way**, and the subscription is not
  // conditional on there being one to filter by: the modal interrupts whatever
  // is on screen, so the person can answer it with this panel closed or already
  // showing a newer code, and the report is theirs either way.
  const inviteId = trackedInviteId(state);
  useEffect(() => {
    return subscribeToInvitation((changed, invitationState, reported) => {
      if (reported) setOutcome(reported);
      // `live` is the only state that keeps the code on screen.
      if (changed !== inviteId || invitationState === 'live') return;
      // A state this build has no phase for is still terminal — the code is
      // gone — so it falls back to `finished`, which is the one sentence true of
      // any retirement and does not send anyone to a phone.
      const phase = own(TERMINAL_PHASE, invitationState) ?? 'finished';
      mintSeq.current++;
      setState(phase === 'scanned' ? { phase, inviteId } : { phase });
    });
  }, [inviteId]);

  return {
    state,
    report: outcomeSentence(outcome, displayedQr(state) !== undefined),
    newCode,
    close,
  };
}

/** The code the panel is actually rendering, live or held through a refresh. */
function displayedQr(state: SetupQrState): SetupQrResult | undefined {
  if (state?.phase === 'live') return state.qr;
  if (state?.phase === 'minting') return state.prev;
  return undefined;
}

/**
 * The invitation this panel is following: the one it is drawing, or — once a
 * phone has completed a handshake against it — the one whose outcome it is
 * still waiting on. The second half is why the subscription outlives the QR
 * (`docs/specs/server.md` → Remote control, in the Settings dialog).
 */
function trackedInviteId(state: SetupQrState): string | undefined {
  if (state?.phase === 'scanned') return state.inviteId;
  return displayedQr(state)?.inviteId;
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
          Could not reach this machine’s remote-control service: {state.message}
        </div>
      ) : state.status.enrolled ? (
        // Keyed by which enrollment this is: a swap to another server — the
        // console hook can do one under an open dialog — must not leave a setup
        // code, or an error, belonging to the machine we just left.
        <EnrolledView
          key={state.status.hostId ?? state.status.serverUrl ?? 'enrolled'}
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
  // Its own busy and error, unlike every other action here: the mint also fires
  // on a timer, and this view's one error slot belongs to what the user clicked.
  const setup = useSetupQr();
  const described = describeConnection(connection);
  /**
   * Where the one pairing report goes, decided here rather than half in each
   * place that can draw it: **the panel owns it only where it has a sentence to
   * supersede**, which is `finished`. Everywhere else — panel shut, or open on a
   * newer code, a mint, or a failed one — the section does, because an outcome
   * arrives from whichever invitation carries one and would otherwise be
   * rendered to nobody.
   */
  const reportInPanel = setup.state?.phase === 'finished';

  return (
    <div className="mt-1.5 text-sm leading-relaxed">
      <div className="font-mono break-all text-foreground">{serverUrl ?? 'Unknown server'}</div>
      <div className={`mt-0.5 ${TONE_CLASS[described.tone]}`}>{described.text}</div>
      <div className="mt-0.5 text-muted">
        {pairedClients === 0
          ? 'No phone has paired with this machine yet.'
          : `${pairedClients} paired ${pairedClients === 1 ? 'phone' : 'phones'}.`}
      </div>

      {setup.report && !reportInPanel ? <PairingOutcomeReport sentence={setup.report} /> : null}

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
              onClick={() => (setup.state ? setup.close() : setup.newCode())}
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
        <SetupPhonePanel
          state={setup.state}
          report={reportInPanel ? setup.report : undefined}
          onNewCode={setup.newCode}
          onDone={setup.close}
        />
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
  report,
  onNewCode,
  onDone,
}: {
  state: NonNullable<SetupQrState>;
  report: string | undefined;
  onNewCode: () => void;
  onDone: () => void;
}) {
  const shown = displayedQr(state);
  const terminal = terminalCopy(state);
  const expiresAt = shown?.expiresAt ?? null;
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
      {/* The report supersedes `finished`'s deliberately-vague sentence, which
          is the only reason the panel ever draws one (`EnrolledView`). */}
      {report ? (
        <PairingOutcomeReport sentence={report} />
      ) : terminal ? (
        <>
          <div className="mt-1 text-sm leading-relaxed text-foreground">{terminal.headline}</div>
          <div className="mt-1 text-xs text-muted">{terminal.detail}</div>
        </>
      ) : shown ? (
        <>
          {/* Names the phone-side control — through the constant Pocket labels
              it with — because pointing the phone's *own* camera at this is the
              one route that sets nothing up: on iOS it opens Safari rather than
              the installed app (`pocket-app.md`). */}
          <div className="mt-1 text-sm leading-relaxed text-muted">
            In Dormouse Pocket on the phone, tap {SCAN_LABEL} and point it at this. Nothing to type
            — no address, no password.
          </div>
          <div className="mt-2 flex justify-center">
            <ScannableCode url={shown.url} />
          </div>
          <div className="mt-1.5 text-center text-xs text-muted">
            {minutesUntil(shown.expiresAt, now) > 0
              ? `Good for one phone. Expires in ${minutesUntil(shown.expiresAt, now)} min.`
              : 'This code has expired — get a new one.'}
          </div>
        </>
      ) : state.phase === 'failed' ? (
        // The panel's own slot, not the enrolled view's: this mint may have been
        // fired by a timer, and a refusal must not overwrite a Reconnect failure
        // the user is reading.
        <div className="mt-1 text-sm leading-relaxed text-error">{state.message}</div>
      ) : (
        <div className="mt-1 text-sm text-muted">Getting a code…</div>
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
 * The QR itself, behind its own error boundary.
 *
 * Two ways drawing a code can throw, and neither may reach the app-wide
 * ErrorBoundary, which takes every terminal in the window with it: the encoder
 * is a lazily-imported chunk whose fetch can fail, and `encode` itself refuses
 * data past the format's capacity. Contained here each costs a retry button.
 *
 * The retry mints a *fresh* `lazy`, because React caches the rejected import
 * against the component identity — re-rendering the same one re-throws forever.
 */
function ScannableCode({ url }: { url: string }) {
  const [attempt, setAttempt] = useState(0);
  const [QrCode, setQrCode] = useState(makeQrCode);

  return (
    // Keyed, so a boundary that has already caught is remounted both by a retry
    // and by a new code arriving — the second is the recovery for a URL this
    // encoder refused, which retrying the same one never fixes.
    <QrChunkBoundary
      key={`${attempt}:${url}`}
      fallback={
        <div className="text-center">
          <div className="text-sm leading-relaxed text-muted">
            Couldn’t display the code — the encoder didn’t load.
          </div>
          <button
            type="button"
            className={`mt-1.5 ${modalActionButton()}`}
            onClick={() => {
              setQrCode(makeQrCode);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      }
    >
      {/* Nothing while the encoder chunk arrives: it is one import away, and a
          placeholder the size of a QR would flash on every open. */}
      <Suspense fallback={null}>
        <QrCode value={url} label="Setup code for this machine" />
      </Suspense>
    </QrChunkBoundary>
  );
}

/** Catches a render throw from the code area, and nothing else. */
class QrChunkBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
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
        {' '}
        <ExternalTextLink href={HOSTED_REMOTE_URL}>
          Prefer not to run one? Hosted is coming soon.
        </ExternalTextLink>
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
