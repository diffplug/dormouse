import { useContext, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getPlatform } from '../../lib/platform';
import { registerProxyOrigin } from '../../lib/iframe-proxy-registry';
import { registerSurfaceFocusHandle } from '../../lib/terminal-registry';
import type { IframeProxyResult } from '../../lib/platform/types';
import { usePaneChrome } from './use-pane-chrome';
import { WallActionsContext } from './wall-context';

type IframePanelParams = {
  surfaceType?: string;
  url?: string;
};

// Sandbox the proxied frame so a tool's `if (top !== self) top.location = …`
// framebust cannot navigate the Wall away — allow-top-navigation is omitted on
// purpose (docs/specs/dor-iframe.md → "Anti-framebust"). Everything else a local
// dev tool needs is granted; allow-same-origin is safe here because the frame's
// origin (the loopback proxy) is never same-origin with the host webview.
const PROXY_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads';
const IFRAME_ALLOW = 'autoplay; clipboard-read; clipboard-write; fullscreen; geolocation; microphone; camera';

type Resolution =
  | { kind: 'empty' }
  | { kind: 'resolving' }
  | { kind: 'proxied'; src: string; origin: string }
  // The host can't run a proxy (e.g. the web host) — keep the blind raw-iframe
  // fallback rather than hiding the surface (Open Decision #4).
  | { kind: 'raw'; src: string }
  | { kind: 'error'; reason: 'frame-refused' | 'unreachable' | 'scheme'; detail?: string };

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function IframePanel({ api, params }: IDockviewPanelProps<IframePanelParams>) {
  const actions = useContext(WallActionsContext);
  const elRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  usePaneChrome(api, elRef);
  const url = typeof params?.url === 'string' ? params.url : '';

  // Ask the host to front the target with its transparent proxy. The returned
  // URL is a loopback origin that serves the page's bytes (instrumented for
  // loopback) so Dormouse — now the server — gets a keyboard side-channel, an
  // accurate focus model, and real error pages. Reachability/frame-refusal are
  // diagnosed by the proxy and shown as a served page inside the frame.
  const [resolution, setResolution] = useState<Resolution>(() => (url ? { kind: 'resolving' } : { kind: 'empty' }));
  useEffect(() => {
    if (!url) {
      setResolution({ kind: 'empty' });
      return;
    }
    const createProxy = getPlatform().createIframeProxyUrl;
    if (!createProxy) {
      setResolution({ kind: 'raw', src: url });
      return;
    }
    let cancelled = false;
    setResolution({ kind: 'resolving' });
    createProxy(url).then(
      (result: IframeProxyResult) => {
        if (cancelled) return;
        if (result.ok) setResolution({ kind: 'proxied', src: result.url, origin: originOf(result.url) });
        else setResolution({ kind: 'error', reason: result.reason, detail: result.detail });
      },
      () => {
        if (!cancelled) setResolution({ kind: 'error', reason: 'unreachable' });
      },
    );
    return () => { cancelled = true; };
  }, [url]);

  // Trust postMessage from this frame's origin (validated by the Wall's
  // keyboard/focus channel) only while the proxied surface is live.
  useEffect(() => {
    if (resolution.kind !== 'proxied' || !resolution.origin) return;
    return registerProxyOrigin(resolution.origin);
  }, [resolution.kind === 'proxied' ? resolution.origin : null]);

  // Register a focus handle so onClickPanel → enterTerminalMode can focus the
  // frame like any other surface (spec → "#3"). Focusing the element moves
  // keyboard focus into the frame; the shim then reports focus back to the Wall.
  useEffect(() => {
    if (resolution.kind !== 'proxied' && resolution.kind !== 'raw') return;
    return registerSurfaceFocusHandle(api.id, {
      focus: () => iframeRef.current?.focus(),
      blur: () => iframeRef.current?.blur(),
    });
  }, [api.id, resolution.kind]);

  // Clicking *into* a cross-origin frame doesn't bubble a mousedown to the pane,
  // so the onMouseDown below never fires and the surface never enters
  // passthrough. Detect the frame taking focus (window blurs while our iframe
  // becomes activeElement, app still focused) and adopt it as entering the pane,
  // so mode/selection stay consistent and the leader chord can round-trip out.
  useEffect(() => {
    if (resolution.kind !== 'proxied' && resolution.kind !== 'raw') return;
    const onWindowBlur = () => {
      if (document.hasFocus() && document.activeElement === iframeRef.current) {
        actions.onClickPanel(api.id);
      }
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [api.id, resolution.kind, actions]);

  const src = resolution.kind === 'proxied' || resolution.kind === 'raw' ? resolution.src : '';

  return (
    <div
      ref={elRef}
      className={`relative h-full w-full overflow-hidden bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      // A cross-origin iframe is an out-of-process frame; Chromium maps pointer
      // events to it relative to its nearest compositing/containing ancestor.
      // Dockview's root (.dv-dockview) sets `contain: layout`, so without this
      // the frame's reference is that far-away root and clicks land offset by the
      // pane's distance from it. translateZ(0) gives this container its own layer
      // co-located with the frame, collapsing the offset to ~0. It's identity, so
      // getBoundingClientRect (overlay measurement) is unaffected.
      style={{ transform: 'translateZ(0)' }}
      onMouseDown={() => actions.onClickPanel(api.id)}
    >
      {src ? (
        <iframe
          ref={iframeRef}
          className="block h-full w-full border-0 bg-white"
          src={src}
          title={api.title ?? url}
          allow={IFRAME_ALLOW}
          {...(resolution.kind === 'proxied' ? { sandbox: PROXY_SANDBOX, 'data-dormouse-proxy': 'true' } : {})}
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <PanelMessage resolution={resolution} url={url} />
      )}
    </div>
  );
}

function PanelMessage({ resolution, url }: { resolution: Resolution; url: string }) {
  const base = 'flex h-full w-full items-center justify-center bg-terminal-bg px-6 text-center text-sm text-muted';

  if (resolution.kind === 'resolving') {
    return <div className={base}>Connecting to <span className="ml-1 font-semibold">{url}</span>…</div>;
  }
  if (resolution.kind === 'empty') {
    return <div className={base}>No iframe URL was provided.</div>;
  }
  // proxied/raw render the iframe itself, never this fallback.
  if (resolution.kind !== 'error') return null;
  // 'error' — the proxy turned a dead end into something actionable. (Most
  // unreachable/frame-refused cases are served as a page inside the frame; this
  // covers the synchronous ones, chiefly an unproxyable scheme.)
  return (
    <div className={`${base} flex-col gap-2`}>
      <div>{messageFor(resolution)}</div>
      <div className="text-xs text-muted/80">
        For arbitrary web pages, use <code className="rounded bg-app-bg px-1 py-0.5">dor ab open {url}</code>
      </div>
    </div>
  );
}

function messageFor(resolution: Extract<Resolution, { kind: 'error' }>): string {
  switch (resolution.reason) {
    case 'scheme':
      return resolution.detail
        ? `Can’t frame this URL — ${resolution.detail}.`
        : 'The iframe surface only frames local http:// servers.';
    case 'frame-refused':
      return 'This page refuses to be embedded in a frame.';
    case 'unreachable':
    default:
      return resolution.detail ? `Couldn’t reach the server — ${resolution.detail}.` : 'Couldn’t reach the server.';
  }
}
