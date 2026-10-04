/**
 * The page's half of the UI watchdog (`docs/specs/standalone.md` → "UI
 * watchdog"): answer the host's probes, arm once booted, and say so when the
 * host restarted this page.
 *
 * The answer runs from an event listener on purpose: a page whose main thread
 * is stuck — a tight loop or an endless microtask chain — cannot run it, and
 * that silence is what the host reads as a hang.
 */
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { XIcon } from "@phosphor-icons/react";
import { listenToWindow } from "./window-label";

const BROWSER_DEV_HOST = Boolean(import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST);

export interface UiRestartNotice {
  seconds: number;
  samplePath: string | null;
}

let notice: UiRestartNotice | null = null;
const listeners = new Set<() => void>();

function setNotice(next: UiRestartNotice | null): void {
  notice = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Strictly after the restore and first render: a boot is not a hang. */
export async function armUiWatchdog(): Promise<void> {
  if (BROWSER_DEV_HOST) return;
  try {
    await listenToWindow("dormouse://ui-probe", () => {
      invoke("ui_probe_answer").catch(() => {});
    });
    await invoke("ui_watchdog_arm");
    setNotice(await invoke<UiRestartNotice | null>("take_ui_restart_notice"));
  } catch (err) {
    console.error("[dormouse] could not arm the UI watchdog", err);
  }
}

const linkClass = "shrink-0 hover:underline";
const linkStyle = { color: "var(--vscode-textLink-foreground)" };

export function UiRestartBanner() {
  const current = useSyncExternalStore(subscribe, () => notice);
  if (!current) return null;
  const { samplePath } = current;
  return (
    <span className="flex items-center gap-1.5 pb-1 text-sm font-mono text-muted">
      <span className="truncate" title={samplePath ?? undefined}>
        The UI stopped responding for {current.seconds}s and was restarted — terminals kept running
      </span>
      {samplePath && (
        <span className="contents">
          <span className="shrink-0">·</span>
          <button
            onClick={() => void navigator.clipboard.writeText(samplePath)}
            className={linkClass}
            style={linkStyle}
          >
            Copy diagnostics path
          </button>
        </span>
      )}
      <button
        onClick={() => setNotice(null)}
        className="shrink-0 rounded p-0.5 hover:bg-foreground/10 hover:text-foreground"
        aria-label="Dismiss"
      >
        <XIcon size={10} />
      </button>
    </span>
  );
}
