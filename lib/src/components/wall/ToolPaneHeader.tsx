/**
 * Header for a `tool` Surface (`docs/specs/dor-tool.md` -> Lifecycle).
 *
 * A leading chip toggles which half is forward, then the header for whichever
 * half that is: the terminal's while the tool is booting or pinned back, the
 * browser chrome once it serves. Delegating rather than reimplementing keeps
 * one header per capability — a tool's browser gets the same URL editor, nav
 * buttons, and Display modal a plain browser Surface has, minus pop-out: a
 * tool has no third renderer to land in (`docs/specs/dor-tool.md` ->
 * Declaring tools).
 */
import { useContext } from 'react';
import { Terminal, Globe } from '@phosphor-icons/react';
import { chromeButton } from '../design';
import { SurfacePaneHeader } from './SurfacePaneHeader';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { browserUrlFromParams, isToolParams, toolShowsBrowser } from './browser-surface';
import { WallActionsContext } from './wall-context';
import type { PaneProps } from './pane-props';

export function ToolPaneHeader(props: PaneProps) {
  const actions = useContext(WallActionsContext);
  const showBrowser = toolShowsBrowser(props.params);
  // A tool that has never served has nothing to toggle to: the chip would
  // offer a browser that does not exist yet.
  const canToggle = isToolParams(props.params) && browserUrlFromParams(props.params) !== null;

  return (
    <div className="flex h-full min-w-0 flex-1 items-center">
      {canToggle ? (
        <button
          type="button"
          className={`${chromeButton()} ml-1 shrink-0`}
          title={showBrowser ? 'Show terminal' : 'Show browser'}
          aria-label={showBrowser ? 'Show terminal' : 'Show browser'}
          aria-pressed={!showBrowser}
          onClick={(event) => {
            // The header row is also the drag handle and the select target.
            event.stopPropagation();
            actions.onToggleToolTerminal?.(props.id);
          }}
        >
          {showBrowser ? <Terminal size={13} weight="bold" /> : <Globe size={13} weight="bold" />}
        </button>
      ) : null}
      <div className="flex h-full min-w-0 flex-1 items-center">
        {showBrowser ? <SurfacePaneHeader {...props} /> : <TerminalPaneHeader {...props} />}
      </div>
    </div>
  );
}
