import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { setPlatform } from "dormouse-lib/lib/platform";
import { installPeerSurfaceResponder } from "dormouse-lib/remote/burrow/peer-surfaces";
import type { PlatformAdapter } from "dormouse-lib/lib/platform/types";
import { restoreWindowOrFresh } from "./window-restore";
import { isMainWindow, resolveWindowLabel } from "./window-label";
import { getWorkspacesSnapshot } from "dormouse-lib/lib/workspace-store";
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
  // First: several modules below key off which window this is, and the Rust
  // commands are all keyed by the invoking window's label.
  await resolveWindowLabel();
  const platform = await createPlatform();
  setPlatform(platform);
  await platform.init();
  // The Burrow runs in the sidecar, which owns the PTYs but not this
  // webview's view of them: what a pane is called, and how big its xterm is.
  // Installing the responder is what makes those answerable
  // (docs/specs/remote-api.md).
  //
  // After `init()`, not before: the responder asks the Burrow whether there is
  // one at all, and nothing could carry the answer back until the adapter has
  // its listeners. An ask that arrives in the gap goes unanswered, which is
  // what the Burrow's budget is for.
  installPeerSurfaceResponder();
  // Shell detection is a webview -> Rust -> sidecar round trip, so start it now
  // and await it below: it overlaps the dynamic imports and theme restore
  // rather than adding its latency to cold boot.
  const shellsPromise = platform.getAvailableShells();
  // Quit orchestrator (docs/specs/standalone.md §Quit flow). Tauri-only: the
  // browser-dev harness has no Rust quit interception, and quit.ts pulls the
  // Tauri APIs. !BROWSER_DEV_HOST is exactly the createPlatform branch that
  // returned a TauriAdapter.
  if (!BROWSER_DEV_HOST) {
    const [{ initQuitFlow, setQuitConfirmGate }, { openQuitConfirm }, { initWindowClose }] =
      await Promise.all([
        import("./quit"),
        import("./quit-confirm-store"),
        import("./window-close"),
      ]);
    const adapter = platform as import("./tauri-adapter").TauriAdapter;
    // The dialogs name a window by its visible Workspace, which is the only
    // name a user has for one (§Quit flow, "Confirmation dialog").
    const windowName = () => {
      const { workspaces, activeId } = getWorkspacesSnapshot();
      return workspaces.find((workspace) => workspace.id === activeId)?.name;
    };
    initQuitFlow(adapter, { windowName });
    initWindowClose(adapter, { windowName });
    // A quit or a close with ≥1 running command opens <QuitConfirmModalHost>.
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

  // A window Rust just built for a torn-out Workspace boots from the payload it
  // parked, not from disk: it has no snapshot yet (§Tear-out). Everything else
  // restores what the last run left.
  let initialPlans: Awaited<ReturnType<typeof restoreWindowOrFresh>> | null = null;
  if (!BROWSER_DEV_HOST) {
    const [{ bootFromTearOut, initWorkspaceMoves }, { initDropCaret }] = await Promise.all([
      import("./workspace-move"),
      import("./workspace-drop-caret"),
    ]);
    initialPlans = await bootFromTearOut(platform);
    initWorkspaceMoves(platform);
    initDropCaret();
  }
  initialPlans ??= await restoreWindowOrFresh(platform);

  // `main` is the only window holding `updater:*` and it is the last one the
  // quit walk tears down, so it is the only one that may check or install
  // (docs/specs/auto-update.md).
  if (isMainWindow()) startUpdateCheck();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppBar />
      <App
        initialPlans={initialPlans}
        baseboardNotice={<ConnectedUpdateBanner />}
        dialogHost={<QuitConfirmModalHost />}
        enableBurrow
        multiWorkspace
      />
    </StrictMode>,
  );
}

bootstrap();
