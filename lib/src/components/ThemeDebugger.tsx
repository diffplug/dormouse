import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClipboardTextIcon, XIcon } from '@phosphor-icons/react';
import {
  captureThemeDiagnostics,
  type SemanticTokenSnapshot,
  type ThemeDiagnosticSnapshot,
  type VisibleVarOrigin,
  type VscodeThemeVarTraceOrigin,
} from '../lib/themes';

export const OPEN_THEME_DEBUGGER_EVENT = 'dormouse:openThemeDebugger';

export function openThemeDebugger(): void {
  window.dispatchEvent(new CustomEvent(OPEN_THEME_DEBUGGER_EVENT));
}

function Swatch({ value }: { value: string | null }) {
  return (
    <span
      className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border"
      style={{ backgroundColor: value ?? 'transparent' }}
      aria-hidden="true"
    />
  );
}

function Value({ value }: { value: string | null }) {
  return <span className="break-all text-foreground">{value ?? 'missing'}</span>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="mb-2 text-sm font-semibold text-app-fg">{title}</h3>
      {children}
    </section>
  );
}

function originClass(origin: VscodeThemeVarTraceOrigin | VisibleVarOrigin): string {
  switch (origin) {
    case 'provided':
    case 'host-provided':
      return 'text-success';
    case 'registry-default':
    case 'dormouse-materialized':
      return '[color:var(--vscode-terminal-ansiYellow)]';
    case 'fallback':
      return 'text-muted';
    case 'unresolved':
    case 'missing':
      return 'text-error';
  }
}

function SourceOrigin({
  token,
  snapshot,
}: {
  token: SemanticTokenSnapshot;
  snapshot: ThemeDiagnosticSnapshot;
}) {
  if (!token.sourceVar || token.group === 'dynamic') return <span className="text-muted">runtime</span>;
  const trace = snapshot.resolverTraces.find((item) => item.name === token.sourceVar);
  const origin = trace?.origin ?? 'host-provided';
  return <span className={originClass(origin)}>{origin}</span>;
}

function SurfaceHierarchy({ snapshot }: { snapshot: ThemeDiagnosticSnapshot }) {
  const rows = snapshot.semanticTokens.filter((item) => (
    item.group === 'surface' || item.group === 'chrome' || item.group === 'dynamic'
  ));

  return (
    <div className="grid gap-1.5">
      {rows.map((item) => (
        <div
          key={item.token}
          className="grid min-w-0 grid-cols-1 gap-1 rounded bg-surface-raised px-2 py-1.5 text-sm md:grid-cols-[minmax(9rem,1fr)_minmax(8rem,1fr)_minmax(7rem,1fr)_auto] md:items-center md:gap-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Swatch value={item.value} />
            <span className="truncate text-app-fg">{item.token}</span>
          </div>
          <span className="truncate text-muted">{item.sourceVar ?? 'runtime'}</span>
          <Value value={item.value} />
          <SourceOrigin token={item} snapshot={snapshot} />
        </div>
      ))}
    </div>
  );
}

function ResolvedVars({ snapshot }: { snapshot: ThemeDiagnosticSnapshot }) {
  const originByVar = useMemo(() => {
    const map = new Map(snapshot.visibleVars.map((item) => [item.name, item.origin]));
    return map;
  }, [snapshot.visibleVars]);

  return (
    <div className="max-h-64 overflow-auto rounded border border-border bg-app-bg">
      {snapshot.resolverTraces.map((trace) => (
        <div
          key={trace.name}
          className="grid min-w-[720px] grid-cols-[minmax(15rem,1fr)_7rem_minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(12rem,1.2fr)] gap-2 border-b border-border px-2 py-1.5 text-sm last:border-b-0"
        >
          <span className="truncate text-app-fg">{trace.name}</span>
          <span className={originClass(trace.origin)}>{trace.origin}</span>
          <Value value={trace.resolvedValue} />
          <span className="break-all text-muted">{trace.registryDefault ?? 'null'}</span>
          <span className="break-all text-muted">
            {trace.fallbackPath.length ? trace.fallbackPath.join(' -> ') : originByVar.get(trace.name) ?? 'none'}
          </span>
        </div>
      ))}
    </div>
  );
}

function TerminalColors({ snapshot }: { snapshot: ThemeDiagnosticSnapshot }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
      {snapshot.terminalColors.map((item) => (
        <div key={item.sourceVar} className="min-w-0 rounded bg-surface-raised px-2 py-1.5 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <Swatch value={item.value} />
            <span className="truncate text-app-fg">{item.label}</span>
          </div>
          <div className="mt-1 truncate text-muted">{item.sourceVar}</div>
          <div className="mt-0.5 break-all text-foreground">{item.value ?? 'missing'}</div>
        </div>
      ))}
    </div>
  );
}

