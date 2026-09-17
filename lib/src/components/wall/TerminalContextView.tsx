import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowCounterClockwiseIcon, ArrowLineUpIcon, ArrowSquareOutIcon, BugBeetleIcon, CheckIcon, CircleNotchIcon, CopyIcon, FrameCornersIcon, PauseIcon, SlidersHorizontalIcon, TerminalIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import { OnOffSwitch, POPUP_SURFACE_CLASS, SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS, SUBTLE_ACTION_REST_COLOR_CLASS, TERMINAL_CONTEXT_SURFACE_CLASS, TERMINAL_CONTEXT_EXIT_MS, TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import { stepFocus } from '../focus-step';
import { AgentRobotIcon } from './BrowserDisplayIcon';
import type { PortUrlEntry } from './port-url';
import type { HelperStatus } from '../../lib/helper-terminal';
import { WindowFocusedContext } from './wall-context';
import { motionIsInstant } from '../../lib/ui-geometry';
import { messageOf } from '../../lib/errors';

export type PortMode = 'system' | 'iframe' | 'ab-screencast' | 'ab-popout';
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

/** The port row's launch targets; `needs` names the host capability that enables one. */
const PORT_ACTIONS: readonly ({ mode: PortMode; label: string; icon: ReactNode; text: string } & ({ needs?: undefined } | { needs: 'canIframe' | 'canAgent'; unavailable: string }))[] = [
  { mode: 'system', label: 'Open in system browser', icon: <ArrowSquareOutIcon size={15} />, text: 'System browser' },
  { mode: 'iframe', label: 'Open in iframe embed', needs: 'canIframe', unavailable: 'Iframe unavailable on this host', icon: <FrameCornersIcon size={15} />, text: 'Iframe' },
  { mode: 'ab-screencast', label: 'Open in agent-browser screencast', needs: 'canAgent', unavailable: 'Agent browser unavailable on this host', icon: <AgentRobotIcon size={17} />, text: 'Agent browser' },
  { mode: 'ab-popout', label: 'Open in agent-browser popout', needs: 'canAgent', unavailable: 'Popout unavailable on this host', icon: <><AgentRobotIcon size={17} /><ArrowSquareOutIcon size={13} /></>, text: 'Popout' },
];

const DETAILS = {
  title: { label: 'Title sources', heading: 'Why this title?' },
  modify: { label: 'Default helper autorun command', heading: 'Default helper autorun command' },
  reset: { label: 'Reset helper terminal', heading: 'Reset helper terminal?' },
} as const;
type Detail = keyof typeof DETAILS;
export interface TerminalContextViewProps {
  terminalRole?: 'helper' | 'tool';
  /** Exit in progress: the view is inert, and `onClose` is not called again. */
  closing?: boolean;
  /** Viewport coordinates the reveal grows from; absent, the top-left corner. */
  origin?: { x: number; y: number };
  defaultCommand?: string; title: string; surfaceRef: string; cwd: string; helperCwd?: string; mismatch?: boolean;
  titleSources: { source: string; value: string; note?: string }[];
  scan: ContextScan; argv0?: string | null; watching: boolean; todo: boolean;
  notification?: { title: string | null; body: string | null } | null;
  status: HelperStatus; command: string; warning?: string;
  explorerLabel: string; canExplore: boolean; canAgent: boolean; canIframe: boolean;
  children: ReactNode; notepadAction?: ReactNode; notepadPanel?: ReactNode;
  onClose(): void; onCopyRef: Action; onCopyPath: Action; onExplore: Action;
  onWatch(): void; onTodo(): void; onPort(entry: PortUrlEntry, mode: PortMode): void | Promise<void>;
  onModify(command: string): Promise<void>; onReset: Action; onPromote: Action;
  initialDetail?: Detail | null;
}

export function ContextAction({ children, label, onClick, disabled = false, busy = false, muted = false }: { children: ReactNode; label: string; onClick?: () => void; disabled?: boolean; busy?: boolean; muted?: boolean }) {
  const windowFocused = useContext(WindowFocusedContext);
  // Native app launches can leave :hover stale until this window regains focus.
  const color = muted ? 'text-muted' : windowFocused ? SUBTLE_ACTION_COLOR_CLASS : SUBTLE_ACTION_REST_COLOR_CLASS;
  // `busy` must never reach native `disabled`: the browser blurs a button the moment it is disabled,
  // and this context's Escape and Tab handling both live on the <section> and need a focused descendant.
  return <button type="button" title={label} aria-label={label} aria-busy={busy || undefined} aria-disabled={busy || undefined} disabled={disabled} onClick={busy ? undefined : onClick}
    className={`inline-flex h-6 shrink-0 items-center justify-center gap-1.5 rounded px-1.5 disabled:opacity-40 ${windowFocused ? SUBTLE_ACTION_INTERACTION_CLASS : ''} ${color}`}>{children}</button>;
}

function ContextCopyAction({ children, label, onCopy }: { children: ReactNode; label: string; onCopy: () => Promise<boolean> }) {
  const [confirmation, setConfirmation] = useState(0);
  useEffect(() => {
    if (!confirmation) return;
    const timer = setTimeout(() => setConfirmation(0), 1400);
    return () => clearTimeout(timer);
  }, [confirmation]);
  return <ContextAction label={label} onClick={() => {
    setConfirmation(0);
    void onCopy().then(success => { if (success) setConfirmation(value => value + 1); });
  }}>
    <span className="grid">
      <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 ${confirmation ? 'invisible' : ''}`}>{children}</span>
      <span role="status" className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">
        {confirmation ? <><CheckIcon size={14} weight="bold" />Copied</> : null}
      </span>
    </span>
  </ContextAction>;
}

function ContextOpenAction({ children, label, disabled, onOpen }: { children: ReactNode; label: string; disabled: boolean; onOpen: () => Promise<boolean> }) {
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
    <span className="grid">
      <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 ${opening ? 'invisible' : ''}`}>{children}</span>
      <span role="status" className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">
        {opening ? <><CircleNotchIcon size={15} className="animate-spin motion-reduce:animate-none" />Opening…</> : null}
      </span>
    </span>
  </ContextAction>;
}

