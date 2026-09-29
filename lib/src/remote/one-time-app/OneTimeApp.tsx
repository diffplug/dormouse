/**
 * The one-time phone page (`docs/specs/one-time.md` -> "Phone page"), which
 * Hosted serves at `/connect/`: the link a computer showed, a Connect tap, two
 * digits to type on that computer, then Pocket's mobile wall over the direct
 * path — and nothing kept, since this origin is Hosted's accounts' too.
 *
 * The screens draw on Pocket's chrome and shared views; the session is a
 * {@link OneTimeClient}, whose `connectOnce` runs the whole ceremony and is the
 * only thing that opens a socket.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  ONE_TIME_UNKNOWN_DEVICE_LABEL,
  oneTimeLinkExpired,
  parseOneTimeLinkUrl,
  probeNoiseSupport,
  type OneTimeDeviceLabel,
  type OneTimeLink,
} from 'remote-lib-common';

import { browserDirectPeer } from '../client/browser-direct-peer';
import {
  ONE_TIME_ENDED_MESSAGE,
  ONE_TIME_LINK_EXPIRED_MESSAGE,
  OneTimeClient,
} from '../client/one-time-client';
import type { RemotePtyAdapter } from '../client/remote-adapter';
import type { RemoteWebSocket } from '../ws';
import { disposeAllSessions } from '../../lib/terminal-registry';
import { PocketWall } from '../pocket-app/PocketWall';
import { PK, pkButton } from '../pocket-app/pocket-chrome';
import { applyPocketTheme } from '../pocket-app/pocket-theme';
import { mountRemoteWall, type RemoteWallClient } from '../pocket-app/remote-wall';
import { PairingCodeView, PocketScreen, TransportIndicator, Waiting } from '../pocket-app/views';

// --- Copy -------------------------------------------------------------------

/** The header on every screen but the wall, which names the computer instead. */
const ONE_TIME_HEADING = 'One-time connection';

export const ONE_TIME_UNSUPPORTED_TITLE = 'This browser cannot make a one-time connection';
const ONE_TIME_UNSUPPORTED_BODY =
  'A one-time connection needs X25519 in the Web Crypto API and WebRTC, which this browser ' +
  'does not have. Update it, or open the link in a newer browser.';

export const ONE_TIME_INVALID_TITLE = 'This link does not work';
export const ONE_TIME_INVALID_MESSAGE =
  'It may be incomplete, or copied wrong. Open a new link from your computer.';

/** Over every ending, and over a link that was dead on arrival: the message says which. */
export const ONE_TIME_NOT_CONNECTED_TITLE = 'Not connected';

export const ONE_TIME_READY_TITLE = 'Connect to your computer';
const ONE_TIME_SAME_WIFI =
  'Your phone and computer must be on the same Wi-Fi. Nothing is saved on this phone.';
export const ONE_TIME_CONNECT_LABEL = 'Connect';

const ONE_TIME_CODE_INSTRUCTION = 'Type these two digits on your computer.';

export const ONE_TIME_CONNECTING_TITLE = 'Connecting directly…';
const ONE_TIME_CONNECTING_BODY =
  'Keep this page open. Your phone and computer must be on the same Wi-Fi.';

export const ONE_TIME_END_LABEL = 'End';

/** What {@link oneTimeDeviceLabel} reads of the browser; `navigator` satisfies it. */
export interface DeviceHints {
  readonly platform?: string;
  readonly userAgent?: string;
  readonly maxTouchPoints?: number;
  readonly userAgentData?: { readonly platform?: string };
}

/**
 * The label this page sends, which the laptop's approval modal shows beside
 * the digits: a coarse name for the device, always a member of
 * `ONE_TIME_DEVICE_LABELS` — the Burrow shows nothing else. Never Pocket's
 * `deviceLabel` — this page is not Pocket, and it holds no Client identity for
 * a Home Screen install to be told apart from.
 */
