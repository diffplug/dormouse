import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { setPlatform } from "dormouse-lib/lib/platform";
import type { PlatformAdapter } from "dormouse-lib/lib/platform/types";
import { resumeOrRestore } from "dormouse-lib/lib/reconnect";
import { seedShellStore } from "dormouse-lib/lib/shell-store";
import { restoreActiveTheme } from "dormouse-lib/lib/themes";
import App from "dormouse-lib/App";
import "dormouse-lib/index.css";
import { UpdateBanner } from "./UpdateBanner";
import { UpdateDebugModal } from "./UpdateDebugModal";
import { QuitConfirmModalHost } from "./QuitConfirmModal";
import { AppBar } from "./AppBar";
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
  // Shell detection is a webview -> Rust -> sidecar round trip, so start it now
  // and await it below: it overlaps the dynamic imports and theme restore
  // rather than adding its latency to cold boot.
  const shellsPromise = platform.getAvailableShells();
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

  // Seed the shell store from the active host backend: it restores the
  // persisted selection and publishes it as the default shell, and it feeds the
  // Settings dialog's Shell row. Must complete before resumeOrRestore/render so
  // the first restored pane already spawns with the selected shell. Detecting
  // nothing seeds nothing, which publishes no default — every spawn path then
  // omits `shell` and the sidecar resolves the OS default itself.
  seedShellStore(await shellsPromise);

  const result = await resumeOrRestore(platform);

  startUpdateCheck();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppBar />
      <App
        initialPaneIds={result.paneIds}
        restoredLathLayout={result.lathLayout}
        initialDoors={result.doors}
        initialSurfaceRefs={result.surfaceRefs}
        initialSurfaceRefsNext={result.surfaceRefsNext}
        baseboardNotice={<ConnectedUpdateBanner />}
        dialogHost={<QuitConfirmModalHost />}
        enableRemoteHost
      />
    </StrictMode>,
  );
}
bootstrap();