/** The custom properties `.terminal-context-enter` / `-exit` read (`lib/src/theme.css`)
 *  that JS owns: the exit length the removal timer must match, and the corner radius. */
const SURFACE_STYLE = { '--context-exit-duration': `${TERMINAL_CONTEXT_EXIT_MS}ms`, '--context-radius': TERMINAL_SELECTION_BORDER_RADIUS } as CSSProperties;

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
    const outside = (e: PointerEvent) => { if (!surface.current?.contains(e.target as Node)) close(); };
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
  const attempt = async (action: Action) => { setError(''); try { await action(); return true; } catch (e) { setError(messageOf(e)); return false; } };
  /** A detail-dialog action: closes the dialog on success and holds the buttons meanwhile. */
  const submit = async (action: Action) => { setBusy(true); if (await attempt(action)) setDetail(null); setBusy(false); };
  const status = HELPER_STATUS[p.status];
  const isTool = p.terminalRole === 'tool';
  const statusLabel = isTool ? (p.status === 'running' ? `Running ${p.command}…` : 'At prompt') : status.label(p.command);
  return <section ref={surface} aria-label="Terminal context" data-terminal-context tabIndex={-1} inert={p.closing} aria-hidden={p.closing || undefined} style={SURFACE_STYLE}
    className={`${TERMINAL_CONTEXT_SURFACE_CLASS} ${motionClass} ${p.closing ? 'pointer-events-none' : ''} absolute inset-4 flex flex-col overflow-hidden text-sm`}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if ((event.target as HTMLElement).closest('[data-helper-terminal], [data-context-terminal]') && !detail) return;
      if (detail && event.key === 'Tab') {
        event.preventDefault();
        stepFocus(Array.from(detailRoot.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select') ?? []), event.shiftKey ? -1 : 1);
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (detail) setDetail(null); else close(); }
    }}>
    <div ref={content} className="terminal-context-content flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 py-2">
        <div className="grid grid-cols-[4rem_1fr] items-center gap-y-1">
          <span className="text-muted">Title</span>
          <div className="flex h-6 min-w-0 items-center gap-1.5">
            <span className="truncate">{p.title}</span><ContextAction label="Explain this title" onClick={() => setDetail('title')}><BugBeetleIcon size={15} />Explain</ContextAction>
            <div className="ml-auto flex shrink-0 items-center gap-2 text-muted"><ContextCopyAction label="Copy surface identifier" onCopy={() => attempt(p.onCopyRef)}><span>{p.surfaceRef}</span><CopyIcon size={12} /></ContextCopyAction><ContextAction label="Close terminal context" onClick={close} muted><XIcon size={15} /></ContextAction></div>
          </div>
          <span className="text-muted">Dir</span>
          <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-1.5"><span className="truncate" title={p.cwd}>{p.cwd}</span><ContextOpenAction label={p.canExplore ? p.explorerLabel : 'Directory unavailable on this host'} disabled={!p.canExplore} onOpen={() => attempt(p.onExplore)}><ArrowSquareOutIcon size={15} />{p.explorerLabel}</ContextOpenAction><ContextCopyAction label="Copy absolute path" onCopy={() => attempt(p.onCopyPath)}><CopyIcon size={14} />Copy path</ContextCopyAction></div>
          <span className="text-muted">Ports</span>
          <div className="flex min-h-7 flex-wrap items-center gap-2">
            {p.scan.status === 'scanning' ? <span className="text-muted">Scanning ports…</span> : p.scan.status === 'failed' ? <span className="text-error">Port scan failed · Reopen to try again</span> : !selected ? <span className="text-muted">No listening ports</span> : <>
              {entries.length > 1 ? <div className="inline-flex shrink-0 items-center gap-2"><select aria-label="Port" value={selected.port} onChange={e => setPort(Number(e.target.value))} className="h-6 rounded border border-input-border bg-input-bg px-1 text-foreground">{entries.map(entry => <option key={entry.port} value={entry.port}>{entry.host}:{entry.port}{entry.processName ? ` · ${entry.processName}` : ''}</option>)}</select><span className="text-muted">{entries.length} ports</span></div> : <><span>{selected.host}:{selected.port}</span><span className="text-muted">{selected.processName}</span></>}
              <div className="ml-1 inline-flex shrink-0 items-center gap-1 border-l border-border pl-2">
                {PORT_ACTIONS.map(action => {
                  const unavailable = action.needs && !p[action.needs] ? action.unavailable : null;
                  return <ContextAction key={action.mode} label={unavailable ?? action.label} disabled={!!unavailable} onClick={() => void attempt(() => p.onPort(selected, action.mode))}>{action.icon}{action.text}</ContextAction>;
                })}
              </div>
            </>}
          </div>
          <span className="text-muted">Alerts</span><div className="flex h-6 items-center gap-2"><span>{p.argv0 ? `Watch all ${p.argv0} commands` : 'No command running'}</span>{p.argv0 && <OnOffSwitch on={p.watching} onEnable={p.onWatch} onDisable={p.onWatch} label={`Watch all ${p.argv0} commands`} />}<span className="mx-1 h-3 border-l border-border" /><span>TODO</span><OnOffSwitch on={p.todo} onEnable={p.onTodo} onDisable={p.onTodo} label="TODO" /></div>
        </div>
        {p.notification && <div className="ml-16 mt-2 border-l-2 border-border py-1 pl-3"><div>{p.notification.title}</div><div className="whitespace-pre-wrap text-muted">{p.notification.body}</div></div>}
      </div>
      <div className="@container flex min-h-0 flex-1 flex-col border-t border-border">
        <div aria-label={isTool ? 'Tool terminal status' : 'Helper terminal status'} className="flex h-9 shrink-0 items-center gap-3 whitespace-nowrap px-3">
          <span className="hidden shrink-0 items-center gap-2 font-semibold @[48rem]:flex"><TerminalIcon size={15} />{isTool ? 'Tool terminal' : 'Helper terminal'}</span>
          <div className="flex min-w-0 items-center gap-2 text-muted">{status.icon}<span className="truncate" title={statusLabel}>{statusLabel}</span>
            {!isTool && (status.reset ? <ContextAction label="Reset helper terminal" onClick={() => setDetail('reset')}><ArrowCounterClockwiseIcon size={13} />Reset…</ContextAction> : <ContextAction label="Modify autorun command" onClick={() => { setCommand(p.defaultCommand ?? p.command); setDetail('modify'); }}><SlidersHorizontalIcon size={15} />Modify</ContextAction>)}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">{p.notepadAction}{!isTool && <ContextAction label="Move this terminal into a new pane" busy={busy} onClick={() => void submit(p.onPromote)}><ArrowLineUpIcon size={15} />Promote</ContextAction>}</div>
        </div>
        {p.mismatch && <div role="alert" className="mx-3 mb-2 flex shrink-0 items-start gap-2 border-l-4 border-error bg-error/10 px-3 py-2"><WarningIcon size={18} weight="fill" className="shrink-0 text-error" /><div><div className="font-semibold">Helper directory differs from parent</div><div className="mt-1 grid grid-cols-[4rem_1fr] gap-x-2"><span className="text-muted">Helper</span><strong>{p.helperCwd}</strong><span className="text-muted">Parent</span><span>{p.cwd}</span></div></div></div>}
        {(p.warning || (!detail && error)) && <div role="alert" className="mx-3 mb-2 border-l-4 border-error bg-error/10 px-3 py-2">{p.warning || error}</div>}
        <div className="min-h-0 flex-1 bg-terminal-bg text-terminal-fg">{p.children}</div>
      </div>
    {p.notepadPanel}
    {detail && <div className="absolute inset-0 z-10 bg-app-bg/35" onClick={() => setDetail(null)}><div ref={detailRoot} role="dialog" aria-modal="true" aria-label={DETAILS[detail].label} className={`${POPUP_SURFACE_CLASS} absolute left-3 right-3 top-9 p-4`} onClick={e => e.stopPropagation()}>
      <div className="mb-3 flex items-center justify-between font-semibold"><span>{DETAILS[detail].heading}</span><ContextAction label="Close details" onClick={() => setDetail(null)} muted><XIcon size={14} /></ContextAction></div>
      {detail === 'title' ? <div className="grid grid-cols-[8rem_1fr_auto] gap-x-3 gap-y-2">{p.titleSources.map((source, index) => <div className="contents" key={index}><span className="text-muted">{source.source}</span><span>{source.value}</span><span className="text-muted">{source.note}</span></div>)}</div> : detail === 'modify' ? <><input autoFocus aria-label="Default helper autorun command" value={command} onChange={e => setCommand(e.target.value)} maxLength={4096} placeholder="Leave empty to turn autorun off" className="w-full border-b border-input-border bg-input-bg px-2 py-1.5 outline-focus-ring" /><p className="mb-4 mt-2 text-muted">Global default. Applies to new and reset helpers. Leave empty to turn autorun off.</p><div className="flex justify-end gap-2"><ContextAction label="Reset helper terminal" onClick={() => setDetail('reset')}>Reset helper…</ContextAction><ContextAction label="Save default" busy={busy} onClick={() => void submit(() => p.onModify(command))}>Save default</ContextAction></div></> : <><p>Discard this helper, including scrollback, unfinished input, and any running program? Unsaved edits will be lost.</p><p className="mb-4 mt-2 text-muted">A fresh helper starts in the parent's current directory using the global autorun default.</p><div className="flex justify-end gap-2"><ContextAction label="Keep helper" onClick={() => setDetail(null)}>Keep helper</ContextAction><ContextAction label="Discard and reset" busy={busy} onClick={() => void submit(p.onReset)}>Discard and reset</ContextAction></div></>}
      {error && <p role="alert" className="mt-2 text-error">{error}</p>}
    </div></div>}
    </div>
  </section>;
}
