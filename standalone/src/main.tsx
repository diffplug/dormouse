import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { setPlatform } from "mouseterm-lib/lib/platform";
import { resumeOrRestore } from "mouseterm-lib/lib/reconnect";
import { setDefaultShellOpts } from "mouseterm-lib/lib/shell-defaults";
import { restoreActiveTheme } from "mouseterm-lib/lib/themes";
import App from "mouseterm-lib/App";
import "mouseterm-lib/index.css";
import { TauriAdapter } from "./tauri-adapter";
import { UpdateBanner } from "./UpdateBanner";
import { UpdateDebugDialog } from "./UpdateDebugDialog";
import { AppBar, type ShellEntry } from "./AppBar";
import {
  startUpdateCheck,
  useUpdateState,
  dismissBanner,
  approveUpdate,
  openChangelog,
  buildDebugReport,
} from "./updater";

// Initialize Tauri platform adapter before rendering
const platform = new TauriAdapter();
setPlatform(platform);

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
        <UpdateDebugDialog
          open={true}
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

// Await init() first to register event listeners before reconnecting
async function bootstrap() {
  await platform.init();
  const { initAlertStateReceiver } = await import("mouseterm-lib/lib/terminal-registry");
  initAlertStateReceiver();
  restoreActiveTheme();

  // Fetch app bar data from Rust backend
  const detectedShells = await invoke<ShellEntry[]>("get_available_shells");
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
      />
    </StrictMode>,
  );
}
bootstrap();
