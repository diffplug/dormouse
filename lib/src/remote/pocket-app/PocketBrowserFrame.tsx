/**
 * One Surface's page on this phone (`docs/specs/pocket-app.md` -> "Frame
 * origin"): its frame on the session, the hidden bootstrap page that joins the
 * frame origin's worker to it, and the page itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { FRAME_BOOTSTRAP_PATH, type DirectPath, type DirectRelayCause } from 'remote-lib-common';
import { MobileBrowserPane, type MobileBrowserStatus } from '../../components/MobileBrowserPane';
import { ExternalLinkModal } from '../../components/ExternalLinkModal';
import { inspectExternalUri } from '../../lib/external-links';
import { isBrowsableUrl } from '../../lib/platform/browser-automation';
import type { FrameClient, OpenFrame } from '../client/frame-client';
import { embedderOrigins } from '../../lib/embedder-origins';
import { messageOf } from '../../lib/errors';
import { serveFrame } from '../frame-origin/frame-bridge';
import { IFRAME_ALLOW, IFRAME_SANDBOX } from '../../lib/iframe-policy';
import { connectIframeTheme } from '../../lib/themes/iframe-theme';
import { connectToolEditor } from '../../lib/tool-editor';

/** Past a slow first registration of the worker on a phone. */
const BOOTSTRAP_TIMEOUT_MS = 20_000;

export interface FrameTransport {
  path: DirectPath;
  cause: DirectRelayCause | null;
}

export interface PocketBrowserFrameProps {
  frames: FrameClient;
  surfaceId: string;
  isTool: boolean;
  title: string;
  /** The page the Surface embeds; another origin is another frame. */
  pageUrl: string;
  /** The origin a Surface's page frames at. Stable: a new one reopens the frame. */
  originFor: (surfaceId: string, pageOrigin: string) => Promise<string>;
  transport: FrameTransport;
  visible: boolean;
  onReconnect: () => void;
  onShowSessions: () => void;
}

interface Opened {
  frame: OpenFrame;
  origin: string;
}

export function PocketBrowserFrame({
  frames,
  surfaceId,
  isTool,
  title,
  pageUrl,
  originFor,
  transport,
  visible,
  onReconnect,
  onShowSessions,
}: PocketBrowserFrameProps): React.ReactElement {
  const pageOrigin = new URL(pageUrl).origin;
  const direct = transport.path === 'direct';
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [joined, setJoined] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [ended, setEnded] = useState<MobileBrowserStatus | null>(null);
  const pageRef = useRef<HTMLIFrameElement | null>(null);
  // Read at the connect: a new title is no reason to reconnect the editor.
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    if (!direct) return;
    let live = true;
    let frame: OpenFrame | null = null;
    setOpened(null);
    setJoined(false);
    setLoaded(false);
    setEnded(null);
    void (async () => {
      const origin = await originFor(surfaceId, pageOrigin);
      frame = await frames.open({
        surfaceId,
        pageOrigin,
        frameOrigin: origin,
        embedderOrigins: embedderOrigins(),
        onClosed: () => { if (live) setEnded({ kind: 'gone' }); },
      });
      if (live) setOpened({ frame, origin });
      else frame.close();
    })().catch((error: unknown) => {
      if (live) setEnded({ kind: 'failed', message: messageOf(error) });
    });
    return () => {
      live = false;
      frame?.close();
    };
  }, [attempt, direct, frames, originFor, pageOrigin, surfaceId]);

  // Joined once the bootstrap page says its worker is up; until then, a request
  // the page made would find nothing to answer it.
  const stopServing = useRef<(() => void) | null>(null);
  const onBootstrapLoad = useCallback((event: React.SyntheticEvent<HTMLIFrameElement>) => {
    if (!opened) return;
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (message) => {
      if ((message.data as { kind?: unknown } | null)?.kind !== 'ready') return;
      stopServing.current = serveFrame(opened.frame, port1);
      setJoined(true);
    };
    event.currentTarget.contentWindow?.postMessage({ kind: 'dormouse-frame-connect' }, opened.origin, [port2]);
  }, [opened]);

  useEffect(() => () => {
    stopServing.current?.();
    stopServing.current = null;
  }, [opened]);

  useEffect(() => {
    if (!opened || joined) return;
    const timer = setTimeout(() => {
      setEnded({ kind: 'failed', message: `Couldn’t reach ${new URL(opened.origin).hostname}.` });
    }, BOOTSTRAP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [joined, opened]);

  // A Tool's channels, as a pane has them: its theme, and its unsaved edits.
  useEffect(() => {
    const page = pageRef.current;
    if (!isTool || !joined || !opened || !page) return;
    const stopTheme = connectIframeTheme(page, opened.origin);
    const stopEditor = connectToolEditor(surfaceId, titleRef.current, page, opened.origin);
    return () => {
      stopTheme();
      stopEditor();
    };
  }, [isTool, joined, opened, surfaceId]);

  // The shim hands a new-window request to whoever frames the page, which has no
  // pane to open: its own page loads in place, and elsewhere is one tap away.
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    const receive = (event: MessageEvent) => {
      const page = pageRef.current;
      const data = event.data as { __dormouse?: unknown; url?: unknown } | null;
      if (!page || event.source !== page.contentWindow || event.origin !== opened.origin) return;
      if (data?.__dormouse !== 'open-window' || !isBrowsableUrl(data.url)) return;
      const url = new URL(data.url);
      if (url.origin === opened.origin || url.origin === pageOrigin) {
        page.src = `${opened.origin}${url.pathname}${url.search}${url.hash}`;
      } else {
        setLink(url.href);
      }
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      setLink(null);
    };
  }, [opened, pageOrigin]);

  const status: MobileBrowserStatus = ended
    ?? (!direct
      ? { kind: transport.cause ? 'relayed' : 'connecting' }
      : { kind: joined && loaded ? 'ready' : 'loading' });

  return (
    <div className={clsx('absolute inset-0', !visible && 'invisible')}>
      {opened && !ended ? (
        <iframe
          key={opened.frame.id}
          hidden
          // Same-origin with the page, which can script it: sandboxed no less
          // than the page, or the page steps out of its own sandbox through it.
          sandbox="allow-scripts allow-same-origin"
          title="Frame bootstrap"
          src={`${opened.origin}${FRAME_BOOTSTRAP_PATH}`}
          onLoad={onBootstrapLoad}
        />
      ) : null}
      <MobileBrowserPane
        status={status}
        view={opened && joined ? (
          <iframe
            ref={pageRef}
            key={opened.frame.id}
            title={title}
            allow={IFRAME_ALLOW}
            sandbox={IFRAME_SANDBOX}
            src={`${opened.origin}${opened.frame.path}`}
            onLoad={() => setLoaded(true)}
            className="block h-full w-full border-0 bg-white"
          />
        ) : null}
        onReconnect={onReconnect}
        onRetry={() => setAttempt((count) => count + 1)}
        onShowSessions={onShowSessions}
      />
      {link && visible ? (
        <ExternalLinkModal
          request={{ uri: link, displayText: '', verdict: 'match', decision: inspectExternalUri(link) }}
          onCancel={() => setLink(null)}
          onConfirm={() => {
            window.open(link, '_blank', 'noopener,noreferrer');
            setLink(null);
          }}
        />
      ) : null}
    </div>
  );
}
