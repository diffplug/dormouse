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

async function createPlatform(): Promise<PlatformAdapter> {
  const browserDevHost = import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST as string | undefined;
  if (browserDevHost) {
    const [{ BrowserSidecarHost }, { BrowserSidecarAdapter }] = await Promise.all([
      import("./browser-sidecar-host"),
      import("./browser-sidecar-adapter"),
    ]);
    return new BrowserSidecarAdapter(new BrowserSidecarHost(browserDevHost));
  }
  const { TauriAdapter } = await import("./tauri-adapter");
  return new TauriAdapter();
}

// Await init() first to register event listeners before reconnecting
async function bootstrap() {
  const platform = await createPlatform();
  setPlatform(platform);
  await platform.init();
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
      />
    </StrictMode>,
  );
}
bootstrap();
