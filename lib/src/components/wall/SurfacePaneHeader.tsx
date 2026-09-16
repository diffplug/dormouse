import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverFocusTrap } from '../use-popover-focus-trap';
import { useSurfaceVisibility } from './use-surface-visibility';
import { useNoteCount } from '../use-notepad';
import { clampOverlayPosition } from '../../lib/ui-geometry';
import {
  DotsThreeIcon,
  NotepadIcon,
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
import { ToolDirtyIndicator, useToolDirty } from '../ToolDirtyIndicator';
import { HeaderActionButton } from '../HeaderActionButton';
import { HEADER_PALETTE_TRANSITION_CLASS, POPUP_SURFACE_CLASS, paneZoomButtonClass, TERMINAL_TOP_RADIUS_CLASS } from '../design';
import { NotepadHeaderButton } from './NotepadHeaderButton';
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
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedIdContext,
  useDialogKeyboardOwner,
} from './wall-context';

export function SurfacePaneHeader({ id, title, params, parked }: PaneProps) {
  const dirty = useToolDirty(id, params);
  const visible = useSurfaceVisibility(parked);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
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
  const [editingUrl, setEditingUrl] = useState(false);
  useDialogKeyboardOwner(editingUrl && visible);
  useEffect(() => {
    if (!screen && editingUrl) setEditingUrl(false);
  }, [screen, editingUrl]);

  const submitUrl = (value: string) => {
    const url = normalizeNavUrl(value);
    if (url) screen?.chromeActions.navigate(url);
    setEditingUrl(false);
  };
  const closeUrlEditor = () => setEditingUrl(false);

  const headerRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  const compact = width < 180;
  // A dirty dot and its compact gap take 8px beside the persistent controls.
  const inlinePaneActions = width >= 72 + (dirty ? 8 : 0);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const noteCount = useNoteCount(id);
  const overflowLabel = `Browser controls${noteCount ? `, ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : ''}`;
  const closeMenu = useCallback((restoreFocus = true) => { setMenuAnchor(null); setEditingUrl(false); if (restoreFocus && visibleRef.current) overflowRef.current?.focus(); }, []);
  useEffect(() => {
    if (!visible) closeMenu(false);
  }, [visible, closeMenu]);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const initialWidth = header.getBoundingClientRect().width;
    if (initialWidth > 0) setWidth(initialWidth);
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
      setMenuAnchor(null);
      setEditingUrl(false);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const browserControls = (
    <>
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
          {(compact || width >= 360) && <div className="flex shrink-0 items-center gap-0.5">
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
          </div>}

          {/* --key indicator for non-default keys only — the key name inline,
              small + quiet (hover reveals `--key <name>`), never a prefix on the
              persisted title. Raw --session surfaces show none. */}
          {chrome.key && chrome.key !== 'default' && (
            <span
              className="min-w-0 max-w-16 truncate text-xs text-current/70"
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
                  {port != null && <span className="min-w-0 truncate text-current/70">:{port}</span>}
                </button>
              )}

              {/* URL is the path only when a chip fronts it (domain is in the
                  chip), else the full host+path. Click to edit/navigate; HTML
                  <title> / full URL → tooltip. Gives up width (shrink-[10]) long
                  before the command does. */}
              <span
                className={`${compact ? 'basis-full' : ''} min-w-0 shrink-[10] cursor-text truncate font-medium underline-offset-2 hover:underline`}
                title={chrome.title ?? chrome.url ?? undefined}
                onMouseDown={(e) => e.stopPropagation()}
                role="button"
                tabIndex={0}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEditingUrl(true); } }}
                onClick={(e) => { e.stopPropagation(); setEditingUrl(true); }}
              >{urlText || title || id}</span>

              {/* Flexible spacer keeps the layout buttons right-aligned. */}
              {!compact && <div className="min-w-0 flex-1" />}
            </>
          )}
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium">{title ?? id}</span>
      )}

      <NotepadHeaderButton surfaceId={id} />
      {(compact || width >= 420) && <div className="ml-1 flex shrink-0 items-center gap-0.5">
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
      </div>}
    </>
  );

  const paneActions = (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <HeaderActionButton
        className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
        onClick={(e) => { e.stopPropagation(); closeMenu(); actions.onMinimize(id); }}
        ariaLabel="Minimize"
        tooltip="Minimize [m] or [d]"
      ><ArrowLineDownIcon size={14} /></HeaderActionButton>
      <HeaderActionButton
        className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-error/10 hover:text-error"
        onClick={(e) => { e.stopPropagation(); closeMenu(); actions.onKill(id); }}
        ariaLabel="Kill"
        tooltip="Kill [k] or [x]"
      ><XIcon size={14} /></HeaderActionButton>
    </div>
  );

  return (
    <div
      ref={headerRef}
      className={`flex h-full min-w-0 flex-1 cursor-grab items-center ${compact ? 'gap-0.5 px-1' : 'gap-1.5 pl-2 pr-[5px]'} ${TERMINAL_TOP_RADIUS_CLASS} text-sm leading-none font-mono select-none active:cursor-grabbing ${HEADER_PALETTE_TRANSITION_CLASS} ${isActiveHeader ? 'bg-header-active-bg text-header-active-fg' : 'bg-header-inactive-bg text-header-inactive-fg'}`}
      onMouseDown={() => actions.onClickPanel(id)}
    >
      <ToolDirtyIndicator dirty={dirty} />
      {compact ? (
        <button ref={overflowRef} type="button" aria-label={overflowLabel}
          aria-haspopup="dialog" aria-expanded={visible && menuAnchor !== null}
          title={overflowLabel}
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded hover:bg-current/10"
          onMouseDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); if (menuAnchor) closeMenu(); else setMenuAnchor(event.currentTarget.getBoundingClientRect()); }}>
          {noteCount ? <NotepadIcon size={14} weight="fill" /> : <DotsThreeIcon size={14} />}
        </button>
      ) : browserControls}
      {inlinePaneActions && paneActions}
      {visible && compact && menuAnchor && <BrowserHeaderPopover anchor={menuAnchor} onClose={closeMenu}>
        {browserControls}
        {!inlinePaneActions && paneActions}
      </BrowserHeaderPopover>}
    </div>
  );
}

function BrowserHeaderPopover({ anchor, onClose, children }: { anchor: DOMRect; onClose: (restoreFocus?: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', left: anchor.left, top: anchor.bottom });
  useDialogKeyboardOwner(true);
  usePopoverFocusTrap(ref, onClose);
  useEffect(() => {
    const resized = () => onClose();
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, [onClose]);
  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    setPosition(clampOverlayPosition({ left: anchor.left, top: anchor.bottom + 4, width: rect.width, height: rect.height }));
    ref.current!.querySelector<HTMLElement>('button, [tabindex="0"]')?.focus();
  }, [anchor]);
  return createPortal(
    <div ref={ref} role="dialog" aria-label="Browser controls" style={position}
      className={`${POPUP_SURFACE_CLASS} flex max-h-[75dvh] w-80 max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 overflow-auto p-2 text-sm`}
      onMouseDown={event => event.stopPropagation()}
      onClickCapture={event => {
        if (!(event.target as Element).closest('button')) return;
        // Native clicks can drain microtasks between capture and bubble. Wait
        // a task so the action runs before its target unmounts; a new modal
        // keeps any focus it acquired in the action handler.
        setTimeout(() => onClose(document.activeElement === document.body || !!ref.current?.contains(document.activeElement)), 0);
      }}>
      {children}
    </div>, document.body,
  );
}
