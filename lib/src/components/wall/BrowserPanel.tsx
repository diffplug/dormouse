/**
 * The single body component for every browser surface (docs/specs/dor-browser.md
 * → "Display Modal And Render Swaps").
 *
 * One surface, swappable renderer: it reads the canonical `renderMode` and mounts
 * the matching child — `IframePanel` for `iframe` (and `webview` on a host
 * without pane webviews), `WebviewPanel` for `webview`, `AgentBrowserPanel` for
 * either automated provider's screencast or popout modes. The children stay separate components (their
 * input models differ — CDP `input_*` messages vs native DOM); the shell only owns
 * the renderer choice. The browser chrome each child registers is keyed by
 * `api.id`, so the shared header/modal are unaffected by which child is mounted.
 */
import { rendersInIframe, resolveRenderMode } from './browser-surface';
import type { PaneProps } from './pane-props';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { IframePanel } from './IframePanel';
import { WebviewPanel } from './WebviewPanel';

export function BrowserPanel(props: PaneProps & {
  /** Once it has painted its first document or frame. */
  onReady?: () => void;
}) {
  const renderMode = resolveRenderMode(props.params);
  return (
    <div className="relative h-full w-full">
      {rendersInIframe(props.params)
        ? <IframePanel {...props} />
        : renderMode === 'webview'
          ? <WebviewPanel {...props} />
          : <AgentBrowserPanel {...props} renderMode={renderMode} />}
    </div>
  );
}