export function oneTimeDeviceLabel(
  hints: DeviceHints = typeof navigator === 'undefined' ? {} : navigator,
): OneTimeDeviceLabel {
  const platform = hints.userAgentData?.platform ?? hints.platform ?? '';
  if (/iPhone/i.test(platform)) return 'iPhone';
  // iPadOS Safari reports a Mac; only the touch screen tells them apart.
  if (/iPad/i.test(platform) || (platform === 'MacIntel' && (hints.maxTouchPoints ?? 0) > 1)) {
    return 'iPad';
  }
  // Without `userAgentData` (Firefox, Safari) Android's platform reads `Linux …`.
  if (/Android/i.test(platform)) return 'Android phone';
  if (!hints.userAgentData && /Android/i.test(hints.userAgent ?? '')) return 'Android phone';
  return ONE_TIME_UNKNOWN_DEVICE_LABEL;
}

/** How long a live link has left, to the minute and then to the second. */
export function expiresInText(remainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return seconds >= 60 ? `Expires in ${Math.ceil(seconds / 60)} min.` : `Expires in ${seconds} s.`;
}

// --- The client -------------------------------------------------------------

/** What the page drives: the ceremony, its ending, and the session the wall runs on. */
export type OneTimePageClient = RemoteWallClient &
  Pick<OneTimeClient, 'connectOnce' | 'setOnEnded' | 'close'>;

/**
 * The page's client: the rendezvous on this page's own origin — `wss:` on
 * Hosted, `ws:` on the loopback dev loop — the browser's own WebSocket, and
 * the phone's one direct-peer factory. Building it opens nothing.
 */
function createOneTimePageClient(): OneTimePageClient {
  return new OneTimeClient({
    wsOrigin: location.origin.replace(/^http/, 'ws'),
    createWebSocket: (url) => new WebSocket(url) as unknown as RemoteWebSocket,
    createDirectPeer: browserDirectPeer,
  });
}

/**
 * Everything a one-time connection needs of this browser: the Noise suite, and
 * WebRTC, since there is no relayed fallback to degrade to. Never throws.
 */
async function probeOneTimeSupport(): Promise<boolean> {
  return typeof RTCPeerConnection !== 'undefined' && (await probeNoiseSupport());
}

// --- The page ---------------------------------------------------------------

/** Which screen is up, carrying whatever only that screen has. */
type Phase =
  /** The capability probe and the parse, not yet settled. */
  | { readonly at: 'checking' }
  | { readonly at: 'unsupported' }
  | { readonly at: 'invalid' }
  /** A live link, waiting on the person's tap. */
  | { readonly at: 'ready'; readonly link: OneTimeLink }
  /** `code` is null between the tap and the handshake's two digits. */
  | { readonly at: 'code'; readonly code: string | null }
  | { readonly at: 'connecting' }
  | { readonly at: 'wall'; readonly burrowLabel: string; readonly adapter: RemotePtyAdapter }
  /** Terminal: fixed copy, and no way back but a new link. */
  | { readonly at: 'ended'; readonly message: string };

