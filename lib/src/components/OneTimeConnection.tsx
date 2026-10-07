import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { COPY_OUTCOME_LABEL, ModalReviewBlock, modalActionButton } from './design';
import {
  FIELD_HINT,
  FIELD_LABEL,
  hostOf,
  oneTimeControlSentence,
  own,
  pathRefusalSentence,
  revealPanel,
  useNetworkPolicy,
} from './remote-control-shared';
import { ExpiringCode } from './ScannableCode';
import { DEFAULT_RELAY_ORIGIN } from '../host/relay-origin';
import { writeTextToClipboard } from '../lib/clipboard';
import type { CopyOutcome } from '../lib/mouse-selection';
import type {
  OneTimeEndReason,
  OneTimeState,
  OneTimeUnavailableReason,
} from '../remote/burrow/one-time-runtime';
import {
  endOneTime,
  getOneTimeSnapshot,
  openOneTime,
  refreshOneTime,
  subscribeToOneTime,
} from '../remote/burrow/one-time-store';
import { phoneOnAnyNetwork } from '../remote/network-policy';

/**
 * Why this build offers none, in fixed copy per reason; a reason this build
 * does not know — an older VS Code broker's, or a newer one's — renders the
 * generic line below. A self-host build's own origin is its Relay, so it names
 * the stock build's.
 */
const UNAVAILABLE_COPY: Record<OneTimeUnavailableReason, string> = {
  'self-host':
    `Not available in a self-host build: one-time links are made at ${hostOf(DEFAULT_RELAY_ORIGIN)}, ` +
    'which this build reaches only through a link you click.',
  'network-off':
    'Off while Settings → Network is set to Nowhere: this computer opens no connections on its own.',
};

/**
 * How a connection ended, as the person at this machine reads it — **fixed copy
 * chosen by a closed reason this machine's own runtime picked**, never text off
 * a wire, and a fallback for a reason a newer VS Code broker knows and this
 * build does not. `host` is this build's relay host, which the rendezvous runs on.
 * `anyNetwork` ({@link phoneOnAnyNetwork}) has no allowed network to name, so
 * `direct-failed` suggests another network instead; `network-not-allowed` keeps
 * its sentence, since no path is held there to end a connection. A
 * `network-not-allowed` ending that carries its refusal reads
 * `pathRefusalSentence` instead, naming the address; this is the fallback for
 * one that does not.
 *
 * `user-ended` has no sentence: this machine ended it (End, Cancel), so there is
 * nothing to report, and the panel goes straight back to its button.
 */
export function oneTimeEndedCopy(
  host: string,
  anyNetwork: boolean,
): Record<Exclude<OneTimeEndReason, 'user-ended'>, string> {
  return {
    'user-denied': 'You cancelled the phone’s request, so nothing connected.',
    'confirmation-mismatch': 'The two digits did not match, so nothing connected.',
    expired: 'The link ran out of time before a phone finished connecting.',
    'phone-left': 'The phone disconnected.',
    'direct-failed': anyNetwork
      ? 'The phone couldn’t reach this computer directly, which some networks block. Try the phone on ' +
        'another network, such as cellular or the same Wi-Fi as this computer, then get a new link.'
      : 'The phone couldn’t reach this computer directly. Make sure it is on an allowed network, then ' +
        'get a new link.',
    'network-not-allowed': 'The phone wasn’t on one of your allowed networks, so the connection ended.',
    idle: 'The phone stopped responding, so the connection ended.',
    unreachable:
      `Couldn’t reach ${host} to make a link. Check this computer’s internet connection, ` +
      'then try again.',
    'rendezvous-lost': `The connection to ${host} dropped before the phone finished connecting.`,
    'burrow-error': 'This computer couldn’t finish the connection.',
  };
}

const ENDED_FALLBACK = 'The one-time connection ended.';

/**
 * Where a phone may be: under Anywhere on any network, else — and before the
 * policy is read — on an allowed one.
 */
