import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import {
  FreshlySpawnedContext,
  PaneElementsContext,
  WallActionsContext,
} from './wall-context';

type IframePanelParams = {
  surfaceType?: string;
  url?: string;
};

export function IframePanel({ api, params }: IDockviewPanelProps<IframePanelParams>) {
  const actions = useContext(WallActionsContext);
  const { elements: paneElements, bumpVersion } = useContext(PaneElementsContext);
  const freshlySpawned = useContext(FreshlySpawnedContext);
  const elRef = useRef<HTMLDivElement>(null);
  const url = typeof params?.url === 'string' ? params.url : '';
  const origin = useMemo(() => {
    try {
      return url ? new URL(url).origin : '';
    } catch {
      return '';
    }
  }, [url]);

  // A cross-origin iframe never reports HTTP errors or CSP/X-Frame-Options
  // blocks to us — onError doesn't fire, and onLoad fires even for a blocked
  // frame. So we can't detect failure directly; instead we surface a hint if
  // the frame hasn't reported a load within a few seconds, which covers the
  // common dead ends (server down, wrong scheme, refused framing) without
  // hiding a slow-but-fine page once it loads.
  const [loaded, setLoaded] = useState(false);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setStalled(false);
    if (!url) return;
    const timer = setTimeout(() => setStalled(true), 5000);
    return () => clearTimeout(timer);
  }, [url]);

  useEffect(() => {
    if (!elRef.current) return;
    paneElements.set(api.id, elRef.current);
    bumpVersion();
    return () => {
      paneElements.delete(api.id);
      bumpVersion();
    };
  }, [api.id, paneElements, bumpVersion]);

  useLayoutEffect(() => {
    const direction = freshlySpawned.get(api.id);
    if (!direction) return;
    freshlySpawned.delete(api.id);
    const groupEl = api.group?.element;
    if (!groupEl) return;
    const className = `pane-spawning-from-${direction}`;
    const animationName = `pane-spawn-from-${direction}`;
    groupEl.classList.add(className);
    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== animationName) return;
      groupEl.classList.remove(className);
      groupEl.removeEventListener('animationend', onEnd);
    };
    groupEl.addEventListener('animationend', onEnd);
    return () => {
      groupEl.removeEventListener('animationend', onEnd);
      groupEl.classList.remove(className);
    };
  }, [api, freshlySpawned]);

  return (
    <div
      ref={elRef}
      className={`relative h-full w-full overflow-hidden bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      onMouseDown={() => actions.onClickPanel(api.id)}
    >
      {url ? (
        <>
          <iframe
            className="block h-full w-full border-0 bg-white"
            src={url}
            title={api.title ?? url}
            allow="autoplay; clipboard-read; clipboard-write; fullscreen; geolocation; microphone; camera"
            referrerPolicy={origin ? 'strict-origin-when-cross-origin' : undefined}
            onLoad={() => setLoaded(true)}
          />
          {!loaded && stalled && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-terminal-bg/90 px-4 py-2 text-xs text-muted">
              Still loading <span className="font-semibold">{url}</span> — if it stays blank, the server may be down, on a different scheme (http vs https), or refusing to be embedded in a frame.
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-terminal-bg px-4 text-sm text-muted">
          No iframe URL was provided.
        </div>
      )}
    </div>
  );
}
