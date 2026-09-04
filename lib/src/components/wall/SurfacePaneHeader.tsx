import { useContext, useEffect, useState } from 'react';
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowLineDownIcon,
  ArrowRightIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
  XIcon,
} from '@phosphor-icons/react';
import { HeaderActionButton } from '../HeaderActionButton';
import { HEADER_PALETTE_TRANSITION_CLASS, paneZoomButtonClass, TERMINAL_TOP_RADIUS_CLASS } from '../design';
import {
  useAgentBrowserChromeSnapshot,
  useAgentBrowserScreenController,
  useAgentBrowserScreenSnapshot,
  browserDisplayMode,
} from './agent-browser-screen';
import { BROWSER_DISPLAY_LABEL, BrowserDisplayIcon } from './BrowserDisplayIcon';
import { InlineEditInput } from './InlineEditInput';
import type { PaneProps } from './pane-props';
import { loopbackPort, normalizeNavUrl, pathDisplay } from './browser-url';
import { triggerDevServerRescan, useDevServerMatch } from './agent-browser-ports';
import {
  DialogKeyboardContext,
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedIdContext,
} from './wall-context';

export function SurfacePaneHeader({ id, title }: PaneProps) {
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const windowFocused = useContext(WindowFocusedContext);
  const zoomed = useContext(ZoomedIdContext) === id;
  const actions = useContext(WallActionsContext);
  const isActiveHeader = mode === 'passthrough' && selectedId === id && windowFocused;

  // Presence of a screen controller for this pane is exactly what marks it a
  // browser surface — both renderers register one, terminals never do, so the
  // whole browser chrome (nav + URL + connection) is strictly scoped to it.
  const screen = useAgentBrowserScreenController(id);
  const screenSnapshot = useAgentBrowserScreenSnapshot(screen);
  const chrome = useAgentBrowserChromeSnapshot(screen);
  // The far-left chip uses the same capability-first identity as the Display
  // modal and minimized Door, keyed once so its visible and accessible meanings
  // cannot drift.
  const displayMode = screenSnapshot ? browserDisplayMode(screenSnapshot) : null;
  const displayLabel = displayMode ? `${BROWSER_DISPLAY_LABEL[displayMode]} — change display` : undefined;

  // Dev-server connection: when the active tab is loopback, correlate its port
  // to the Dormouse terminal pane serving it (resolved Wall-side). Hooks run
  // unconditionally; a non-loopback/no-screen surface just yields null.
  const port = chrome ? loopbackPort(chrome.url) : null;
  const devServer = useDevServerMatch(port);

  // With a dev-server chip in front, the chip already shows host:port, so the
  // URL collapses to just the path; otherwise it's the full host+path.
  const urlText = chrome ? (devServer ? pathDisplay(chrome.url) : chrome.displayUrl) : '';

  // Clicking the URL opens an inline editor (like renaming a terminal tab) to
  // navigate elsewhere. While it's open we flag dialog-keyboard so the Wall's
  // keyboard handler stands down (the panel's own key-forwarder skips editable
  // targets); the editor closes itself when the surface stops being a browser.
  const setDialogKeyboardActive = useContext(DialogKeyboardContext);
  const [editingUrl, setEditingUrl] = useState(false);
  useEffect(() => {
    if (!editingUrl) return;
    setDialogKeyboardActive(true);
    return () => setDialogKeyboardActive(false);
  }, [editingUrl, setDialogKeyboardActive]);
  useEffect(() => {
    if (!screen && editingUrl) setEditingUrl(false);
  }, [screen, editingUrl]);

  const submitUrl = (value: string) => {
    const url = normalizeNavUrl(value);
    if (url) screen?.chromeActions.navigate(url);
    setEditingUrl(false);
  };
  const closeUrlEditor = () => setEditingUrl(false);

  return (
    <div
      className={`flex h-full w-full cursor-grab items-center gap-1.5 ${TERMINAL_TOP_RADIUS_CLASS} pl-2 pr-[5px] text-sm leading-none font-mono select-none active:cursor-grabbing ${HEADER_PALETTE_TRANSITION_CLASS} ${isActiveHeader ? 'bg-header-active-bg text-header-active-fg' : 'bg-header-inactive-bg text-header-inactive-fg'}`}
      onMouseDown={() => actions.onClickPanel(id)}
    >
      {screen && screenSnapshot && chrome ? (
        <>
          {/* Render/screen chip → far left, out of the way of the nav controls.
              Opens the Display modal; the glyph reflects reality — frame =
              embed, and robot + presentation = agent-visible browser. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); screen.actions.openModal(); }}
            aria-label={displayLabel}
            title={displayLabel}
            data-browser-display-trigger="true"
            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-current/10"
          >
            {displayMode && <BrowserDisplayIcon mode={displayMode} size={14} />}
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

          {/* --key indicator for non-default keys only — the key name inline,
              small + quiet (hover reveals `--key <name>`), never a prefix on the
              persisted title. Raw --session surfaces show none. */}
          {chrome.key && chrome.key !== 'default' && (
            <span
              className="shrink-0 text-xs text-current/70"
              title={`--key ${chrome.key}`}
            >{chrome.key}</span>
          )}

          {editingUrl ? (
            /* Inline URL editor (like renaming a terminal tab): pre-filled with
               the full URL + all selected, Enter navigates, Escape/blur cancels
               (browser-omnibox style). Fills the URL+chip+spacer span. */
            <InlineEditInput
              data-url-input-for={id}
              className="min-w-0 flex-1 border-none bg-transparent p-0 font-medium text-inherit outline-none"
              initialValue={chrome.url}
              blurAction="cancel"
              onSubmit={submitUrl}
              onCancel={closeUrlEditor}
            />
          ) : (
            <>
              {/* Dev-server connection chip — in front of the URL when the port
                  maps to a single pane; click focuses that terminal. The full
                  command shows by default (no fixed cap); it only truncates
                  after the URL path has, since the URL shrinks far faster.
                  Absent ⇒ no chip + full host+path. */}
              {devServer && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); actions.onFocusPane(devServer.paneId); }}
                  aria-label={`Focus ${devServer.label} — serves this localhost port`}
                  title={`localhost served by ${devServer.label}${port != null ? ` (:${port})` : ''} — click to focus`}
                  className="flex h-5 min-w-0 items-center gap-1 rounded px-1.5 text-xs transition-colors hover:bg-current/10"
                >
                  <span className="min-w-0 truncate">{devServer.label}</span>
                  {port != null && <span className="shrink-0 text-current/70">:{port}</span>}
                </button>
              )}

              {/* URL is the path only when a chip fronts it (domain is in the
                  chip), else the full host+path. Click to edit/navigate; HTML
                  <title> / full URL → tooltip. Gives up width (shrink-[10]) long
                  before the command does. */}
              <span
                className="min-w-0 shrink-[10] cursor-text truncate font-medium underline-offset-2 hover:underline"
                title={chrome.title ?? chrome.url ?? undefined}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setEditingUrl(true); }}
              >{urlText || title || id}</span>

              {/* Flexible spacer keeps the layout buttons right-aligned. */}
              <div className="min-w-0 flex-1" />
            </>
          )}
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium">{title ?? id}</span>
      )}

      <div className="ml-1 hidden shrink-0 items-center gap-0.5 min-[420px]:flex">
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onSplitH(id); }}
          ariaLabel="Split left/right"
          tooltip="Split left/right [|] or [%]"
        ><SplitHorizontalIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onSplitV(id); }}
          ariaLabel="Split top/bottom"
          tooltip={'Split top/bottom [-] or ["]'}
        ><SplitVerticalIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className={paneZoomButtonClass(zoomed, isActiveHeader)}
          onClick={(e) => { e.stopPropagation(); actions.onZoom(id); }}
          ariaLabel={zoomed ? 'Unzoom' : 'Zoom'}
          tooltip={zoomed ? 'Unzoom' : 'Zoom [z]'}
        >{zoomed ? <ArrowsInIcon size={14} /> : <ArrowsOutIcon size={14} />}</HeaderActionButton>
      </div>
      <div className="ml-1 flex shrink-0 items-center gap-0.5">
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onMinimize(id); }}
          ariaLabel="Minimize"
          tooltip="Minimize [m] or [d]"
        ><ArrowLineDownIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-error/10 hover:text-error"
          onClick={(e) => { e.stopPropagation(); actions.onKill(id); }}
          ariaLabel="Kill"
          tooltip="Kill [k] or [x]"
        ><XIcon size={14} /></HeaderActionButton>
      </div>
    </div>
  );
}
