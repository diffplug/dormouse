import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { POPOVER_FOCUSABLE_SELECTOR, usePopoverFocusTrap } from '../use-popover-focus-trap';
import { useDismissOverlay } from './use-dismiss-overlay';
import { useHeaderTier } from './use-header-tier';
import { useSurfaceVisibility } from './use-surface-visibility';
import { noteCountPhrase, useNoteCount } from '../use-notepad';
import { clampOverlayPosition, OVERLAY_VIEWPORT_MARGIN_PX } from '../../lib/ui-geometry';
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
import { HeaderActionButton } from '../HeaderActionButton';
import { chromeButton, HEADER_PALETTE_TRANSITION_CLASS, OVERLAY_MAX_HEIGHT, POPUP_SURFACE_CLASS, paneZoomButtonClass, TERMINAL_TOP_RADIUS_CLASS } from '../design';
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

/** What the browser chrome shows inline at a header width (`docs/specs/layout.md`
 *  → "Pane header responsive sizing"). Below `minimal` the chrome moves into the
 *  popover, where it renders at `full`. */
type BrowserInlineTier = 'full' | 'compact' | 'minimal';
type BrowserHeaderTier = BrowserInlineTier | 'overflow' | 'tiny';
const browserHeaderTier = (width: number): BrowserHeaderTier =>
  width >= 420 ? 'full' : width >= 360 ? 'compact' : width >= 180 ? 'minimal' : width >= 72 ? 'overflow' : 'tiny';

export function SurfacePaneHeader({ id, title, parked }: PaneProps) {
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
  useDialogKeyboardOwner(editingUrl);
  useEffect(() => {
    if (!screen && editingUrl) setEditingUrl(false);
  }, [screen, editingUrl]);

  const submitUrl = (value: string) => {
    const url = normalizeNavUrl(value);
    if (url) screen?.chromeActions.navigate(url);
    setEditingUrl(false);
  };
  const closeUrlEditor = () => setEditingUrl(false);

  // Below the `minimal` tier the chrome lives in a popover behind one trigger;
  // a pane resize or a hidden Surface closes it, the latter without pulling
  // focus back to a trigger nobody can see. `closeMenu` stays identity-stable
  // (reading `visibleRef`) so the popover's listeners subscribe once.
  const headerRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback((restoreFocus = true) => {
    setMenuOpen(false);
    setEditingUrl(false);
    if (restoreFocus && visibleRef.current) overflowRef.current?.focus();
  }, []);
  const tier = useHeaderTier(headerRef, browserHeaderTier, { onResize: () => closeMenu(false) });
  const inline: BrowserInlineTier | null = tier === 'overflow' || tier === 'tiny' ? null : tier;
  const popoverOpen = visible && inline === null && menuOpen;
  const noteCount = useNoteCount(id);
  const overflowLabel = `Browser controls${noteCount ? `, ${noteCountPhrase(noteCount)}` : ''}`;
  useEffect(() => {
    if (!visible) closeMenu(false);
  }, [visible, closeMenu]);

  const renderBrowserControls = (placement: BrowserInlineTier | 'popover') => (
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
          {placement !== 'minimal' && <div className="flex shrink-0 items-center gap-0.5">
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
                className={`${placement === 'popover' ? 'basis-full' : ''} min-w-0 shrink-[10] cursor-text truncate font-medium underline-offset-2 hover:underline`}
                title={chrome.title ?? chrome.url ?? undefined}
                onMouseDown={(e) => e.stopPropagation()}
                role="button"
                tabIndex={0}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEditingUrl(true); } }}
                onClick={(e) => { e.stopPropagation(); setEditingUrl(true); }}
              >{urlText || title || id}</span>

              {/* Flexible spacer keeps the layout buttons right-aligned. */}
              {placement !== 'popover' && <div className="min-w-0 flex-1" />}
            </>
          )}
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium">{title ?? id}</span>
      )}

      <NotepadHeaderButton surfaceId={id} />
      {(placement === 'popover' || placement === 'full') && <div className="ml-1 flex shrink-0 items-center gap-0.5">
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
      className={`flex h-full min-w-0 flex-1 cursor-grab items-center ${inline ? 'gap-1.5 pl-2 pr-[5px]' : 'gap-0.5 px-1'} ${TERMINAL_TOP_RADIUS_CLASS} text-sm leading-none font-mono select-none active:cursor-grabbing ${HEADER_PALETTE_TRANSITION_CLASS} ${isActiveHeader ? 'bg-header-active-bg text-header-active-fg' : 'bg-header-inactive-bg text-header-inactive-fg'}`}
      onMouseDown={() => actions.onClickPanel(id)}
    >
      {inline ? renderBrowserControls(inline) : (
        <button ref={overflowRef} type="button" aria-label={overflowLabel}
          aria-haspopup="dialog" aria-expanded={popoverOpen}
          title={overflowLabel}
          className={`${chromeButton()} shrink-0`}
          /* A press on the trigger toggles; it must not dismiss first and then reopen. */
          onPointerDown={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); if (menuOpen) closeMenu(); else setMenuOpen(true); }}>
          {noteCount ? <NotepadIcon size={14} weight="fill" /> : <DotsThreeIcon size={14} />}
        </button>
      )}
      {tier !== 'tiny' && paneActions}
      {popoverOpen && <BrowserHeaderPopover anchorRef={overflowRef} onClose={closeMenu}>
        {renderBrowserControls('popover')}
        {tier === 'tiny' && paneActions}
      </BrowserHeaderPopover>}
    </div>
  );
}

