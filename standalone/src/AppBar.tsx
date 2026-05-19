import { useState, useEffect, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CaretDownIcon, MinusIcon, CornersOutIcon, CornersInIcon, XIcon, PlusIcon, CheckIcon } from '@phosphor-icons/react';
import { ThemePicker } from '../../lib/src/components/ThemePicker';
import { PopupButtonRow, chromeButton } from '../../lib/src/components/design';
import { setDefaultShellOpts } from '../../lib/src/lib/shell-defaults';
import { IS_MAC } from '../../lib/src/lib/platform';

export interface ShellEntry {
  name: string;
  path: string;
  args?: string[];
}

interface AppBarProps {
  shells: ShellEntry[];
}

const appWindow = getCurrentWindow();

function useAppWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());

  useEffect(() => {
    appWindow.isFocused().then(setFocused);
    const unlisten = appWindow.onFocusChanged(({ payload }) => setFocused(payload));
    return () => { unlisten.then(fn => fn()); };
  }, []);

  return focused;
}

// ── Tooltip wrapper ────────────────────────────────────────────────────────

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="group relative flex items-stretch">
      {children}
      <PopupButtonRow
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap px-2 py-1 opacity-0 transition-opacity group-hover:opacity-100"
      >
        {label}
      </PopupButtonRow>
    </div>
  );
}

// ── Windows/Linux window buttons ───────────────────────────────────────────

function WinControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setMaximized);
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setMaximized);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  return (
    <div className="flex items-stretch self-stretch">
      <Tip label="Minimize">
        <button
          className={chromeButton({ kind: 'window' })}
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          <MinusIcon size={12} weight="bold" />
        </button>
      </Tip>
      <Tip label={maximized ? 'Restore' : 'Maximize'}>
        <button
          className={chromeButton({ kind: 'window' })}
          onClick={() => { appWindow.toggleMaximize(); }}
          aria-label={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized
            ? <CornersInIcon size={12} weight="bold" />
            : <CornersOutIcon size={12} weight="bold" />}
        </button>
      </Tip>
      <Tip label="Close">
        <button
          className={chromeButton({ kind: 'windowClose' })}
          onClick={() => appWindow.close()}
          aria-label="Close"
        >
          <XIcon size={12} weight="bold" />
        </button>
      </Tip>
    </div>
  );
}

// ── Shell dropdown ─────────────────────────────────────────────────────────

function ShellDropdown({ shells }: { shells: ShellEntry[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ShellEntry | undefined>(shells[0]);
  const ref = useRef<HTMLDivElement>(null);

  // Publish the selection so splits (and other spawn paths) can reuse it.
  useEffect(() => {
    setDefaultShellOpts(selected ? { shell: selected.path, args: selected.args } : null);
  }, [selected]);

  const spawn = useCallback((
    shell: ShellEntry,
    options: { replaceUntouched?: boolean; announce?: boolean } = {},
  ) => {
    window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
      detail: {
        shell: shell.path,
        args: shell.args,
        name: shell.name,
        ...options,
      },
    }));
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      {/* Primary action: [+] spawns a new terminal with the selected shell */}
      <Tip label={`New ${selected?.name ?? 'terminal'}`}>
        <button
          className={chromeButton({ kind: 'icon' })}
          onClick={() => selected && spawn(selected)}
          aria-label={`New ${selected?.name ?? 'terminal'}`}
        >
          <PlusIcon size={12} weight="bold" />
        </button>
      </Tip>
      {/* Selector: shows current shell name + caret; click to choose a different shell */}
      <Tip label="Choose shell">
        <button
          className={chromeButton({ kind: 'labeled' })}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <span className="font-mono text-[11px]">{selected?.name ?? 'shell'}</span>
          <CaretDownIcon size={10} weight="bold" />
        </button>
      </Tip>
      {open && (
        <PopupButtonRow
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 w-max flex-col py-1"
        >
          {shells.map((shell) => {
            const isSelected = shell.name === selected?.name;
            return (
              <button
                key={shell.name}
                role="menuitemradio"
                aria-checked={isSelected}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-surface-raised"
                onClick={() => {
                  setOpen(false);
                  if (isSelected) return;
                  setSelected(shell);
                  spawn(shell, { replaceUntouched: true, announce: true });
                }}
              >
                <span className="flex w-3.5 shrink-0 items-center justify-center">
                  {isSelected && <CheckIcon size={12} weight="bold" />}
                </span>
                {shell.name}
              </button>
            );
          })}
        </PopupButtonRow>
      )}
    </div>
  );
}

// ── AppBar ─────────────────────────────────────────────────────────────────

export function AppBar({ shells }: AppBarProps) {
  const windowFocused = useAppWindowFocused();

  return (
    <div
      data-tauri-drag-region
      className={`flex h-[30px] shrink-0 select-none items-center text-xs ${
        windowFocused
          ? 'bg-header-active-bg text-header-active-fg'
          : 'bg-header-inactive-bg text-header-inactive-fg'
      } ${
        IS_MAC ? 'pl-[78px]' : ''
      }`}
    >
      {/* On macOS, native traffic lights are shown by titleBarStyle "Overlay" —
          we just leave padding on the left (pl-[78px]) to avoid overlapping them. */}

      {/* Shell dropdown sits on the left on every platform (after the traffic
          lights on macOS, or at the start of the bar on Windows/Linux). */}
      <div className="pl-2">
        <ShellDropdown shells={shells} />
      </div>

      {/* Draggable spacer */}
      <div data-tauri-drag-region className="flex-1 self-stretch" />

      {/* Theme picker is right-aligned on every platform; Windows/Linux
          additionally show the native-style window controls after it. */}
      <div className="ml-auto flex items-stretch self-stretch">
        <div className="flex items-center pr-2">
          <ThemePicker variant="standalone-appbar" />
        </div>
        {!IS_MAC && <WinControls />}
      </div>
    </div>
  );
}
