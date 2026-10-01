import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenVSXExtension } from '../../lib/themes';
import { modalSurface, NativeModalDialog } from '../design';
import {
  addInstalledTheme,
  applyTheme,
  fetchExtensionThemes,
  getInstalledThemes,
  removeInstalledTheme,
  restoreActiveTheme,
  searchThemes,
  setActiveThemeId,
} from '../../lib/themes';

/** Mount only while open (`NativeModalDialog`). */
export function ThemeStoreDialog({
  onClose,
  onThemesChanged,
}: {
  onClose: () => void;
  onThemesChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OpenVSXExtension[]>([]);
  const [loading, setLoading] = useState(false);
  // One entry per row, since installs run concurrently: a single slot would be
  // cleared by whichever install settled first, re-enabling a row still in flight.
  const [installing, setInstalling] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every search takes a new epoch, so only the newest search may write its
  // outcome: an earlier query can answer after a later one.
  const searchEpoch = useRef(0);

  // A debounce still pending at unmount would search for a closed store.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const doSearch = useCallback(async (value: string) => {
    const epoch = ++searchEpoch.current;
    const newest = () => searchEpoch.current === epoch;
    if (!value.trim()) {
      setResults([]);
      // The request this supersedes has its `finally` gated off, so clear the
      // spinner it left; an earlier failure's banner has no query left either.
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await searchThemes(value, 0, 20);
      if (newest()) setResults(response.extensions);
    } catch (reason) {
      if (newest()) setError(reason instanceof Error ? reason.message : 'Search failed');
    } finally {
      if (newest()) setLoading(false);
    }
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleInstall = async (extension: OpenVSXExtension) => {
    const key = `${extension.namespace}/${extension.name}`;
    setInstalling((current) => new Set(current).add(key));
    setError(null);
    try {
      const themes = await fetchExtensionThemes(extension.namespace, extension.name);
      for (const theme of themes) addInstalledTheme(theme);
      if (themes[0]) {
        setActiveThemeId(themes[0].id);
        applyTheme(themes[0]);
      }
      onThemesChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Install failed');
    } finally {
      setInstalling((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  // No `window.confirm` gate: native dialogs are not dependable in the desktop
  // webview (DESIGN.md -> Don't), and a Remove gated on one silently did
  // nothing there. The button is already an explicit per-extension action, and
  // re-installing is one click away in this same dialog.
  const handleRemoveExtension = (extensionId: string) => {
    for (const theme of getInstalledThemes()) {
      if (theme.origin.kind === 'installed' && theme.origin.extensionId === extensionId) {
        removeInstalledTheme(theme.id);
      }
    }
    restoreActiveTheme();
    onThemesChanged();
  };

  const isInstalled = (extension: OpenVSXExtension) => {
    const key = `${extension.namespace}/${extension.name}`;
    return getInstalledThemes().some(
      (theme) => theme.origin.kind === 'installed' && theme.origin.extensionId === key,
    );
  };

  return (
    <NativeModalDialog
      onClose={onClose}
      className={`${modalSurface({ padding: 'none', elevation: 'modal' })} fixed inset-0 z-50 m-auto h-[420px] w-[min(380px,calc(100vw-2rem))] backdrop:bg-black/50`}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-medium">Install theme from OpenVSX</span>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted transition-opacity hover:opacity-100"
            aria-label="Close theme store"
          >
            X
          </button>
        </div>

        <div className="px-4 py-2">
          <input
            type="text"
            value={query}
            onChange={(event) => handleInput(event.target.value)}
            placeholder="Search themes..."
            autoFocus
            className="w-full rounded border border-input-border bg-input-bg px-3 py-1.5 text-sm text-foreground outline-none placeholder:opacity-65"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-3">
          {error ? (
            <div className="rounded px-3 py-2 text-sm text-error">
              {error}
            </div>
          ) : null}
          {loading ? <div className="py-8 text-center text-sm text-muted">Searching...</div> : null}
          {!loading && results.length === 0 && query.trim() ? (
            <div className="py-8 text-center text-sm text-muted">No themes found</div>
          ) : null}
          {!loading && !query.trim() ? (
            <div className="py-8 text-center text-sm text-muted">
              Search for a VS Code theme to install
            </div>
          ) : null}
          {results.map((extension) => {
            const key = `${extension.namespace}/${extension.name}`;
            const installed = isInstalled(extension);
            const isInstallingThis = installing.has(key);
            return (
              <div key={key} className="flex items-center gap-3 rounded px-2 py-2 transition-colors hover:opacity-85">
                {extension.files?.icon ? (
                  <img src={extension.files.icon} alt="" className="h-8 w-8 shrink-0 rounded" />
                ) : (
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-input-border bg-input-bg text-sm text-muted"
                  >
                    VS
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{extension.displayName || extension.name}</div>
                  <div className="truncate text-sm text-muted">
                    {extension.namespace} - {extension.downloadCount.toLocaleString()} downloads
                  </div>
                </div>
                {installed ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveExtension(key)}
                    className="shrink-0 rounded px-2 py-1 text-sm text-muted transition-opacity hover:opacity-100"
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleInstall(extension)}
                    disabled={isInstallingThis}
                    className="shrink-0 rounded bg-button-bg px-2 py-1 text-sm text-button-fg transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {isInstallingThis ? 'Installing...' : 'Install'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </NativeModalDialog>
  );
}