function DynamicPicks({ snapshot }: { snapshot: ThemeDiagnosticSnapshot }) {
  const door = snapshot.dynamicPalette.door;
  const focusRing = snapshot.dynamicPalette.focusRing;
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <div className="rounded bg-surface-raised p-2 text-sm">
        <div className="mb-1 font-semibold text-app-fg">Door</div>
        {door ? (
          <>
            <div className="flex items-center gap-2">
              <Swatch value={door.bgValue} />
              <span className="text-muted">{door.bgVar}</span>
              <Value value={door.bgValue} />
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Swatch value={door.fgValue} />
              <span className="text-muted">{door.fgVar}</span>
              <Value value={door.fgValue} />
            </div>
            <p className="mt-2 text-muted">{door.reason}</p>
          </>
        ) : (
          <p className="text-muted">unresolved</p>
        )}
      </div>
      <div className="rounded bg-surface-raised p-2 text-sm">
        <div className="mb-1 font-semibold text-app-fg">Focus Ring</div>
        {focusRing ? (
          <>
            <div className="flex items-center gap-2">
              <Swatch value={focusRing.value} />
              <span className="text-muted">{focusRing.sourceVar}</span>
              <Value value={focusRing.value} />
            </div>
            <p className="mt-2 text-muted">{focusRing.reason}</p>
          </>
        ) : (
          <p className="text-muted">unresolved</p>
        )}
      </div>
    </div>
  );
}

function copyWithFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.append(textArea);
  textArea.select();
  document.execCommand('copy');
  textArea.remove();
  return Promise.resolve();
}

export function ThemeDebuggerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<ThemeDiagnosticSnapshot | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;

    const refresh = () => setSnapshot(captureThemeDiagnostics());
    refresh();

    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timeout);
  }, [copied]);

  if (!open) return null;

  const copyReport = async () => {
    if (!snapshot) return;
    await copyWithFallback(snapshot.report);
    setCopied(true);
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="fixed inset-0 z-50 m-auto h-[min(720px,calc(100vh-2rem))] w-[min(960px,calc(100vw-2rem))] overflow-hidden rounded border border-border bg-app-bg p-0 font-mono text-app-fg shadow-2xl backdrop:bg-app-bg/80"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Theme Debugger</h2>
            <p className="truncate text-sm text-muted">
              {snapshot?.activeTheme
                ? `${snapshot.activeTheme.label} - ${snapshot.activeTheme.origin} - ${snapshot.themeKind}`
                : `VSCode host theme - ${snapshot?.themeKind ?? 'detecting'}`}
            </p>
          </div>
          <button
            type="button"
            onClick={copyReport}
            disabled={!snapshot}
            className="flex h-7 items-center gap-1.5 rounded px-2 text-sm text-app-fg transition-colors hover:bg-surface-raised disabled:opacity-50"
          >
            <ClipboardTextIcon size={14} weight="bold" />
            {copied ? 'Copied' : 'Copy report'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
            aria-label="Close theme debugger"
          >
            <XIcon size={14} weight="bold" />
          </button>
        </header>

        {snapshot ? (
          <div className="flex-1 space-y-4 overflow-auto px-4 py-3">
            <Section title="Surface Hierarchy">
              <SurfaceHierarchy snapshot={snapshot} />
            </Section>
            <Section title="Resolved VSCode Vars">
              <ResolvedVars snapshot={snapshot} />
            </Section>
            <Section title="Terminal Colors">
              <TerminalColors snapshot={snapshot} />
            </Section>
            <Section title="Dynamic Picks">
              <DynamicPicks snapshot={snapshot} />
            </Section>
            <Section title="Report">
              <textarea
                readOnly
                value={snapshot.report}
                className="h-44 w-full resize-none rounded border border-border bg-surface-raised p-2 text-sm text-foreground outline-none"
              />
            </Section>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">Capturing theme...</div>
        )}
      </div>
    </dialog>
  );
}

export function ThemeDebuggerGlobal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_THEME_DEBUGGER_EVENT, handler);
    return () => window.removeEventListener(OPEN_THEME_DEBUGGER_EVENT, handler);
  }, []);

  return <ThemeDebuggerDialog open={open} onClose={() => setOpen(false)} />;
}
