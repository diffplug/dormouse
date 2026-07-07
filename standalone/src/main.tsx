import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { setPlatform } from "dormouse-lib/lib/platform";
import type { PlatformAdapter } from "dormouse-lib/lib/platform/types";
import { resumeOrRestore } from "dormouse-lib/lib/reconnect";
import { setDefaultShellOpts } from "dormouse-lib/lib/shell-defaults";
import { restoreActiveTheme } from "dormouse-lib/lib/themes";
import App from "dormouse-lib/App";
import "dormouse-lib/index.css";
import { UpdateBanner } from "./UpdateBanner";
import { UpdateDebugModal } from "./UpdateDebugModal";
import { QuitConfirmModalHost } from "./QuitConfirmModal";
import { AppBar, type ShellEntry } from "./AppBar";
import {
  startUpdateCheck,
  useUpdateState,
  dismissBanner,
  approveUpdate,
  openChangelog,
  buildDebugReport,
} from "./updater";

function ConnectedUpdateBanner() {
  const state = useUpdateState();
  const [snapshot, setSnapshot] = useState<{ version: string; error?: string } | null>(null);
  const [body, setBody] = useState<string | null>(null);

  const liveFailure = state.status === 'post-update-failure' ? state : null;

  useEffect(() => {
    if (!snapshot || body) return;
    let cancelled = false;
    buildDebugReport(snapshot.error ?? '', snapshot.version).then((b) => {
      if (!cancelled) setBody(b);
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot, body]);

  return (
    <>
      <UpdateBanner
        state={state}
        onDismiss={dismissBanner}
        onApproveUpdate={approveUpdate}
        onOpenChangelog={openChangelog}
        onOpenDebug={() => {
          if (liveFailure) {
            setSnapshot({ version: liveFailure.version, error: liveFailure.error });
          }
        }}
      />
      {snapshot && (
        <UpdateDebugModal
          onClose={() => {
            setSnapshot(null);
            setBody(null);
          }}
          failure={snapshot}
          body={body}
        />
      )}
    </>
  );
}

const BROWSER_DEV_HOST = import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST as string | undefined;

async function createPlatform(): Promise<PlatformAdapter> {
  if (BROWSER_DEV_HOST) {
    const [{ BrowserSidecarHost }, { BrowserSidecarAdapter }] = await Promise.all([
      import("./browser-sidecar-host"),
      import("./browser-sidecar-adapter"),
    ]);
    return new BrowserSidecarAdapter(new BrowserSidecarHost(BROWSER_DEV_HOST));
  }
  const { TauriAdapter } = await import("./tauri-adapter");
  return new TauriAdapter();
}

// Await init() first to register event listeners before reconnecting
async function bootstrap() {
  const platform = await createPlatform();
  setPlatform(platform);
  await platform.init();
  // Quit orchestrator (docs/specs/standalone.md §Quit flow). Tauri-only: the
  // browser-dev harness has no Rust quit interception, and quit.ts pulls the
  // Tauri APIs. !BROWSER_DEV_HOST is exactly the createPlatform branch that
  // returned a TauriAdapter.
  if (!BROWSER_DEV_HOST) {
    const [{ initQuitFlow, setQuitConfirmGate }, { openQuitConfirm }] = await Promise.all([
      import("./quit"),
      import("./quit-confirm-store"),
    ]);
    initQuitFlow(platform as import("./tauri-adapter").TauriAdapter);
    // A quit with ≥1 running command opens <QuitConfirmModalHost>.
    setQuitConfirmGate(openQuitConfirm);
  }
  const { initAlertStateReceiver } = await import("dormouse-lib/lib/terminal-registry");
  initAlertStateReceiver();
  restoreActiveTheme();

  // Fetch app bar data from the active host backend.
  const detectedShells = await platform.getAvailableShells();
  const shells: ShellEntry[] = detectedShells.length > 0 ? detectedShells : [{ name: 'shell', path: '' }];
  const initialShell = shells[0];
  setDefaultShellOpts(initialShell ? { shell: initialShell.path, args: initialShell.args } : null);

  const result = await resumeOrRestore(platform);

  startUpdateCheck();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppBar shells={shells} />
      <App
        initialPaneIds={result.paneIds}
        restoredLayout={result.layout}
        initialDoors={result.doors}
        baseboardNotice={<ConnectedUpdateBanner />}
        dialogHost={<QuitConfirmModalHost />}
        enableRemoteHost
      />
    </StrictMode>,
  );
}
bootstrap();
