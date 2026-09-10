import { invoke } from "@tauri-apps/api/core";
import { collectLivePtys, resumeOrRestoreFrom } from "dormouse-lib/lib/reconnect";
import { hydrateNotepadFromVolatile } from "dormouse-lib/lib/notepad/notepad-store";
import { getWallHandle } from "dormouse-lib/components/wall/wall-handles";
import { setWorkspaceBootPlan } from "dormouse-lib/components/wall/workspace-boot-plans";
import { wallBootFromResult, type WallBootPlans } from "dormouse-lib/components/wall/wall-types";
import type { PreparedWorkspaceTransfer, WorkspaceTransferPayload } from "dormouse-lib/components/wall/workspace-transfer";
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
import { workspaceDropTarget } from "./workspace-tabs";

/**
 * Moving a Workspace between Windows (`docs/specs/standalone.md` → "Transfer",
 * "Tear-out" and "Arrival queue"). Both halves live here, because they are one
 * protocol:
 *
 * - **Source**: build the payload, hand it to Rust, and release the Workspace
 *   (its record, its notes, its Sessions detached but alive) only once Rust has
 *   accepted it.
 * - **Target**: drain the arrival queue, arm a collector, tell Rust it is ready,
 *   resume over the PTYs whose ownership already moved, and mount the Workspace.
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

async function prepare(workspaceId: WorkspaceId): Promise<PreparedWorkspaceTransfer | null> {
  const handle = getWallHandle(workspaceId);
  if (!handle) return null;
  return handle.prepareWorkspaceTransfer();
}

/**
 * Hand the prepared Workspace to Rust, and release it here **only on success**.
 *
 * A rejected invoke is an ordinary state — the target window can close between
 * the drag's last probe and the drop — and Rust hands the PTYs back to this
 * window before it returns the error. Committing first would leave a Workspace
 * with no Sessions and no window that owns them.
 */
async function handOff(
  prepared: PreparedWorkspaceTransfer,
  command: string,
  args: Record<string, unknown>,
): Promise<void> {
  try {
    await invoke(command, args);
  } catch (err) {
    console.warn(`[workspace-move] ${command} refused; the Workspace stays here`, err);
    return;
  }
  prepared.commit();
}

/** Hand this Workspace to a window that already exists. */
export async function transferWorkspaceTo(
  workspaceId: WorkspaceId,
  to: string,
  at: { x: number; y: number },
): Promise<void> {
  const prepared = await prepare(workspaceId);
  if (!prepared) return;
  await handOff(prepared, "transfer_workspace", {
    to,
    payload: { ...prepared.payload, at } satisfies MovePayload,
  });
}

/** Tear this Workspace out into a new window under the cursor. */
export async function tearOutWorkspace(
  workspaceId: WorkspaceId,
  grab: { x: number; y: number },
): Promise<void> {
  const prepared = await prepare(workspaceId);
  if (!prepared) return;
  await handOff(prepared, "open_workspace_window", {
    payload: { ...prepared.payload, grab } satisfies MovePayload,
  });
}

// --- Target ------------------------------------------------------------------

/**
 * Resume the arriving Workspace's Sessions and build the plan its Wall mounts
 * from. `adopt_ready` is the hop that removes the "arrived before armed" bug
 * class: the host does not list or replay anything until the collector below is
 * listening.
 *
 * **Throws rather than cold-restoring when the host never answers.** An arrival
 * whose `pty:list` did not come back is not an arrival with no PTYs: those
 * shells are still running, and restoring from the record would start a second
 * set over them.
 */