function phoneWhere(anyNetwork: boolean): string {
  return anyNetwork ? 'Your phone can be on any network.' : 'Your phone must be on an allowed network.';
}

/**
 * The accessible name of the region reporting how a connection ended, the
 * counterpart of the Relay panel's `PAIRING_OUTCOME_LABEL`.
 */
export const ONE_TIME_OUTCOME_LABEL = 'One-time connection outcome';

/** How long Copy link says it did, or could not. */
const COPY_FEEDBACK_MS = 1400;

/**
 * Whether a state shows the button rather than the panel: nothing is under way,
 * and nothing is left to report.
 */
function atRest(state: OneTimeState): boolean {
  return (
    state.status === 'idle' ||
    state.status === 'unavailable' ||
    (state.status === 'ended' && state.reason === 'user-ended')
  );
}

/**
 * The one-time connection in Settings → Network's Phones section, enrolled or not
 * (`docs/specs/one-time.md` -> "Laptop UI"): a button at rest, and a framed
 * panel for everything from opening a link to reporting how it ended.
 *
 * **It renders the service's state and owns nothing else but its own busy and
 * error.** The link lives in the Burrow service, so closing Settings leaves a
 * waiting link waiting and a connection connected; reopening re-reads it.
 * **Nothing here re-opens on a timer**: a link is single-use, so a fresh one is
 * only ever the user's New link. `relayOrigin` is this build's, which the
 * rendezvous runs on in the only build that has one.
 */
