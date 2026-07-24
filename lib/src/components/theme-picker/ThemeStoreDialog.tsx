import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenVSXExtension } from '../../lib/themes';
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
import { themePickerStyles as styles } from './styles';

export function ThemeStoreDialog({
  open,
  onClose,
  onThemesChanged,
}: {
  open: boolean;
  onClose: () => void;
  onThemesChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OpenVSXExtension[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Only the open transition needs a native call: closing unmounts the
    // <dialog> (via `if (!open) return null` below), so there is no element
    // left to `.close()`.
    if (open && !dialog.open) dialog.showModal();
  }, [open]);

  // The component stays mounted (rendering null) while closed, so search state
  // would otherwise persist — a reopen would flash the previous query, result
  // list, and any error banner. Reset to a clean slate when the store closes.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const doSearch = useCallback(async (value: string) => {
    if (!value.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await searchThemes(value, 0, 20);
      setResults(response.extensions);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleInstall = async (extension: OpenVSXExtension) => {
    const key = `${extension.namespace}/${extension.name}`;
    setInstalling(key);
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
      setInstalling(null);
    }
  };

  const handleRemoveExtension = (extensionId: string) => {
    const confirmed = window.confirm(`Remove installed themes from ${extensionId}?`);
    if (!confirmed) return;

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

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="fixed inset-0 z-50 m-auto h-[420px] w-[min(380px,calc(100vw-2rem))] rounded border p-0 font-mono shadow-2xl backdrop:bg-black/50"
      style={styles.panel}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b px-4 py-3" style={styles.border}>
          <span className="text-sm font-medium">Install theme from OpenVSX</span>
          <button
            type="button"
            onClick={onClose}
            className="text-sm transition-opacity hover:opacity-100"
            style={styles.muted}
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
            className="w-full rounded border px-3 py-1.5 text-sm outline-none placeholder:opacity-65"
            style={styles.trigger(false)}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-3">
          {error ? (
            <div className="rounded px-3 py-2 text-sm" style={styles.error}>
              {error}
            </div>
          ) : null}
          {loading ? <div className="py-8 text-center text-sm" style={styles.muted}>Searching...</div> : null}
          {!loading && results.length === 0 && query.trim() ? (
            <div className="py-8 text-center text-sm" style={styles.muted}>No themes found</div>
          ) : null}
          {!loading && !query.trim() ? (
            <div className="py-8 text-center text-sm" style={styles.muted}>
              Search for a VS Code theme to install
            </div>
          ) : null}
          {results.map((extension) => {
            const key = `${extension.namespace}/${extension.name}`;
            const installed = isInstalled(extension);
            const isInstallingThis = installing === key;
            return (
              <div key={key} className="flex items-center gap-3 rounded px-2 py-2 transition-colors hover:opacity-85">
                {extension.files?.icon ? (
                  <img src={extension.files.icon} alt="" className="h-8 w-8 shrink-0 rounded" />
                ) : (
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-sm"
                    style={{ ...styles.trigger(false), ...styles.muted }}
                  >
                    VS
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{extension.displayName || extension.name}</div>
                  <div className="truncate text-sm" style={styles.muted}>
                    {extension.namespace} - {extension.downloadCount.toLocaleString()} downloads
                  </div>
                </div>
                {installed ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveExtension(key)}
                    className="shrink-0 rounded px-2 py-1 text-sm transition-opacity hover:opacity-100"
                    style={styles.muted}
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleInstall(extension)}
                    disabled={isInstallingThis}
                    className="shrink-0 rounded px-2 py-1 text-sm transition-opacity hover:opacity-90 disabled:opacity-50"
                    style={styles.button}
                  >
                    {isInstallingThis ? 'Installing...' : 'Install'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
