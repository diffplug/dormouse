import { invoke } from "@tauri-apps/api/core";
import { collectLivePtys, resumeOrRestoreFrom } from "dormouse-lib/lib/reconnect";
import { hydrateNotepadFromVolatile } from "dormouse-lib/lib/notepad/notepad-store";
import { getWallHandle } from "dormouse-lib/components/wall/wall-handles";
import { setWorkspaceBootPlan } from "dormouse-lib/components/wall/workspace-boot-plans";
import { wallBootFromResult, type WallBootPlans } from "dormouse-lib/components/wall/wall-types";
import type { WorkspaceTransferPayload } from "dormouse-lib/components/wall/workspace-transfer";
import {
  forgetWorkspaceSession,
  publishWorkspaceSession,
} from "dormouse-lib/lib/window-session-aggregator";
import {
  closeWorkspace,
  createWorkspace,
  getWorkspacesSnapshot,
  moveWorkspace,
  setActiveWorkspace,
} from "dormouse-lib/lib/workspace-store";
import type { PlatformAdapter } from "dormouse-lib/lib/platform/types";
import type { WorkspaceId } from "dormouse-lib/lib/session-types";
import { installWindowPersistence } from "./window-restore";
import { listenToWindow } from "./window-label";

/**
 * Moving a Workspace between Windows (`docs/specs/standalone.md` → "Transfer"
 * and "Tear-out"). Both halves live here, because they are one protocol:
 *
 * - **Source**: release the Workspace (its record, its notes, its Sessions
 *   detached but alive) and hand the payload to Rust.
 * - **Target**: arm a collector, tell Rust it is ready, resume over the PTYs
 *   whose ownership already moved, and mount the Workspace.
 *
 * Rust reassigns ownership *synchronously* when the source invokes, and
 * suppresses those PTYs' output until each one's replay has been emitted to the
 * target — so between the two halves no byte is painted twice and none is lost.
 */

/** Wire the payload up as one drop point, so both invokes carry the same shape. */
interface MovePayload extends WorkspaceTransferPayload {
  /** Where the pointer released, in the target window's logical client space.
   *  The target turns it into a strip index; it alone knows its own tabs. */
  at?: { x: number; y: number };
  /** Where the dragged tab should sit inside the new window, so it lands under
   *  the cursor. Rust turns it into the window's position, because only Rust
   *  knows where the cursor is on the screen. */
  grab?: { x: number; y: number };
}

/**
 * A replay is a whole 200k-char buffer per PTY crossing the sidecar's stdio, so
 * give an arrival more room than boot's 500 ms before giving up on one.
 */
const ARRIVAL_TIMEOUT_MS = 3000;

// --- Source ------------------------------------------------------------------

async function release(workspaceId: WorkspaceId): Promise<WorkspaceTransferPayload | null> {
  const handle = getWallHandle(workspaceId);
  if (!handle) return null;
  return handle.releaseWorkspaceForTransfer();
}

/** Hand this Workspace to a window that already exists. */
export async function transferWorkspaceTo(
  workspaceId: WorkspaceId,
  to: string,
  at: { x: number; y: number },
): Promise<void> {
  const payload = await release(workspaceId);
  if (!payload) return;
  try {
    await invoke("transfer_workspace", { to, payload: { ...payload, at } satisfies MovePayload });
  } catch (err) {
    console.error("[workspace-move] transfer failed", err);
  }
}

/** Tear this Workspace out into a new window under the cursor. */
export async function tearOutWorkspace(
  workspaceId: WorkspaceId,
  grab: { x: number; y: number },
): Promise<void> {
  const payload = await release(workspaceId);
  if (!payload) return;
  try {
    await invoke("open_workspace_window", { payload: { ...payload, grab } satisfies MovePayload });
  } catch (err) {
    console.error("[workspace-move] tear-out failed", err);
  }
}

// --- Target ------------------------------------------------------------------

/**
 * Resume the arriving Workspace's Sessions and build the plan its Wall mounts
 * from. `adopt_ready` is the hop that removes the "arrived before armed" bug
 * class: the host does not list or replay anything until the collector below is
 * listening.
 */