export function OneTimeApp({
  linkUrl,
  createClient = createOneTimePageClient,
}: {
  /** The URL the page arrived at, taken before its fragment was erased; null with no fragment. */
  linkUrl: string | null;
  /** Test/story seam for the client; see {@link createOneTimePageClient}. */
  createClient?: () => OneTimePageClient;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ at: 'checking' });
  const clientRef = useRef<OneTimePageClient | null>(null);
  const adapterRef = useRef<RemotePtyAdapter | null>(null);
  /** Set by the first ending: nothing after it moves the page. */
  const endedRef = useRef(false);

  // Gated, not degraded: no link is parsed and nothing is offered until the
  // probe answers, and a browser that fails it gets a fixed requirement.
  useEffect(() => {
    let live = true;
    void (async () => {
      if (!(await probeOneTimeSupport())) {
        if (live) setPhase({ at: 'unsupported' });
        return;
      }
      // Parsed at the epoch, so an expired link is told apart from a wrong one.
      const link = await parseOneTimeLinkUrl(linkUrl, location.origin, 0);
      if (!live) return;
      if (link === null) setPhase({ at: 'invalid' });
      else if (!oneTimeLinkExpired(link, Date.now())) setPhase({ at: 'ready', link });
      else setPhase({ at: 'ended', message: ONE_TIME_LINK_EXPIRED_MESSAGE });
    })();
    return () => {
      live = false;
    };
  }, [linkUrl]);

  /** Release the wall's adapter and every terminal it built. */
  const disposeWall = useCallback(() => {
    const adapter = adapterRef.current;
    adapterRef.current = null;
    if (!adapter) return;
    void adapter.dispose();
    disposeAllSessions();
  }, []);

  /** Every way the page ends: once, releasing everything, on fixed copy. */
  const end = useCallback(
    (message: string) => {
      if (endedRef.current) return;
      endedRef.current = true;
      disposeWall();
      clientRef.current?.close();
      setPhase({ at: 'ended', message });
    },
    [disposeWall],
  );

  // A page torn down mid-session leaves nothing running.
  useEffect(
    () => () => {
      disposeWall();
      clientRef.current?.close();
    },
    [disposeWall],
  );

  /**
   * **The person's tap, and the only place a socket can come from**: the client
   * is built here and `connectOnce` runs here, so a link-preview crawler that
   * loads the page spends nothing.
   */
  const connect = useCallback(
    async (link: OneTimeLink) => {
      if (clientRef.current) return;
      const client = createClient();
      clientRef.current = client;
      // Before the ceremony, so an ending right after the switch is heard.
      client.setOnEnded(end);
      setPhase({ at: 'code', code: null });
      const result = await client.connectOnce(
        link,
        oneTimeDeviceLabel(),
        (code) => {
          if (!endedRef.current) setPhase({ at: 'code', code });
        },
        () => {
          if (!endedRef.current) setPhase({ at: 'connecting' });
        },
      );
      if (!result.ok) {
        end(result.message);
        return;
      }
      let adapter: RemotePtyAdapter;
      try {
        adapter = await mountRemoteWall(client);
      } catch {
        end(ONE_TIME_ENDED_MESSAGE);
        return;
      }
      adapterRef.current = adapter;
      // Ended while the wall stood up: the ending already ran, so this is the
      // one adapter it could not see.
      if (endedRef.current) {
        disposeWall();
        return;
      }
      setPhase({ at: 'wall', burrowLabel: result.burrowLabel, adapter });
    },
    [createClient, disposeWall, end],
  );

  const endNow = useCallback(() => end(ONE_TIME_ENDED_MESSAGE), [end]);
  /** Before any tap there is no client to end: the link simply ran out on screen. */
  const expireLink = useCallback(
    () => setPhase({ at: 'ended', message: ONE_TIME_LINK_EXPIRED_MESSAGE }),
    [],
  );

  switch (phase.at) {
    case 'checking':
      return <Waiting />;
    case 'unsupported':
      return (
        <PocketScreen heading={ONE_TIME_HEADING}>
          <p className={PK.title}>{ONE_TIME_UNSUPPORTED_TITLE}</p>
          <p className={PK.lead}>{ONE_TIME_UNSUPPORTED_BODY}</p>
        </PocketScreen>
      );
    case 'invalid':
      return <OneTimeNotice title={ONE_TIME_INVALID_TITLE} message={ONE_TIME_INVALID_MESSAGE} />;
    case 'ready':
      return (
        <LiveReady
          link={phase.link}
          onConnect={() => void connect(phase.link)}
          onExpired={expireLink}
        />
      );
    case 'code':
      return <OneTimeCode code={phase.code} onCancel={endNow} />;
    case 'connecting':
      return <OneTimeConnecting onCancel={endNow} />;
    case 'wall':
      return (
        <OneTimeWall burrowLabel={phase.burrowLabel} adapter={phase.adapter} onEnd={endNow} />
      );
    case 'ended':
      return <OneTimeNotice title={ONE_TIME_NOT_CONNECTED_TITLE} message={phase.message} />;
  }
}

