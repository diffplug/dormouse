/**
 * The body of a `tool` Surface: one Session with a terminal and, once it
 * serves, a browser (`docs/specs/dor-tool.md` -> Lifecycle).
 *
 * Both halves stay mounted for the Surface's whole life and the flip is
 * visibility only. Unmounting the terminal would drop the xterm buffer the
 * command is still writing to, and unmounting the browser would reload the
 * framed document on every toggle — the invariant that lets a tool keep one id
 * while its capabilities come and go.
 */
import { BrowserPanel } from './BrowserPanel';
import { TerminalPanel } from './TerminalPanel';
import { toolShowsBrowser } from './browser-surface';
import type { PaneProps } from './pane-props';

export function ToolPanel(props: PaneProps) {
  const showBrowser = toolShowsBrowser(props.params);
  return (
    <div className="relative h-full w-full">
      {/* `hidden` rather than a conditional: see the module comment. The hidden
          half is also `parked`, so a screencast idles instead of decoding
          frames nobody is looking at (`useSurfaceVisibility`). */}
      <div className="absolute inset-0" hidden={showBrowser}>
        <TerminalPanel {...props} />
      </div>
      <div className="absolute inset-0" hidden={!showBrowser}>
        <BrowserPanel {...props} parked={props.parked || !showBrowser} />
      </div>
    </div>
  );
}