async function planArrival(
  platform: PlatformAdapter,
  payload: MovePayload,
): Promise<WallBootPlans[string]> {
  const ptyIds = new Set(payload.terminalIds);
  const live = await collectLivePtys(platform, {
    // The token rides through Rust to the sidecar's `list` and comes back on the
    // answer, so two Workspaces arriving at once cannot finish on each other's.
    trigger: (requestId) => void invoke("adopt_ready", { requestId }).catch((err) =>
      console.error("[workspace-move] adopt_ready failed", err)),
    accept: (id) => ptyIds.has(id),
    timeoutMs: ARRIVAL_TIMEOUT_MS,
  });
  if (live.timedOut) {
    throw new Error(
      `the arriving Workspace's PTYs did not answer within ${ARRIVAL_TIMEOUT_MS}ms; `
      + "refusing rather than restarting shells that are still running",
    );
  }
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

/** Mount an arriving Workspace and bring this window forward. */
async function adoptWorkspace(platform: PlatformAdapter, payload: MovePayload): Promise<void> {
  const { id, name, session } = payload.workspace;
  const plan = await planArrival(platform, payload);
  // Before `createWorkspace`, which mounts the Wall that reads it.
  setWorkspaceBootPlan(id, plan);
  // Before the store change too, so the Window blob it triggers already carries
  // the arriving Workspace's record rather than an empty one.
  publishWorkspaceSession(id, session);
  // Where in this window's strip the pointer released. This window alone knows
  // its own tabs, which is why the source sends a point rather than an index.
  const index = payload.at ? workspaceDropTarget(payload.at.x).index : undefined;
  createWorkspace({ id, name });
  if (index !== undefined) moveWorkspace(id, index);
  setActiveWorkspace(id);
}

/**
 * Take everything Rust is holding for this window and mount it, oldest first.
 *
 * Drained rather than pushed: an `emit_to` a window with no listener yet is
 * lost, and a window still booting — or torn out moments ago — is a legal drop
 * target (`docs/specs/standalone.md` → "Arrival queue").
 */
async function drainArrivals(): Promise<MovePayload[]> {
  try {
    return (await invoke<MovePayload[] | null>("take_arrivals")) ?? [];
  } catch (err) {
    console.error("[workspace-move] take_arrivals failed", err);
    return [];
  }
}

/**
 * The source's view of the departure. Rust emits it whichever way the Workspace
 * left, once the target has actually asked for it.
 */
function handleDeparted(workspaceId: WorkspaceId): void {
  // Moving a Window's last Workspace away closes it — without confirming,
  // archiving or killing, because nothing ended: the Surfaces are alive
  // somewhere else (`docs/specs/standalone.md` → "Transfer").
  if (getWorkspacesSnapshot().workspaces.length <= 1) {
    forgetWorkspaceSession(workspaceId);
    void invoke("close_window").catch((err) =>
      console.error("[workspace-move] close_window failed", err));
    return;
  }
  closeWorkspace(workspaceId);
  forgetWorkspaceSession(workspaceId);
}

/** Listen for Workspaces arriving in, and leaving, this window. */
export function initWorkspaceMoves(platform: PlatformAdapter): void {
  const adoptQueued = async () => {
    for (const payload of await drainArrivals()) {
      await adoptWorkspace(platform, payload).catch((err) =>
        console.error("[workspace-move] adoption failed", err));
    }
  };
  void listenToWindow("dormouse://workspace-arriving", () => {
    void adoptQueued();
  });
  void listenToWindow<{ workspaceId: WorkspaceId }>("dormouse://workspace-departed", (event) => {
    handleDeparted(event.payload.workspaceId);
  });
  // Immediately, and not only on the nudge: a Workspace dropped on this window
  // while it was still booting is already in the queue, and its `emit_to`
  // reached no listener.
  void adoptQueued();
}

/**
 * Boot a window that was just torn out. Its payload is *pulled* rather than
 * pushed: an `emit_to` a window that does not exist yet is lost, so Rust queues
 * it and the new webview takes it here. Returns null for an ordinary window.
 */
export async function bootFromTearOut(platform: PlatformAdapter): Promise<WallBootPlans | null> {
  const [first, ...rest] = await drainArrivals();
  if (!first?.workspace) return null;
  const { id, name, session } = first.workspace;
  // Nothing on disk yet: this window's first aggregator flush writes its
  // snapshot, and from there it is an ordinary restorable window.
  installWindowPersistence(platform, { version: 1, workspaces: [{ id, name, session }], activeWorkspaceId: id });
  const plans: WallBootPlans = { [id]: await planArrival(platform, first) };
  publishWorkspaceSession(id, session);
  // A second Workspace dropped on this window between the tear-out and this
  // drain rides in the same queue.
  for (const payload of rest) {
    await adoptWorkspace(platform, payload).catch((err) =>
      console.error("[workspace-move] adoption failed", err));
  }
  return plans;
}
