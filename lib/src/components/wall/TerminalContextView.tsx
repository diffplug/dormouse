import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DependencyList, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ArrowCounterClockwiseIcon, ArrowLineUpIcon, ArrowSquareOutIcon, BellIcon, BugBeetleIcon, CaretDownIcon, CheckIcon, CircleNotchIcon, CopyIcon, FolderSimpleIcon, PauseIcon, PlugIcon, PushPinIcon, SlidersHorizontalIcon, TerminalIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import { ELEVATED_PANE_SHADOW, OnOffSwitch, POPUP_SURFACE_CLASS, SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS, SUBTLE_ACTION_REST_COLOR_CLASS, SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS, TERMINAL_CONTEXT_SURFACE_CLASS, TERMINAL_CONTEXT_EXIT_MS, TERMINAL_CONTEXT_TEETH_PX, TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import { stepFocus } from '../focus-step';
import { renderModeFor, type BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import { AgentRobotIcon, BROWSER_DISPLAY_LABEL, BrowserDisplayIcon } from './BrowserDisplayIcon';
import { BROWSER_PROVIDER_GUI } from './browser-automation';
import { browserProviderSwitch, rememberBrowserProvider, useBrowserProvider } from './BrowserProviderSwitch';
import type { PortUrlEntry } from './port-url';
import { displayModeFor, type RenderMode } from './agent-browser-screen';
import type { HelperStatus } from '../../lib/helper-terminal';
import { WindowFocusedContext } from './wall-context';
import { motionIsInstant } from '../../lib/ui-geometry';
import { oppositeEdge } from '../../lib/lath/model';
import type { ContextPlacement, ContextSide } from './terminal-context-placement';
import { messageOf } from '../../lib/errors';
import { anchoredTarget, isComposingKey } from '../../lib/dom';

export type PortMode = 'system' | RenderMode;
export type ContextScan = { status: 'scanning' | 'failed' } | { status: 'loaded'; entries: PortUrlEntry[] };
/** Every action may fail asynchronously; the view reports the failure. */
type Action = () => void | Promise<void>;
const SPINNING = <CircleNotchIcon size={13} className="shrink-0 animate-spin" />;
const PAUSED = <PauseIcon size={13} className="shrink-0" />;
const SETTLED = <CheckIcon size={13} className="shrink-0" />;
/** One row per helper state (docs/specs/terminal-context.md → Helper lifecycle);
 *  a `reset` state offers Reset in place of Modify. */
const HELPER_STATUS: Record<HelperStatus, { icon: ReactNode; label: (command: string) => string; reset?: boolean }> = {
  waiting: { icon: SPINNING, label: () => 'Waiting for shell…' },
  running: { icon: SPINNING, label: command => `Running ${command}…` },
  completed: { icon: SETTLED, label: command => `${command} autoran` },
  preserved: { icon: PAUSED, label: () => 'Skipping autorun to preserve user keystrokes', reset: true },
  off: { icon: PAUSED, label: () => 'Autorun off' },
  unsupported: { icon: PAUSED, label: () => 'Autorun skipped: shell readiness unavailable' },
  exited: { icon: SETTLED, label: () => 'Helper exited', reset: true },
};

/** A port row entry: a launch target, or (`mode: null`) the provider switch. */
type PortAction = { mode: PortMode | null; label: string; text: string; icon: ReactNode; disabled: boolean };

/** The launch targets for `provider`, drawn and named as the Display modal draws and names them. */
function portActions(provider: BrowserAutomationProvider, providers: readonly BrowserAutomationProvider[], canIframe: boolean): PortAction[] {
  const { label } = BROWSER_PROVIDER_GUI[provider];
  const automated = providers.includes(provider) ? null : `${label} unavailable on this host`;
  const popout = displayModeFor(provider, 'popout');
  const targets: { mode: PortMode; icon: ReactNode; text: string; unavailable: string | null }[] = [
    { mode: 'system', icon: <ArrowSquareOutIcon size={15} />, text: 'system browser', unavailable: null },
    { mode: 'iframe', icon: <BrowserDisplayIcon mode="iframe" size={15} />, text: BROWSER_DISPLAY_LABEL.iframe, unavailable: canIframe ? null : 'Iframe unavailable on this host' },
    { mode: renderModeFor(provider, 'screencast'), icon: <AgentRobotIcon size={15} />, text: `${label} screencast`, unavailable: automated },
    { mode: renderModeFor(provider, 'popout'), icon: <BrowserDisplayIcon mode={popout} size={15} />, text: BROWSER_DISPLAY_LABEL[popout], unavailable: automated },
  ];
  return targets.map(({ unavailable, ...target }) => ({ ...target, label: unavailable ?? `Open in ${target.text}`, disabled: !!unavailable }));
}

const DETAILS = {
  title: { label: 'Title sources', heading: 'Why this title?' },
  modify: { label: 'Default helper autorun command', heading: 'Default helper autorun command' },
  reset: { label: 'Reset helper terminal', heading: 'Reset helper terminal?' },
} as const;
type Detail = keyof typeof DETAILS;
export interface TerminalContextViewProps {
  terminalRole?: 'helper' | 'tool';
  placement?: Omit<ContextPlacement, 'rect'> & { onChange(side: ContextSide): void };
  /** Exit in progress: the view is inert, and `onClose` is not called again. */
  closing?: boolean;
  /** Viewport coordinates the reveal grows from; absent, the top-left corner. */
  origin?: { x: number; y: number };
  defaultCommand?: string; surfaceId: string; cwd: string; helperCwd?: string; mismatch?: boolean;
  workspaceMove?: ReactNode;
  titleSources: { source: string; value: string; note?: string }[];
  scan: ContextScan; watchRule?: string | null; watching: boolean; todo: boolean;
  notification?: { title: string | null; body: string | null } | null;
  status: HelperStatus; command: string; warning?: string;
  /** The providers this host can launch a browser with. */
  browserProviders: readonly BrowserAutomationProvider[];
  explorerLabel: string; canExplore: boolean; canIframe: boolean;
  children: ReactNode;
  onClose(): void; onCopyId: Action; onCopyPath: Action; onExplore: Action;
  onWatch(): void; onTodo(): void; onPort(entry: PortUrlEntry, mode: PortMode): void | Promise<void>;
  onModify(command: string): Promise<void>; onReset: Action; onPromote: Action;
  /** Whether Reset asks first; under Labs it makes the old helper a pending kill instead. Default true. */
  resetAsks?: boolean;
  /** Present only while the source is a preview slot: keep it open. */
  onKeepPreview?(): void;
  initialDetail?: Detail | null;
}

/** A context action's box, shared with the port row's off-screen measurements. */
export const ACTION_BOX_CLASS = 'inline-flex h-6 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded px-1.5';

export function ContextAction({ children, label, onClick, disabled = false, busy = false, muted = false, pressed, keepFocus = false }: { children: ReactNode; label: string; onClick?: () => void; disabled?: boolean; busy?: boolean; muted?: boolean; pressed?: boolean; keepFocus?: boolean }) {
  const windowFocused = useContext(WindowFocusedContext);
  // Native app launches can leave :hover stale until this window regains focus.
  const color = muted ? 'text-muted' : windowFocused ? SUBTLE_ACTION_COLOR_CLASS : SUBTLE_ACTION_REST_COLOR_CLASS;
  // `busy` must never reach native `disabled`: the browser blurs a button the moment it is disabled,
  // and this context's Escape and Tab handling both live on the <section> and need a focused descendant.
  return <button type="button" title={label} aria-label={label} aria-busy={busy || undefined} aria-disabled={busy || undefined} disabled={disabled} onClick={busy ? undefined : onClick}
    aria-pressed={pressed} onPointerDown={keepFocus ? event => event.preventDefault() : undefined}
    className={`${ACTION_BOX_CLASS} disabled:opacity-40 aria-pressed:bg-current/10 ${windowFocused ? SUBTLE_ACTION_INTERACTION_CLASS : ''} ${color}`}>{children}</button>;
}

/** Visible action text is lowercase, since `iframe` and `agent-browser` cannot be
 *  capitalized; tooltips, accessible names, and proper nouns such as Finder keep
 *  their case. */
const actionText = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

const COPIED = <><CheckIcon size={14} weight="bold" />copied</>;

/** `confirmation` replaces the face on a successful copy; an unlabeled button confirms with the check alone. */
function ContextCopyAction({ children, label, onCopy, confirmation = COPIED }: { children: ReactNode; label: string; onCopy: () => Promise<boolean>; confirmation?: ReactNode }) {
  const [confirmed, setConfirmed] = useState(0);
  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(() => setConfirmed(0), 1400);
    return () => clearTimeout(timer);
  }, [confirmed]);
  return <ContextAction label={label} onClick={() => {
    setConfirmed(0);
    void onCopy().then(success => { if (success) setConfirmed(value => value + 1); });
  }}>
    <ActionFace status={confirmed ? confirmation : null}>{children}</ActionFace>
  </ContextAction>;
}

