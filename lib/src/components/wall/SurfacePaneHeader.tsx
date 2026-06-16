import { useContext } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowLineDownIcon,
  ArrowRightIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  FrameCornersIcon,
  KeyIcon,
  ResizeIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
  XIcon,
} from '@phosphor-icons/react';
import { HeaderActionButton } from '../HeaderActionButton';
import { TERMINAL_TOP_RADIUS_CLASS } from '../design';
import {
  useAgentBrowserChromeSnapshot,
  useAgentBrowserScreenController,
  useAgentBrowserScreenSnapshot,
} from './agent-browser-screen';
import { loopbackPort } from './browser-url';
import { triggerDevServerRescan, useDevServerMatch } from './agent-browser-ports';
import {
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedContext,
} from './wall-context';

export function SurfacePaneHeader({ api }: IDockviewPanelHeaderProps) {
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const windowFocused = useContext(WindowFocusedContext);
  const zoomed = useContext(ZoomedContext);
  const actions = useContext(WallActionsContext);
  const isActiveHeader = mode === 'passthrough' && selectedId === api.id && windowFocused;

  // Presence of a screen controller for this pane is exactly what marks it an
  // agent-browser surface — terminals/iframes never register one, so the whole
  // browser chrome (nav + URL + connection) is strictly scoped to it.
  const screen = useAgentBrowserScreenController(api.id);
  const screenSnapshot = useAgentBrowserScreenSnapshot(screen);
  const chrome = useAgentBrowserChromeSnapshot(screen);

  // Dev-server connection: when the active tab is loopback, correlate its port
  // to the Dormouse terminal pane serving it (resolved Wall-side). Hooks run
  // unconditionally; a non-loopback/no-screen surface just yields null.
  const port = chrome ? loopbackPort(chrome.url) : null;
  const devServer = useDevServerMatch(port);

  return (
    <div
      className={`flex h-full w-full cursor-grab items-center gap-1.5 ${TERMINAL_TOP_RADIUS_CLASS} pl-2 pr-[5px] text-sm leading-none font-mono select-none active:cursor-grabbing ${isActiveHeader ? 'bg-header-active-bg text-header-active-fg' : 'bg-header-inactive-bg text-header-inactive-fg'}`}
      onMouseDown={() => actions.onClickPanel(api.id)}
    >
      {screen && screenSnapshot && chrome ? (
        <>
          {/* Sync chip → far left, out of the way of the nav controls. Opens
              the screen modal; SYNCED/SCALED reflects reality. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); screen.actions.openModal(); }}
            aria-label={`Screen: ${screenSnapshot.state} — change viewport`}
            title={`Screen: ${screenSnapshot.state} — change viewport`}
            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded text-current/70 transition-colors hover:bg-current/10 hover:text-current"
          >
            {screenSnapshot.state === 'SYNCED'
              ? <FrameCornersIcon size={14} />
              : <ResizeIcon size={14} />}
          </button>

          {/* Back / forward / refresh — native agent-browser commands; always
              enabled (no canGoBack/Forward in the stream). Collapse before the
              URL but after split/zoom. */}
          <div className="hidden shrink-0 items-center gap-0.5 min-[360px]:flex">
            <HeaderActionButton
              className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
              onClick={(e) => { e.stopPropagation(); screen.chromeActions.back(); }}
              ariaLabel="Back"
              tooltip="Back"
            ><ArrowLeftIcon size={14} /></HeaderActionButton>
            <HeaderActionButton
              className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
              onClick={(e) => { e.stopPropagation(); screen.chromeActions.forward(); }}
              ariaLabel="Forward"
              tooltip="Forward"
            ><ArrowRightIcon size={14} /></HeaderActionButton>
            <HeaderActionButton
              className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
              onClick={(e) => { e.stopPropagation(); screen.chromeActions.reload(); triggerDevServerRescan(); }}
              ariaLabel="Reload"
              tooltip="Reload"
            ><ArrowClockwiseIcon size={14} /></HeaderActionButton>
          </div>

          {/* --key indicator for non-default keys only — a filled key icon
              (hover reveals `--key <name>`), never a prefix on the persisted
              title. Raw --session surfaces show none. */}
          {chrome.key && chrome.key !== 'default' && (
            <span
              className="flex h-5 min-w-5 shrink-0 items-center justify-center text-current/70"
              title={`--key ${chrome.key}`}
              aria-label={`--key ${chrome.key}`}
            >
              <KeyIcon size={14} weight="fill" />
            </span>
          )}

          {/* URL (host + path) is the primary text; HTML <title> → tooltip. */}
          <span
            className="min-w-0 truncate font-medium"
            title={chrome.title ?? chrome.url ?? undefined}
          >{chrome.displayUrl || api.title || api.id}</span>

          {/* Dev-server connection chip — only when the port maps to a single
              pane; click focuses that terminal. Degrades to just the URL
              otherwise (non-loopback, no/ambiguous match, proxied domain). */}
          {devServer && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); actions.onFocusPane(devServer.paneId); }}
              aria-label={`Focus ${devServer.label} — serves this localhost port`}
              title={`localhost served by ${devServer.label}${port != null ? ` (:${port})` : ''} — click to focus`}
              className="flex h-5 min-w-0 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-current/70 transition-colors hover:bg-current/10 hover:text-current"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
              <span className="max-w-[14ch] truncate">{devServer.label}</span>
              {port != null && <span className="text-current/50">:{port}</span>}
            </button>
          )}

          {/* Flexible spacer keeps the layout buttons right-aligned. */}
          <div className="min-w-0 flex-1" />
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium">{api.title ?? api.id}</span>
      )}

      <div className="ml-1 hidden shrink-0 items-center gap-0.5 min-[420px]:flex">
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onSplitH(api.id); }}
          ariaLabel="Split left/right"
          tooltip="Split left/right [|] or [%]"
        ><SplitHorizontalIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onSplitV(api.id); }}
          ariaLabel="Split top/bottom"
          tooltip={'Split top/bottom [-] or ["]'}
        ><SplitVerticalIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onZoom(api.id); }}
          ariaLabel={zoomed ? 'Unzoom' : 'Zoom'}
          tooltip={zoomed ? 'Unzoom [z]' : 'Zoom [z]'}
        >{zoomed ? <ArrowsInIcon size={14} /> : <ArrowsOutIcon size={14} />}</HeaderActionButton>
      </div>
      <div className="ml-1 flex shrink-0 items-center gap-0.5">
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onMinimize(api.id); }}
          ariaLabel="Minimize"
          tooltip="Minimize [m] or [d]"
        ><ArrowLineDownIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-error/10 hover:text-error"
          onClick={(e) => { e.stopPropagation(); actions.onKill(api.id); }}
          ariaLabel="Kill"
          tooltip="Kill [k] or [x]"
        ><XIcon size={14} /></HeaderActionButton>
      </div>
    </div>
  );
}
