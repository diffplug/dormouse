/**
 * The page's half of the UI watchdog (`docs/specs/standalone.md` → "UI
 * watchdog"): arm once the first render has committed, and say so when the
 * host restarted this page. The probe needs nothing here: the host evaluates a
 * script and waits for this page's main thread to run it.
 */
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeTextToClipboard } from "dormouse-lib/lib/clipboard";
import { BaseboardNotice } from "./BaseboardNotice";

interface UiRestartNotice {
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

/** Arms from an effect, so after the first commit: a boot is not a hang. */
export function UiWatchdogArm(): null {
  useEffect(() => {
    invoke<UiRestartNotice | null>("ui_watchdog_arm").then(
      // A repeat arm (StrictMode) answers null; it never clears a notice.
      (restarted) => { if (restarted) setNotice(restarted); },
      (err: unknown) => console.error("[dormouse] could not arm the UI watchdog", err),
    );
  }, []);
  return null;
}

export function UiRestartBanner() {
  const current = useSyncExternalStore(subscribe, () => notice);
  if (!current) return null;
  const { samplePath } = current;
  return (
    <BaseboardNotice
      message="The UI stopped responding and was restarted — terminals kept running"
      title={samplePath ?? undefined}
      links={samplePath ? [{ label: "Copy diagnostics path", onClick: () => void writeTextToClipboard(samplePath) }] : []}
      onDismiss={() => setNotice(null)}
    />
  );
}