/** `children`, covered by `status` while it is set without giving up their width. */
function ActionFace({ status, children }: { status: ReactNode; children: ReactNode }) {
  return <span className="grid">
    <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 ${status ? 'invisible' : ''}`}>{children}</span>
    <span role="status" className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">{status}</span>
  </span>;
}

const SPINNER = <CircleNotchIcon size={15} className="animate-spin motion-reduce:animate-none" />;
const OPENING = <>{SPINNER}opening…</>;

/** Drag-selectable diagnostic text. A press focuses it, so Cmd/Ctrl+C reaches
 *  `handleContextCopy` rather than the helper terminal. */
function ContextDiagnostic({ className, style, children }: { className: string; style?: CSSProperties; children: ReactNode }) {
  return <div role="alert" data-context-diagnostic tabIndex={-1} onPointerDown={event => event.currentTarget.focus({ preventScroll: true })}
    style={style} className={`select-text cursor-text outline-none ${className}`}>{children}</div>;
}

/** `compact`: the button shows only its icon, so opening shows only the spinner. */
function ContextOpenAction({ children, label, disabled, compact = false, onOpen }: { children: ReactNode; label: string; disabled: boolean; compact?: boolean; onOpen: () => Promise<boolean> }) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const opening = pending || feedback;
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(false), 750);
    return () => clearTimeout(timer);
  }, [feedback]);
  return <ContextAction label={label} disabled={disabled} busy={opening} onClick={() => {
    setPending(true);
    setFeedback(true);
    void onOpen().then(success => { setPending(false); if (!success) setFeedback(false); });
  }}>
    <ActionFace status={opening ? compact ? SPINNER : OPENING : null}>{children}</ActionFace>
  </ContextAction>;
}

const MEASURER_CLASS = 'pointer-events-none invisible absolute inset-x-0 top-0 flex h-0 overflow-hidden';

/** Runs `fit` with `row`'s width, its column gap, and the widths of `measurer`'s
 *  children: now, on `deps`, and whenever either resizes, or any element in
 *  `alsoObserve` whose width `fit` reads. A hidden row reports nothing. */
function useRowFit(row: RefObject<HTMLElement | null>, measurer: RefObject<HTMLElement | null>, fit: (width: number, gap: number, widths: number[]) => void, deps: DependencyList, alsoObserve: readonly RefObject<HTMLElement | null>[] = []) {
  useLayoutEffect(() => {
    const element = row.current;
    const hidden = measurer.current;
    if (!element || !hidden) return;
    const measure = () => {
      const width = element.clientWidth;
      if (width) fit(width, parseFloat(getComputedStyle(element).columnGap) || 0, Array.from(hidden.children, child => (child as HTMLElement).offsetWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of hidden.children) observer.observe(child);
    for (const extra of alsoObserve) if (extra.current) observer.observe(extra.current);
    return () => observer.disconnect();
  }, deps);
}

const COPY_ICON = <CopyIcon size={12} />;
const COPY_CHECK = <CheckIcon size={12} weight="bold" />;
const EXPLORE_ICON = <ArrowSquareOutIcon size={15} />;
const EXPLAIN_ICON = <BugBeetleIcon size={15} />;
const EXPLAIN_TEXT = 'debug title';
/** Muted marks leading the directory and port rows in place of a label column. */
const FOLDER_ICON = <FolderSimpleIcon size={14} className="shrink-0 text-muted" />;
const PORT_ICON = <PlugIcon size={14} className="shrink-0 text-muted" />;
const BELL_ICON = <BellIcon size={14} className="shrink-0 text-muted" />;

/** The copyable Surface id, the title explanation, the workspace move, then `actions`. */
function HeaderRow({ surfaceId, onExplain, onCopyId, actions, workspaceMove }: {
  surfaceId: string; actions: ReactNode; workspaceMove?: ReactNode;
  onExplain(): void; onCopyId(): Promise<boolean>;
}) {
  const row = useRef<HTMLDivElement>(null);
  const measures = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState<0 | 1 | 2>(0);
  // The explanation drops its label, then the id drops to its icon; the workspace move wraps.
  useRowFit(row, measures, (width, gap, [idBox, explain, explainIcon]) => {
    const room = width - (actionsRef.current?.offsetWidth ?? 0) - 2 * gap;
    setCompact(idBox + explain + gap <= room ? 0 : idBox + explainIcon + gap <= room ? 1 : 2);
  }, [surfaceId], [actionsRef]);
  return <div ref={row} data-context-title className="relative flex min-h-7 min-w-0 items-center gap-1">
    <div ref={measures} aria-hidden="true" inert className={MEASURER_CLASS}>
      <span className={ACTION_BOX_CLASS}>{surfaceId}{COPY_ICON}</span>
      <span className={ACTION_BOX_CLASS}>{EXPLAIN_ICON}{EXPLAIN_TEXT}</span>
      <span className={ACTION_BOX_CLASS}>{EXPLAIN_ICON}</span>
    </div>
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1">
      <ContextCopyAction label={`Copy ${surfaceId}`} confirmation={compact === 2 ? COPY_CHECK : undefined} onCopy={onCopyId}>{compact < 2 && <span>{surfaceId}</span>}{COPY_ICON}</ContextCopyAction>
      <ContextAction label="Explain this title" onClick={onExplain}>{EXPLAIN_ICON}{compact === 0 && EXPLAIN_TEXT}</ContextAction>
      {workspaceMove}
    </div>
    <div ref={actionsRef} data-context-header-actions className="flex shrink-0 items-center gap-0.5 self-start">{actions}</div>
  </div>;
}

/** The directory, its unlabeled copy, and the explorer action on one line. */
function DirRow({ cwd, explorerLabel, canExplore, onExplore, onCopyPath }: {
  cwd: string; explorerLabel: string; canExplore: boolean;
  onExplore(): Promise<boolean>; onCopyPath(): Promise<boolean>;
}) {
  const row = useRef<HTMLDivElement>(null);
  const measures = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const text = actionText(explorerLabel);
  // The explorer drops its label before the directory truncates.
  useRowFit(row, measures, (width, gap, [lead, path, copy, explorer]) => setCompact(lead + path + copy + explorer + 3 * gap > width), [cwd, text]);
  return <div ref={row} data-context-dir className="relative flex h-6 min-w-0 items-center gap-1">
    <div ref={measures} aria-hidden="true" inert className={MEASURER_CLASS}>
      <span className="inline-flex">{FOLDER_ICON}</span>
      <span className="whitespace-nowrap">{cwd}</span>
      <span className={ACTION_BOX_CLASS}>{COPY_ICON}</span>
      <span className={ACTION_BOX_CLASS}>{EXPLORE_ICON}{text}</span>
    </div>
    {FOLDER_ICON}
    {/* Right-to-left so truncation drops the start; the isolate keeps the path's own order. */}
    <span className="min-w-0 truncate [direction:rtl]" title={cwd}><bdi>{cwd}</bdi></span>
    <ContextCopyAction label="Copy absolute path" confirmation={COPY_CHECK} onCopy={onCopyPath}>{COPY_ICON}</ContextCopyAction>
    <ContextOpenAction label={canExplore ? explorerLabel : 'Directory unavailable on this host'} disabled={!canExplore} compact={compact} onOpen={onExplore}>{EXPLORE_ICON}{!compact && text}</ContextOpenAction>
  </div>;
}

const MORE = <span className="inline-flex items-center gap-1">more…<CaretDownIcon size={10} weight="fill" /></span>;
/** Keys that open, close, or leave a closed select. Chromium on Windows and Linux
 *  lets any other key change a closed select's value, which here would launch. */
const SELECT_PASSTHROUGH_KEYS = new Set(['Enter', ' ', 'Tab', 'Escape', 'F4']);
/** Only a choice from the open list commits; arrows open it instead. */
export function closedSelectKeyDown(event: KeyboardEvent<HTMLSelectElement>): void {
  if (SELECT_PASSTHROUGH_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    try { event.currentTarget.showPicker(); } catch { /* Space and Alt+↓ still open it */ }
  }
}

/** Measure natural action widths so overflow follows this row, not the window.
 * The native dropdown escapes the context's scroll/animation clipping and owns
 * keyboard navigation; its entries are exactly the actions missing from the row. */
function PortLaunchActions({ providers, canIframe, onPort }: {
  providers: readonly BrowserAutomationProvider[];
  canIframe: boolean;
  onPort(mode: PortMode): Promise<boolean>;
}) {
  const [provider, setProvider] = useBrowserProvider(providers);
  const offer = browserProviderSwitch(providers, provider);
  const actions: PortAction[] = [
    ...portActions(provider, providers, canIframe),
    ...(offer ? [{ mode: null, label: offer.label, text: offer.label, icon: null, disabled: false }] : []),
  ];
  const root = useRef<HTMLDivElement>(null);
  const measures = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(actions.length);
  // The row never squeezes below the trigger it falls back to; the port label truncates instead.
  const [floor, setFloor] = useState(0);
  const [pending, setPending] = useState<PortMode | null>(null);
  const windowFocused = useContext(WindowFocusedContext);
  const hiddenPending = pending !== null && actions.findIndex(action => action.mode === pending) >= visible;
  const labels = actions.map(action => action.text).join('|');
  // A pending action shows "opening…", so each action reserves at least that.
  useRowFit(root, measures, (width, gap, [rest, opening, ...faces]) => {
    const trigger = hiddenPending ? opening : rest;
    setFloor(trigger);
    const widths = faces.map(face => Math.max(face, opening));
    const total = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, widths.length - 1) * gap;
    if (total <= width) { setVisible(widths.length); return; }
    let used = trigger;
    let count = 0;
    for (const value of widths) {
      if (used + gap + value > width) break;
      used += gap + value;
      count++;
    }
    setVisible(count);
  }, [labels, hiddenPending]);
  const run = async ({ mode, disabled }: PortAction) => {
    if (pending !== null || disabled) return;
    if (!mode) {
      if (offer) { setProvider(offer.next); rememberBrowserProvider(offer.next); }
      return;
    }
    setPending(mode);
    try { await onPort(mode); } finally { setPending(null); }
  };
  const key = (action: PortAction) => action.mode ?? 'switch';
  return <div ref={root} data-port-actions className="relative flex flex-1 items-center gap-1" style={{ minWidth: floor }}>
    <div ref={measures} aria-hidden="true" inert className={MEASURER_CLASS}>
      {/* The trigger at rest and while opening, then each action's face. */}
      <span className={ACTION_BOX_CLASS}>{MORE}</span>
      <span className={ACTION_BOX_CLASS}>{OPENING}</span>
      {actions.map(action => <span key={key(action)} className={ACTION_BOX_CLASS}>{action.icon}{action.text}</span>)}
    </div>
    {actions.slice(0, visible).map(action => {
      const opening = pending !== null && pending === action.mode;
      return <ContextAction key={key(action)} label={action.label} disabled={action.disabled} busy={opening} onClick={() => void run(action)}>
        <ActionFace status={opening ? OPENING : null}>{action.icon}{action.text}</ActionFace>
      </ContextAction>;
    })}
    {/* A transparent native select over a link-styled label, like the other actions. */}
    {visible < actions.length && <span className={`relative overflow-hidden ${ACTION_BOX_CLASS} ${SUBTLE_ACTION_REST_COLOR_CLASS} ${windowFocused && pending === null ? SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS : ''}`}>
      {hiddenPending ? OPENING : MORE}
      <select aria-label="More browser actions" title="More browser actions" value="" aria-busy={pending !== null || undefined} aria-disabled={pending !== null || undefined}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
        onKeyDown={closedSelectKeyDown}
        onChange={event => { const action = actions.find(item => key(item) === event.target.value); if (action) void run(action); }}>
        <option value="">More browser actions</option>
        {actions.slice(visible).map(action => <option key={key(action)} value={key(action)} disabled={action.disabled}>{action.disabled ? action.label : action.text}</option>)}
      </select>
    </span>}
  </div>;
}

/** The supplied Phosphor panel glyph, mirrored so its filled panel marks `side`. */
function PlacementIcon({ side }: { side: ContextSide }) {
  return <svg aria-hidden width="18" height="18" viewBox="0 0 256 256" fill="currentColor">
    <g transform={side === 'bottom' ? 'translate(0 256) scale(1 -1)' : side === 'left' ? 'translate(256 0) scale(-1 1)' : undefined}>
      <rect x="32" y="48" width="192" height="160" rx="8" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />
      {side === 'left' || side === 'right'
        ? <rect x="120" y="72" width="80" height="112" rx="8" />
        : <rect x="56" y="72" width="144" height="64" rx="8" />}
    </g>
  </svg>;
}

/** The custom properties `.terminal-context-enter` / `-exit` read (`lib/src/theme.css`)
 *  that JS owns: the exit length the removal timer must match, and the corner radius. */
const SURFACE_STYLE = { '--context-exit-duration': `${TERMINAL_CONTEXT_EXIT_MS}ms`, '--context-radius': TERMINAL_SELECTION_BORDER_RADIUS } as CSSProperties;

const SIDE_NAME: Record<ContextSide, 'Left' | 'Right' | 'Top' | 'Bottom'> = { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };
/** Past `ELEVATED_PANE_SHADOW`'s reach, so the teeth's clip keeps the halo on the other three sides. */
const HALO_PX = 16;
const DEPTH = TERMINAL_CONTEXT_TEETH_PX;
/** The teeth's outline strip: `DEPTH` thick along `edge`. */
const stripStyle = (edge: ContextSide): CSSProperties => edge === 'left' || edge === 'right'
  ? { [edge]: 0, top: 0, width: DEPTH, height: '100%' } : { [edge]: 0, left: 0, width: '100%', height: DEPTH };

/** How many 90° teeth fit along an edge `length` long; the geometry below depends on nothing else. */
export const teethCount = (length: number) => Math.max(1, Math.round(length / (2 * DEPTH)));

/** `count` 90° teeth cut corner to corner along `edge`, tips on the panel's outer edge and
 *  valleys `TERMINAL_CONTEXT_TEETH_PX` inside it, relative to the box so a resize that keeps
 *  the count needs no recut. `clip` keeps the halo on the other three sides; `path` strokes
 *  the teeth, which the clip would cut in half, in a `DEPTH`-thick strip `viewBox` stretched
 *  along the edge. */
export function contextTeeth(edge: ContextSide, count: number): { clip: string; path: string; viewBox: string } {
  const vertical = edge === 'left' || edge === 'right';
  const near = edge === 'left' || edge === 'top';
  // Across: px in from the tips, or 'far' past the opposite side. Along: a fraction of the edge plus px.
  const across = (px: number | 'far') => px === 'far' ? (near ? `calc(100% + ${HALO_PX}px)` : `-${HALO_PX}px`) : near ? `${px}px` : `calc(100% - ${px}px)`;
  const along = (fraction: number, px = 0) => {
    const percent = `${+(fraction * 100).toFixed(4)}%`;
    return px ? `calc(${percent} ${px < 0 ? '-' : '+'} ${Math.abs(px)}px)` : percent;
  };
  const point = (a: string, b: string) => vertical ? `${a} ${b}` : `${b} ${a}`;
  const teeth: [number, number][] = [[DEPTH, 0]];
  for (let k = 0; k < count; k++) teeth.push([0, k + 0.5], [DEPTH, k + 1]);
  const clip = [
    point(across(DEPTH), along(0, -HALO_PX)), point(across('far'), along(0, -HALO_PX)),
    point(across('far'), along(1, HALO_PX)), point(across(DEPTH), along(1, HALO_PX)),
    ...teeth.slice().reverse().map(([x, y]) => point(across(x), along(y / count))),
  ];
  // In the strip, x runs across from the tips and y along in teeth.
  const strip = teeth.map(([x, y]) => near ? [x, y] : [DEPTH - x, y]).map(([x, y]) => vertical ? `${x},${y}` : `${y},${x}`);
  return { clip: `polygon(${clip.join(', ')})`, path: `M${strip.join(' L')}`, viewBox: vertical ? `0 0 ${DEPTH} ${count}` : `0 0 ${count} ${DEPTH}` };
}

/** Recounts the teeth as the panel resizes; LathHost resizes it every animation frame,
 *  but the count, and so the geometry, changes only every tooth. */
function useTeethCount(panel: RefObject<HTMLElement | null>, edge: ContextSide | undefined) {
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !edge) return;
    const recount = () => {
      const length = edge === 'left' || edge === 'right' ? element.offsetHeight : element.offsetWidth;
      if (length) setCount(teethCount(length));
    };
    recount();
    const observer = new ResizeObserver(recount);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel, edge]);
  return count;
}

/** Freeze the reveal as it stands so an interrupted entrance contracts from what
 *  is visible instead of flashing to full size; CSS clamps the origin, so it is
 *  left alone. Reads before writes: one style recalc, not three. */
function snapshotExit(surface: HTMLElement, content: HTMLElement | null) {
  const { clipPath, opacity } = getComputedStyle(surface);
  const contentOpacity = content ? getComputedStyle(content).opacity : '1';
  surface.style.setProperty('--context-exit-clip', clipPath === 'none' ? 'var(--context-full-clip)' : clipPath);
  surface.style.setProperty('--context-exit-opacity', opacity);
  surface.style.setProperty('--context-exit-content-opacity', contentOpacity);
}

export function TerminalContextView(p: TerminalContextViewProps) {
  const motionClass = motionIsInstant() ? '' : p.closing ? 'terminal-context-exit' : 'terminal-context-enter';
  const surface = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Offsets of the opening pointer inside the surface; the keyframes clamp them.
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.setProperty('--context-origin-x', `${p.origin ? p.origin.x - rect.left : 0}px`);
    element.style.setProperty('--context-origin-y', `${p.origin ? p.origin.y - rect.top : 0}px`);
  }, [p.origin]);
  useEffect(() => { if (!p.closing) surface.current?.focus({ preventScroll: true }); }, [p.closing]);
  const close = useCallback(() => { if (surface.current) snapshotExit(surface.current, content.current); p.onClose(); }, [p.onClose]);
  useEffect(() => {
    if (p.closing) return;
    // A portaled copy editor counts as where its anchor sits.
    const outside = (e: PointerEvent) => { if (!surface.current?.contains(anchoredTarget(e.target))) close(); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [p.closing, close]);
  const detailRoot = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState(p.initialDetail ?? null);
  useEffect(() => {
    if (!detail) return;
    const previous = document.activeElement as HTMLElement | null;
    detailRoot.current?.querySelector<HTMLElement>('input,button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [detail]);
  const [port, setPort] = useState<number | null>(null);
  const [command, setCommand] = useState(p.command);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entries = p.scan.status === 'loaded' ? p.scan.entries : [];
  const selected = entries.find(entry => entry.port === port) ?? entries[0];
  const attempt = async (action: Action) => {
    setError('');
    try { await action(); return true; }
    catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError(messageOf(e));
      return false;
    }
  };
  /** A detail-dialog action: closes the dialog on success and holds the buttons meanwhile. */
  const submit = async (action: Action) => { setBusy(true); if (await attempt(action)) setDetail(null); setBusy(false); };
  const resetAsks = p.resetAsks !== false;
  const requestReset = () => { if (resetAsks) setDetail('reset'); else void submit(p.onReset); };
  const status = HELPER_STATUS[p.status];
  const isTool = p.terminalRole === 'tool';
  // A Tool's command is whatever its shell reported, line breaks included.
  const statusLabel = isTool ? (p.status === 'running' ? `Running ${p.command.replace(/\s+/g, ' ')}…` : 'At prompt') : status.label(p.command);
  const placement = p.placement;
  // The edge facing the source is cut into teeth that reach over it (DESIGN.md → "Terminal Context Teeth").
  const teeth = placement && oppositeEdge(placement.side);
  const count = useTeethCount(panel, teeth);
  const shape = teeth && count ? contextTeeth(teeth, count) : undefined;
  const reach = (side: ContextSide) => (side === teeth ? DEPTH : 0);
  return <section ref={surface} aria-label="Terminal context" data-terminal-context tabIndex={-1} inert={p.closing} aria-hidden={p.closing || undefined} style={SURFACE_STYLE} data-context-side={placement?.side} data-context-teeth={teeth}
    className={`${motionClass} ${p.closing ? 'pointer-events-none' : ''} absolute inset-0 font-mono text-sm text-foreground outline-none`}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (isComposingKey(event.nativeEvent)) return;
      if ((event.target as HTMLElement).closest('[data-helper-terminal], [data-context-terminal]') && !detail) return;
      if (detail && event.key === 'Tab') {
        event.preventDefault();
        stepFocus(Array.from(detailRoot.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select') ?? []), event.shiftKey ? -1 : 1);
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (detail) setDetail(null); else close(); }
    }}>
    <div ref={panel} className={`${TERMINAL_CONTEXT_SURFACE_CLASS} absolute inset-0 flex flex-col overflow-hidden`}
      style={{ boxShadow: ELEVATED_PANE_SHADOW, clipPath: shape?.clip, ...teeth && { [`border${SIDE_NAME[teeth]}Width`]: 0 } }}>
    <div ref={content} className="terminal-context-content flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 max-h-[45%] overflow-auto pb-1" style={{ paddingLeft: 8 + reach('left'), paddingRight: 4 + reach('right'), paddingTop: reach('top') }}>
        <HeaderRow workspaceMove={p.workspaceMove} surfaceId={p.surfaceId} onExplain={() => setDetail('title')} onCopyId={() => attempt(p.onCopyId)} actions={<>
          {placement && <div role="group" aria-label="Helper placement" className="flex shrink-0 items-center gap-0.5">{placement.available.map(side =>
            <ContextAction key={side} label={`Place helper at ${side}`} pressed={placement.side === side} keepFocus onClick={() => placement.onChange(side)}><PlacementIcon side={side} /></ContextAction>)}</div>}
          <ContextAction label="Close terminal context" onClick={close} muted><XIcon size={15} /></ContextAction>
        </>} />
        {/* A narrow panel moves the toggles under the rows, where they sit side by side. */}
        <div className="@container"><div className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-2 pl-1 @[20rem]:grid-cols-[minmax(0,1fr)_auto]">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)]">
            <DirRow cwd={p.cwd} explorerLabel={p.explorerLabel} canExplore={p.canExplore} onExplore={() => attempt(p.onExplore)} onCopyPath={() => attempt(p.onCopyPath)} />
            <div data-context-ports className="flex h-6 min-w-0 items-center gap-1">
              {PORT_ICON}
              {p.scan.status === 'scanning' ? <span className="truncate text-muted">Scanning ports…</span> : p.scan.status === 'failed' ? <span className="truncate text-error">Port scan failed · Reopen to try again</span> : !selected ? <span className="truncate text-muted">No listening ports</span> : <>
                <div className="flex min-w-0 max-w-[45%] shrink items-center gap-2">
                  {entries.length > 1 ? <><select aria-label="Port" title={`${entries.length} ports`} value={selected.port} onChange={e => setPort(Number(e.target.value))} className="h-6 min-w-0 rounded border border-input-border bg-input-bg px-1 text-foreground">{entries.map(entry => <option key={entry.port} value={entry.port}>{entry.host}:{entry.port}{entry.processName ? ` · ${entry.processName}` : ''}</option>)}</select><span className="shrink-0 text-muted">{entries.length} ports</span></>
                    : <span className="truncate" title={`${selected.host}:${selected.port}${selected.processName ? ` · ${selected.processName}` : ''}`}>{selected.host}:{selected.port} <span className="text-muted">{selected.processName}</span></span>}
                </div>
                <span className="ml-1 h-3 shrink-0 border-l border-border" />
                <PortLaunchActions providers={p.browserProviders} canIframe={p.canIframe} onPort={mode => attempt(() => p.onPort(selected, mode))} />
              </>}
            </div>
          </div>
          {/* Stacked beside the rows they belong to, so they cost no height. */}
          <div data-context-alerts className="flex flex-wrap items-center gap-x-2 @[20rem]:grid @[20rem]:gap-x-1 @[20rem]:grid-cols-[auto_auto] @[20rem]:justify-items-end">
            {p.watchRule
              ? <><span className="max-w-[16ch] truncate" title={`Watch all ${p.watchRule} commands`}>watch {p.watchRule}</span><OnOffSwitch on={p.watching} onEnable={p.onWatch} onDisable={p.onWatch} label={`Watch all ${p.watchRule} commands`} /></>
              : <span className="col-span-2 flex h-6 items-center text-muted" title="No command running">no command</span>}
            <span>TODO</span><OnOffSwitch on={p.todo} onEnable={p.onTodo} onDisable={p.onTodo} label="TODO" />
          </div>
        </div></div>
        {p.notification && <div data-context-notification className="flex h-6 min-w-0 items-center gap-1 pl-1" title={[p.notification.title, p.notification.body].filter(Boolean).join('\n')}>
          {BELL_ICON}<span className="truncate">{p.notification.title && <span className="font-semibold">{p.notification.title}</span>}{p.notification.title && p.notification.body && ' '}{p.notification.body && <span className="text-muted">{p.notification.body}</span>}</span>
        </div>}
      </div>
      {/* The terminal ground, carried into the teeth beside and below it. */}
      <div className="@container flex min-h-0 flex-1 flex-col bg-terminal-bg"
        style={teeth && teeth !== 'top' ? { [`border${SIDE_NAME[teeth]}`]: `${DEPTH}px solid transparent` } : undefined}>
        {/* Between hairlines: the helper's label, not a second header. */}
        <div aria-label={isTool ? 'Tool terminal status' : 'Helper terminal status'}
          className="flex h-7 shrink-0 items-center gap-3 whitespace-nowrap px-3 shadow-[inset_0_1px_0_var(--color-border),inset_0_-1px_0_var(--color-border)]">
          {/* Named at every width, so a Tool's own terminal never passes for a helper (docs/specs/terminal-context.md). */}
          <span className="flex shrink-0 items-center gap-2 font-semibold"><TerminalIcon size={15} /><span className="@[48rem]:hidden">{isTool ? 'Tool' : 'Helper'}</span><span className="hidden @[48rem]:inline">{isTool ? 'Tool terminal' : 'Helper terminal'}</span></span>
          <div className="flex min-w-0 items-center gap-2 text-muted">{status.icon}<span className="truncate" title={statusLabel}>{statusLabel}</span></div>
          {!isTool && (status.reset ? <ContextAction label="Reset helper terminal" onClick={requestReset}><ArrowCounterClockwiseIcon size={13} />{resetAsks ? 'Reset…' : 'Reset'}</ContextAction> : <ContextAction label="Modify autorun command" onClick={() => { setCommand(p.defaultCommand ?? p.command); setDetail('modify'); }}><SlidersHorizontalIcon size={15} />Modify</ContextAction>)}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* The action leaves with the mark, so focus stays in the context for Escape and Tab. */}
            {p.onKeepPreview && <ContextAction label="Keep open" onClick={() => { surface.current?.focus({ preventScroll: true }); p.onKeepPreview?.(); }}><PushPinIcon size={15} />Keep open</ContextAction>}
            {!isTool && <ContextAction label="Move this terminal into a new pane" busy={busy} onClick={() => void submit(p.onPromote)}><ArrowLineUpIcon size={15} />Promote</ContextAction>}
          </div>
        </div>
        {p.mismatch && <ContextDiagnostic className="mx-3 my-2 flex max-h-[40%] min-h-0 shrink items-start gap-2 overflow-auto border-l-4 border-error bg-error/10 px-3 py-2"><WarningIcon size={18} weight="fill" className="shrink-0 text-error" /><div className="min-w-0 break-words"><div className="font-semibold">Helper directory differs from parent</div><div className="mt-1 grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2"><span className="text-muted">Helper</span><strong>{p.helperCwd}</strong><span className="text-muted">Parent</span><span>{p.cwd}</span></div></div></ContextDiagnostic>}
        {(p.warning || (!detail && error)) && <ContextDiagnostic className="mx-3 my-2 max-h-[40%] min-h-0 shrink overflow-auto break-words border-l-4 border-error bg-error/10 px-3 py-2">{p.warning || error}</ContextDiagnostic>}
        <div className="min-h-16 flex-1 bg-terminal-bg text-terminal-fg">{p.children}</div>
      </div>
    {detail && <div className="absolute inset-0 z-10 bg-app-bg/35" onClick={() => setDetail(null)}><div ref={detailRoot} role="dialog" aria-modal="true" aria-label={DETAILS[detail].label} className={`${POPUP_SURFACE_CLASS} absolute inset-x-3 top-3 max-h-[calc(100%-1.5rem)] overflow-auto p-4`} onClick={e => e.stopPropagation()}>
      <div className="mb-3 flex items-center justify-between font-semibold"><span>{DETAILS[detail].heading}</span><ContextAction label="Close details" onClick={() => setDetail(null)} muted><XIcon size={14} /></ContextAction></div>
      {detail === 'title' ? <div className="grid grid-cols-[8rem_1fr_auto] gap-x-3 gap-y-2">{p.titleSources.map((source, index) => <div className="contents" key={index}><span className="text-muted">{source.source}</span><span>{source.value}</span><span className="text-muted">{source.note}</span></div>)}</div> : detail === 'modify' ? <><input autoFocus aria-label="Default helper autorun command" value={command} onChange={e => setCommand(e.target.value)} maxLength={4096} placeholder="Leave empty to turn autorun off" className="w-full border-b border-input-border bg-input-bg px-2 py-1.5 outline-focus-ring" /><p className="mb-4 mt-2 text-muted">Global default. Applies to new and reset helpers. Leave empty to turn autorun off.</p><div className="flex justify-end gap-2"><ContextAction label="Reset helper terminal" onClick={requestReset}>{resetAsks ? 'Reset helper…' : 'Reset helper'}</ContextAction><ContextAction label="Save default" busy={busy} onClick={() => void submit(() => p.onModify(command))}>Save default</ContextAction></div></> : <><p>Discard this helper, including scrollback, unfinished input, and any running program? Unsaved edits will be lost.</p><p className="mb-4 mt-2 text-muted">A fresh helper starts in the parent's current directory using the global autorun default.</p><div className="flex justify-end gap-2"><ContextAction label="Keep helper" onClick={() => setDetail(null)}>Keep helper</ContextAction><ContextAction label="Discard and reset" busy={busy} onClick={() => void submit(p.onReset)}>Discard and reset</ContextAction></div></>}
      {error && <ContextDiagnostic className="mt-2 text-error">{error}</ContextDiagnostic>}
    </div></div>}
    </div>
    </div>
    {teeth && shape && <svg aria-hidden="true" viewBox={shape.viewBox} preserveAspectRatio="none"
      className="pointer-events-none absolute overflow-visible" style={stripStyle(teeth)}><path d={shape.path} vectorEffect="non-scaling-stroke" className="fill-none stroke-foreground/20" /></svg>}
  </section>;
}
