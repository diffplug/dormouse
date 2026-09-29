import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ModalReviewBlock, modalActionButton } from './design';
import {
  FIELD_HINT,
  FIELD_LABEL,
  oneTimeControlSentence,
  own,
  useRevealWhen,
} from './remote-control-shared';
import { ExpiringCode } from './ScannableCode';
import { writeTextToClipboard } from '../lib/clipboard';
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

const IDLE_HINT =
  'Open a link on your phone for a one-off connection. Phone and computer must be on the same ' +
  'Wi-Fi. No account needed.';

/**
 * Why this build offers none, in fixed copy per reason. The origin is baked into
 * the host bundle and never crosses to the webview, so the copy names the
 * shipped one.
 */
const UNAVAILABLE_COPY: Record<OneTimeUnavailableReason, string> = {
  'origin-not-allowed':
    'Not available in this build: it isn’t allowed to reach hosted.dormouse.sh, where one-time ' +
    'links are made.',
  'origin-invalid': 'Not available in this build: its one-time link address is misconfigured.',
};

/**
 * How a connection ended, as the person at this machine reads it — **fixed copy
 * chosen by a closed reason this machine's own runtime picked**, never text off
 * a wire, and a fallback for a reason a newer VS Code broker knows and this
 * build does not.
 *
 * `user-ended` has no sentence: this machine ended it (End, Cancel), so there is
 * nothing to report, and the panel goes straight back to its button.
 */
export const ONE_TIME_ENDED_COPY: Record<Exclude<OneTimeEndReason, 'user-ended'>, string> = {
  'user-denied': 'You cancelled the phone’s request, so nothing connected.',
  'confirmation-mismatch': 'The two digits did not match, so nothing connected.',
  expired: 'The link ran out of time before a phone finished connecting.',
  'phone-left': 'The phone disconnected.',
  'direct-failed':
    'The phone couldn’t reach this computer directly. Make sure both are on the same Wi-Fi, then ' +
    'get a new link.',
  idle: 'The phone stopped responding, so the connection ended.',
  unreachable:
    'Couldn’t reach hosted.dormouse.sh to make a link. Check this computer’s internet connection, ' +
    'then try again.',
  'rendezvous-lost': 'The connection to hosted.dormouse.sh dropped before the phone finished connecting.',
  'burrow-error': 'This computer couldn’t finish the connection.',
};

const ENDED_FALLBACK = 'The one-time connection ended.';

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
 * The one-time connection in Settings' Remote control section, enrolled or not
 * (`docs/specs/one-time.md` -> "Laptop UI"): a button at rest, and a framed
 * panel for everything from opening a link to reporting how it ended.
 *
 * **It renders the service's state and owns nothing else but its own busy and
 * error.** The link lives in the Burrow service, so closing Settings leaves a
 * waiting link waiting and a connection connected; reopening re-reads it.
 * **Nothing here re-opens on a timer**: a link is single-use, so a fresh one is
 * only ever the user's New link.
 */
export function OneTimeConnection() {
  const store = useSyncExternalStore(subscribeToOneTime, getOneTimeSnapshot);
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
            ? IDLE_HINT
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
  pending,
  error,
  onOpen,
  onEnd,
}: {
  state: OneTimeState;
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
  useRevealWhen(frame, state.status === 'waiting' ? state.url : null);

  let body: ReactNode;
  let actions: ReactNode;
  switch (state.status) {
    case 'opening':
      body = <div className="mt-1 text-sm text-muted">Getting a link…</div>;
      actions = cancel('Cancel');
      break;
    case 'waiting':
      body = <WaitingLink url={state.url} expiresAt={state.expiresAt} />;
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
          {own<string>(ONE_TIME_ENDED_COPY, state.reason) ?? ENDED_FALLBACK}
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
function WaitingLink({ url, expiresAt }: { url: string; expiresAt: number }) {
  return (
    <>
      <div className="mt-1 text-sm leading-relaxed text-muted">
        Scan this with your phone’s camera, or open the link below on it. Phone and computer must be
        on the same Wi-Fi.
      </div>
      <ExpiringCode url={url} label="One-time link for this machine" expiresAt={expiresAt} noun="link" />
      {/* `select-all`: one click takes the whole link, for a person copying it
          by hand where the clipboard is refused. */}
      <ModalReviewBlock className="mt-2 select-all" density="compact" wrap="breakAll">
        {url}
      </ModalReviewBlock>
    </>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={modalActionButton()}
      onClick={() => void writeTextToClipboard(url).then((ok) => setCopied(ok ? 'copied' : 'failed'))}
    >
      {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : 'Copy link'}
    </button>
  );
}
