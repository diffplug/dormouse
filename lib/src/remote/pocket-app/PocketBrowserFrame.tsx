/**
 * One Surface's page on this phone (`docs/specs/pocket-app.md` -> "Frame
 * origin"): its frame on the session, the hidden bootstrap page that joins the
 * frame origin's worker to it, and the page itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { FRAME_BOOTSTRAP_PATH, type DirectPath, type DirectRelayCause } from 'remote-lib-common';
import { MobileBrowserPane, type MobileBrowserStatus } from '../../components/MobileBrowserPane';
import type { FrameClient, OpenFrame } from '../client/frame-client';
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
  /** The origin this page frames at. */
  originFor: (pageOrigin: string) => Promise<string>;
  transport: FrameTransport;
  visible: boolean;
  onReconnect: () => void;
  onShowSessions: () => void;
}

interface Opened {
  frame: OpenFrame;
  origin: string;
}

export function embedderOrigins(location: Pick<Location, 'origin' | 'ancestorOrigins'> = window.location): string[] {
  return [location.origin, ...Array.from(location.ancestorOrigins ?? [])];
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
  // Read when opening: a new callback is no reason to reopen the frame.
  const originForRef = useRef(originFor);
  originForRef.current = originFor;

  useEffect(() => {
    if (!direct) return;
    let live = true;
    let frame: OpenFrame | null = null;
    setOpened(null);
    setJoined(false);
    setLoaded(false);
    setEnded(null);
    void (async () => {
      const origin = await originForRef.current(pageOrigin);
      frame = await frames.open({
        surfaceId,
        frameOrigin: origin,
        embedderOrigins: embedderOrigins(),
        onClosed: () => { if (live) setEnded({ kind: 'gone' }); },
      });
      if (live) setOpened({ frame, origin });
      else frame.close();
    })().catch((error: unknown) => {
      if (live) setEnded({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      live = false;
      frame?.close();
    };
  }, [attempt, direct, frames, pageOrigin, surfaceId]);

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
    const stopEditor = connectToolEditor(surfaceId, title, page, opened.origin);
    return () => {
      stopTheme();
      stopEditor();
    };
  }, [isTool, joined, opened, surfaceId, title]);

  const status: MobileBrowserStatus = ended
    ?? (!direct
      ? { kind: transport.cause ? 'relayed' : 'connecting' }
      : { kind: joined && loaded ? 'ready' : 'loading' });

  return (
    <div className={clsx('absolute inset-0 pb-[env(safe-area-inset-bottom)]', !visible && 'invisible')}>
      {opened && !ended ? (
        <iframe
          key={opened.frame.id}
          hidden
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
    </div>
  );
}