export function OneTimeConnection({ relayOrigin }: { relayOrigin: string }) {
  const store = useSyncExternalStore(subscribeToOneTime, getOneTimeSnapshot);
  const policy = useNetworkPolicy();
  const anyNetwork = policy !== null && phoneOnAnyNetwork(policy);
  /** The action this panel has in flight: its answer, not an event, clears it. */
  const [pending, setPending] = useState<'open' | 'end' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The Baseboard keeps the store subscribed for the window's life, so this is
  // what recovers a first read that failed, not the subscription.
  useEffect(() => void refreshOneTime(), []);

  if (store.kind === 'unsupported') return null;

  const run = (kind: 'open' | 'end', action: () => Promise<void>) => {
    setPending(kind);
    setError(null);
    void action()
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setPending(null));
  };
  const open = () => run('open', openOneTime);
  const end = () => run('end', endOneTime);

  const known = store.kind === 'ready' ? store.state : null;
  // An open this panel started shows as one before the service's first event
  // lands — which, in a VS Code window that must first become the broker, can
  // be a while.
  const state: OneTimeState | null =
    pending === 'open' && (known === null || atRest(known)) ? { status: 'opening' } : known;

  if (state === null || atRest(state)) {
    const unavailable = state?.status === 'unavailable' ? state.reason : null;
    return (
      <div className="mt-2">
        <button
          type="button"
          disabled={unavailable !== null || store.kind === 'loading' || pending !== null}
          className={modalActionButton({ tone: 'primary' })}
          onClick={open}
        >
          One-time connection
        </button>
        <div className={FIELD_HINT}>
          {unavailable === null
            ? `Open a link on your phone for a one-off connection. ${phoneWhere(anyNetwork)} No account needed.`
            : (own(UNAVAILABLE_COPY, unavailable) ?? 'Not available in this build.')}
        </div>
        {error ? (
          <div className="mt-1.5 text-error">{error}</div>
        ) : store.kind === 'error' ? (
          <div className="mt-1.5 text-muted">
            Could not check this machine’s one-time connection: {store.message}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <OneTimePanel
      state={state}
      anyNetwork={anyNetwork}
      relayHost={hostOf(relayOrigin)}
      pending={pending}
      error={error}
      onOpen={open}
      onEnd={end}
    />
  );
}

/**
 * What to draw for a state under way or ended; {@link OneTimeConnection} owns
 * every action. The same framed panel as the Relay's "Set up a phone".
 */
function OneTimePanel({
  state,
  anyNetwork,
  relayHost,
  pending,
  error,
  onOpen,
  onEnd,
}: {
  state: OneTimeState;
  anyNetwork: boolean;
  relayHost: string;
  pending: 'open' | 'end' | null;
  error: string | null;
  onOpen: () => void;
  onEnd: () => void;
}) {
  const button = (label: string, onClick: () => void, disabled = pending !== null) => (
    <button type="button" disabled={disabled} className={modalActionButton()} onClick={onClick}>
      {label}
    </button>
  );
  // Cancel and End stay live through an open in flight: a link the user no
  // longer wants must be endable before it finishes arriving.
  const cancel = (label: string) => button(label, onEnd, pending === 'end');
  const frame = useRef<HTMLDivElement>(null);
  // Each new link, New link's included, is what the person is about to scan.
  const reveal = () => revealPanel(frame.current);

  let body: ReactNode;
  let actions: ReactNode;
  switch (state.status) {
    case 'opening':
      body = <div className="mt-1 text-sm text-muted">Getting a link…</div>;
      actions = cancel('Cancel');
      break;
    case 'waiting':
      body = <WaitingLink url={state.url} expiresAt={state.expiresAt} anyNetwork={anyNetwork} onShown={reveal} />;
      actions = (
        <>
          <CopyLinkButton url={state.url} />
          {button('New link', onOpen)}
          {cancel('Cancel')}
        </>
      );
      break;
    case 'confirming':
      body = (
        <div className="mt-1 text-sm leading-relaxed text-foreground">
          Type the two digits your phone shows into the dialog.
        </div>
      );
      actions = cancel('Cancel');
      break;
    case 'connecting':
      body = <div className="mt-1 text-sm text-muted">Connecting directly…</div>;
      actions = cancel('Cancel');
      break;
    case 'connected':
      body = (
        <div className="mt-1 text-sm leading-relaxed text-foreground">
          {oneTimeControlSentence(state.label)}
        </div>
      );
      actions = cancel('End');
      break;
    case 'ended':
      body = (
        <div
          role="status"
          aria-label={ONE_TIME_OUTCOME_LABEL}
          className="mt-1 text-sm leading-relaxed text-foreground"
        >
          {state.reason === 'network-not-allowed' && state.refusal
            ? pathRefusalSentence(state.refusal, 'one-time')
            : (own<string>(oneTimeEndedCopy(relayHost, anyNetwork), state.reason) ?? ENDED_FALLBACK)}
        </div>
      );
      actions = (
        <>
          {button('New link', onOpen)}
          {button('Done', onEnd)}
        </>
      );
      break;
    default:
      // `idle` and `unavailable` render as the button, never here.
      return null;
  }

  return (
    <div ref={frame} className="mt-2 rounded border border-border p-2">
      <div className={FIELD_LABEL}>One-time connection</div>
      {body}
      {error ? <div className="mt-1.5 text-sm leading-relaxed text-error">{error}</div> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/** The live link: as a code for the phone's camera, and as text to send it. */
function WaitingLink({
  url,
  expiresAt,
  anyNetwork,
  onShown,
}: {
  url: string;
  expiresAt: number;
  anyNetwork: boolean;
  onShown: () => void;
}) {
  return (
    <>
      <div className="mt-1 text-sm leading-relaxed text-muted">
        Scan this with your phone’s camera, or open the link below on it. {phoneWhere(anyNetwork)}
      </div>
      <ExpiringCode
        url={url}
        label="One-time link for this machine"
        expiresAt={expiresAt}
        noun="link"
        onShown={onShown}
      />
      {/* `select-all`: one click takes the whole link, for a person copying it
          by hand where the clipboard is refused. */}
      <ModalReviewBlock className="mt-2 select-all" density="compact" wrap="breakAll">
        {url}
      </ModalReviewBlock>
    </>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);

  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  return (
    <button
      type="button"
      className={modalActionButton()}
      onClick={() => void writeTextToClipboard(url).then((ok) => setOutcome(ok ? 'copied' : 'failed'))}
    >
      {outcome ? COPY_OUTCOME_LABEL[outcome] : 'Copy link'}
    </button>
  );
}