/** Gap between the trigger's bottom edge and the popover. */
const POPOVER_GAP_PX = 4;

function BrowserHeaderPopover({ anchorRef, onClose, children }: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed' });
  useDialogKeyboardOwner(true);
  usePopoverFocusTrap(ref, onClose);
  useDismissOverlay(onClose, ref);
  useLayoutEffect(() => {
    const element = ref.current!;
    const positionPopover = () => {
      const anchor = anchorRef.current!.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      setPosition(clampOverlayPosition({ left: anchor.left, top: anchor.bottom + POPOVER_GAP_PX, width: rect.width, height: rect.height }));
    };
    positionPopover();
    const observer = new ResizeObserver(positionPopover);
    observer.observe(element, { box: 'border-box' });
    // Content resizing (URL editing, notes, or connection labels) changes only
    // geometry. Moving focus again would cancel the URL editor on its blur.
    element.querySelector<HTMLElement>(POPOVER_FOCUSABLE_SELECTOR)?.focus();
    return () => observer.disconnect();
  }, [anchorRef]);
  return createPortal(
    <div ref={ref} role="dialog" aria-label="Browser controls"
      style={{ ...position, maxWidth: `calc(100vw - ${OVERLAY_VIEWPORT_MARGIN_PX * 2}px)` }}
      className={`${POPUP_SURFACE_CLASS} ${OVERLAY_MAX_HEIGHT.popover} flex w-80 flex-wrap items-center gap-2 overflow-auto p-2 text-sm`}
      /* Presses inside survive the dismissal contract and never start a pane drag. */
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClickCapture={event => {
        // Only real buttons dismiss: the URL is a `role="button"` span whose
        // click opens the editor here, inside the popover.
        if (!(event.target as Element).closest('button')) return;
        // Native clicks can drain microtasks between capture and bubble. Wait
        // a task so the action runs before its target unmounts; a new modal
        // keeps any focus it acquired in the action handler.
        setTimeout(() => {
          const focusStillOurs = document.activeElement === document.body || !!ref.current?.contains(document.activeElement);
          onClose(focusStillOurs);
        }, 0);
      }}>
      {children}
    </div>, document.body,
  );
}