async function planArrival(
  platform: PlatformAdapter,
  payload: MovePayload,
): Promise<WallBootPlans[string]> {
  const ptyIds = new Set(payload.terminalIds);
  const live = await collectLivePtys(platform, {
    trigger: () => void invoke("adopt_ready").catch((err) =>
      console.error("[workspace-move] adopt_ready failed", err)),
    accept: (id) => ptyIds.has(id),
    timeoutMs: ARRIVAL_TIMEOUT_MS,
  });
  const result = resumeOrRestoreFrom(platform, live, {
    savedSession: payload.workspace.session,
    ptyIds,
  });
  // The notes travelled in the payload rather than through the archive: a move
  // is not a closure (`docs/specs/notepad.md` → "Closure").
  hydrateNotepadFromVolatile(payload.notepad, payload.allIds);
  // The AlertManager is per webview, so a persisted TODO has to be seeded into
  // this one — the source's went with its window.
  for (const pane of payload.workspace.session.panes) {
    if (pane.alert) platform.alertSeed?.(pane.id, pane.alert);
  }
  return wallBootFromResult(result);
}

/**
 * Where a drop lands in this window's strip: the index its tab takes. Undefined
 * appends, which is also what a drop past the last tab means.
 */
export function workspaceDropIndex(at: { x: number; y: number } | undefined): number | undefined {
  if (!at) return undefined;
  const tabs = [...document.querySelectorAll<HTMLElement>("[data-workspace-tab]")];
  for (const [index, tab] of tabs.entries()) {
    const rect = tab.getBoundingClientRect();
    if (at.x < rect.left + rect.width / 2) return index;
  }
  return undefined;
}

/** Mount an arriving Workspace and bring this window forward. */
async function adoptWorkspace(platform: PlatformAdapter, payload: MovePayload): Promise<void> {
  const { id, name, session } = payload.workspace;
  const plan = await planArrival(platform, payload);
  // Before `createWorkspace`, which mounts the Wall that reads it.
  setWorkspaceBootPlan(id, plan);
  // Before the store change too, so the Window blob it triggers already carries
  // the arriving Workspace's record rather than an empty one.
  publishWorkspaceSession(id, session);
  const index = workspaceDropIndex(payload.at);
  createWorkspace({ id, name });
  if (index !== undefined) moveWorkspace(id, index);
  setActiveWorkspace(id);
}

/**
 * The source's view of the departure. Rust emits it whichever way the Workspace
 * left, so this is the one place the source drops it.
 */
function handleDeparted(workspaceId: WorkspaceId): void {
  // Moving a Window's last Workspace away closes it — without confirming,
  // archiving or killing, because nothing ended: the Surfaces are alive
  // somewhere else (`docs/specs/standalone.md` → "Transfer").
  if (getWorkspacesSnapshot().workspaces.length <= 1) {
    forgetWorkspaceSession(workspaceId);
    void invoke("close_window_self").catch((err) =>
      console.error("[workspace-move] close_window_self failed", err));
    return;
  }
  closeWorkspace(workspaceId);
  forgetWorkspaceSession(workspaceId);
}

/** Listen for Workspaces arriving in, and leaving, this window. */
export function initWorkspaceMoves(platform: PlatformAdapter): void {
  void listenToWindow<MovePayload>("dormouse://workspace-arriving", (event) => {
    void adoptWorkspace(platform, event.payload).catch((err) =>
      console.error("[workspace-move] adoption failed", err));
  });
  void listenToWindow<{ workspaceId: WorkspaceId }>("dormouse://workspace-departed", (event) => {
    handleDeparted(event.payload.workspaceId);
  });
}

/**
 * Boot a window that was just torn out. Its payload is *pulled* rather than
 * pushed: an `emit_to` a window that does not exist yet is lost, so Rust parks
 * it and the new webview takes it here. Returns null for an ordinary window.
 */
export async function bootFromTearOut(platform: PlatformAdapter): Promise<WallBootPlans | null> {
  let payload: MovePayload | null = null;
  try {
    payload = await invoke<MovePayload | null>("take_boot_payload");
  } catch (err) {
    console.error("[workspace-move] take_boot_payload failed", err);
  }
  if (!payload?.workspace) return null;
  const { id, name, session } = payload.workspace;
  // Nothing on disk yet: this window's first aggregator flush writes its
  // snapshot, and from there it is an ordinary restorable window.
  installWindowPersistence(platform, { version: 1, workspaces: [{ id, name, session }], activeWorkspaceId: id });
  const plan = await planArrival(platform, payload);
  publishWorkspaceSession(id, session);
  return { [id]: plan };
}
