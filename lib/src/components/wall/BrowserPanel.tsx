/**
 * The single body component for every browser surface (docs/specs/dor-browser.md
 * → "Display Modal And Render Swaps").
 *
 * One surface, swappable renderer: it reads the canonical `renderMode` and mounts
 * the matching child — `IframePanel` for `iframe`, `AgentBrowserPanel` for
 * either automated provider's screencast or popout modes. The two children stay separate components (their
 * input models differ — CDP `input_*` messages vs native DOM); the shell only owns
 * the renderer choice. The browser chrome each child registers is keyed by
 * `api.id`, so the shared header/modal are unaffected by which child is mounted.
 */
import { resolveRenderMode } from './browser-surface';
import type { PaneProps } from './pane-props';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { IframePanel } from './IframePanel';

export function BrowserPanel(props: PaneProps & {
  /** Once it has painted its first document or frame. */
  onReady?: () => void;
}) {
  const renderMode = resolveRenderMode(props.params);
  return (
    <div className="relative h-full w-full">
      {renderMode === 'iframe'
        ? <IframePanel {...props} />
        : <AgentBrowserPanel {...props} renderMode={renderMode} />}
    </div>
  );
}
