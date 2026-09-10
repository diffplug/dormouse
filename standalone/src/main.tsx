import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { setPlatform } from "dormouse-lib/lib/platform";
import { installPeerSurfaceResponder } from "dormouse-lib/remote/burrow/peer-surfaces";
import type { PlatformAdapter } from "dormouse-lib/lib/platform/types";
import { collectLivePtys, resumeOrRestoreFrom } from "dormouse-lib/lib/reconnect";
import {
  installWindowSessionWriter,
  seedWindowSession,
} from "dormouse-lib/lib/window-session-aggregator";
import { setWorkspaces } from "dormouse-lib/lib/workspace-store";
import { DEFAULT_WORKSPACE_ID, windowPaneIds } from "dormouse-lib/lib/session-types";
import type { PersistedSession, WorkspaceId } from "dormouse-lib/lib/session-types";
import { wallBootFromResult, type WallBootPlans } from "dormouse-lib/components/wall/wall-types";
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

  const initialPlans = await restoreWindow(platform);

  startUpdateCheck();

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

/**
 * Rebuild the Window: install its Workspaces, then plan each one's Session off a
 * single view of the host's live PTYs (docs/specs/layout.md → "Session
 * persistence").
 *
 * Reload and relaunch are the same code path with a different live list. On a
 * reload the PTYs are still there and partition by saved pane id, so every
 * Workspace resumes over its own; on a relaunch the list is empty and every
 * Workspace cold-restores into fresh shells at its saved cwds, with nothing
 * replayed because scrollback is never persisted.
 */
async function restoreWindow(platform: PlatformAdapter): Promise<WallBootPlans> {
  const saved = platform.getWindowState?.() ?? null;
  // Before any Wall mounts: a Workspace's first save compares against its own
  // record, and a snapshot taken mid-boot must not replace a restored Workspace
  // with a blank one.
  seedWindowSession(saved);
  if (saved) {
    setWorkspaces({
      workspaces: saved.workspaces.map(({ id, name }) => ({ id, name })),
      activeId: saved.activeWorkspaceId,
    });
  }
  // After `setWorkspaces`, so installing does not immediately write back what was
  // just read.
  installWindowSessionWriter((snapshot) => platform.saveWindowState?.(snapshot));

  const live = await collectLivePtys(platform);
  const restoring: Array<{ id: WorkspaceId; session: PersistedSession | null }> =
    saved?.workspaces ?? [{ id: DEFAULT_WORKSPACE_ID, session: null }];
  const activeId = saved?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;

  // A live PTY no saved Workspace names — a pane created inside the last save's
  // debounce, or one left by a Workspace that is gone — goes to the active
  // Workspace rather than being stranded with no Wall.
  const liveIds = live.ptys.map((pty) => pty.id);
  const named = windowPaneIds(saved);
  const namedSet = new Set(named);
  const unowned = new Set(liveIds.filter((id) => !namedSet.has(id)));

  // The recovery claim is a host round trip started back in `init()`. Await it
  // only when something here can actually cold-restore: a Window whose every
  // saved pane is live resumes over those PTYs and never reads the record.
  const liveSet = new Set(liveIds);
  if (!named.every((id) => liveSet.has(id))) await platform.recoveryReady;

  const plans: WallBootPlans = {};
  for (const { id, session } of restoring) {
    const result = resumeOrRestoreFrom(platform, live, {
      savedSession: session,
      ptyIds: new Set(session?.panes.map((pane) => pane.id) ?? []),
      ...(id === activeId ? { claimUnowned: unowned } : {}),
    });
    plans[id] = wallBootFromResult(result);
  }
  return plans;
}
bootstrap();