/** {@link OneTimeReady} with its clock: a link that runs out on screen ends there. */
function LiveReady({
  link,
  onConnect,
  onExpired,
}: {
  link: OneTimeLink;
  onConnect: () => void;
  onExpired: () => void;
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const expired = oneTimeLinkExpired(link, now);
  useEffect(() => {
    if (expired) {
      onExpired();
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expired, onExpired]);
  return <OneTimeReady expiresInMs={link.expiry * 1000 - now} onConnect={onConnect} />;
}

// --- Screens ----------------------------------------------------------------

/** A link that cannot be used, or a connection that is over: no action, just what to do next. */
export function OneTimeNotice({ title, message }: { title: string; message: string }): React.ReactElement {
  return (
    <PocketScreen heading={ONE_TIME_HEADING}>
      <p className={PK.title}>{title}</p>
      <p className={PK.lead} role="status">
        {message}
      </p>
    </PocketScreen>
  );
}

/** A live link: what it does, how long it has, and the tap that spends it. */
export function OneTimeReady({
  expiresInMs,
  onConnect,
}: {
  expiresInMs: number;
  onConnect: () => void;
}): React.ReactElement {
  return (
    <PocketScreen heading={ONE_TIME_HEADING}>
      <p className={PK.title}>{ONE_TIME_READY_TITLE}</p>
      <p className={PK.lead}>{ONE_TIME_SAME_WIFI}</p>
      <button type="button" className={pkButton({ block: true })} onClick={onConnect}>
        {ONE_TIME_CONNECT_LABEL}
      </button>
      <p className={clsx(PK.fieldLabel, 'text-center')}>{expiresInText(expiresInMs)}</p>
    </PocketScreen>
  );
}

/** The two digits, on Pocket's own screen for them; see {@link PairingCodeView}. */
export function OneTimeCode({
  code,
  onCancel,
}: {
  code: string | null;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <PairingCodeView
      code={code}
      onCancel={onCancel}
      heading={ONE_TIME_HEADING}
      instruction={ONE_TIME_CODE_INSTRUCTION}
    />
  );
}

/** Confirmed on the computer; the direct path is forming. */
export function OneTimeConnecting({ onCancel }: { onCancel: () => void }): React.ReactElement {
  return (
    <PocketScreen heading={ONE_TIME_HEADING}>
      <p className={PK.title} role="status">
        {ONE_TIME_CONNECTING_TITLE}
      </p>
      <p className={PK.lead}>{ONE_TIME_CONNECTING_BODY}</p>
      <button type="button" className={pkButton({ tone: 'outline', block: true })} onClick={onCancel}>
        Cancel
      </button>
    </PocketScreen>
  );
}

/**
 * The session: the computer's label, the path — always direct here, since
 * the wall mounts only after the switch — and End, over Pocket's mobile wall.
 */
function OneTimeWall({
  burrowLabel,
  adapter,
  onEnd,
}: {
  burrowLabel: string;
  adapter: RemotePtyAdapter;
  /** End, and a wall that fails under the session, both end the page. */
  onEnd: () => void;
}): React.ReactElement {
  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>{burrowLabel}</h1>
        <TransportIndicator transport={{ path: 'direct', cause: null }} />
        <button type="button" className={pkButton({ tone: 'ghost', size: 'sm' })} onClick={onEnd}>
          {ONE_TIME_END_LABEL}
        </button>
      </header>
      <div className={PK.wallHost}>
        <PocketWall adapter={adapter} onError={onEnd} restoreTheme={applyPocketTheme} />
      </div>
    </div>
  );
}
