import { invoke } from "@tauri-apps/api/core";
import { releaseSession } from "dormouse-lib/lib/terminal-registry";
import { forgetHelper } from "dormouse-lib/lib/helper-terminal";
import { collectLivePtys, resumeOrRestoreFrom } from "dormouse-lib/lib/reconnect";
import { hydrateNotepadFromVolatile, removeSurface } from "dormouse-lib/lib/notepad/notepad-store";
import { getWallHandle } from "dormouse-lib/components/wall/wall-handles";
import { forgetWorkspaceBootPlan, setWorkspaceBootPlan } from "dormouse-lib/components/wall/workspace-boot-plans";
import { wallBootFromResult, type WallBootPlans } from "dormouse-lib/components/wall/wall-types";
import type { PreparedWorkspaceTransfer, WorkspaceTransferPayload } from "dormouse-lib/components/wall/workspace-transfer";
import {
  clearWorkspaceTransferring,
  forgetWorkspaceSession,
  markWorkspaceTransferring,
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
 * protocol, and the whole of it is **one transaction keyed by `workspaceId`**:
 * Rust holds an arrival record from the source's invoke until the target adopts
 * the Workspace or dies, and every step below either settles that record or
 * waits on it.
 *
 * - **Source**: build the payload, hand it to Rust, and mark the Workspace
 *   *transferring* — still mounted, still holding its Sessions, but in no
 *   snapshot this Window writes. It commits on `workspace-departed` and puts
 *   itself back on `workspace-arrival-failed`.
 * - **Target**: drain the arrivals, arm a collector, ask Rust for *that
 *   arrival's* PTYs, mount the Workspace, and call `adopt_done` — which is what
 *   releases the source.
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

/**
 * Workspaces this Window has handed over and not yet released, by id.
 *
 * **Nothing is released at the invoke.** The target can refuse the arrival, or
 * close before it takes it, and Rust hands the shells straight back — so the
 * Wall stays mounted, the notes stay put, and the only thing that changed here
 * is that the Workspace is in no snapshot (`markWorkspaceTransferring`).
 */
const inFlight = new Map<WorkspaceId, PreparedWorkspaceTransfer>();

async function prepare(workspaceId: WorkspaceId): Promise<PreparedWorkspaceTransfer | null> {
  const handle = getWallHandle(workspaceId);
  if (!handle) return null;
  return handle.prepareWorkspaceTransfer();
}

/**
 * Hand the prepared Workspace to Rust and mark it transferring **only on
 * success**.
 *
 * A rejected invoke is an ordinary state — the target window can close between
 * the drag's last probe and the drop — and Rust hands the PTYs back to this
 * window before it returns the error, so this Window is left exactly as it was.
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
  const { workspaceId } = prepared.payload;
  inFlight.set(workspaceId, prepared);
  markWorkspaceTransferring(workspaceId);
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

/**
 * The target adopted it: **the point of no return**. Detach every Session (never
 * kill one — they are running in the other Window now), drop the notes, and take
 * the Workspace out of the strip.
 */
function handleDeparted(workspaceId: WorkspaceId): void {
  const prepared = inFlight.get(workspaceId);
  if (!prepared) {
    console.warn("[workspace-move] a departure for a Workspace that was not in flight", workspaceId);
    return;
  }
  inFlight.delete(workspaceId);
  prepared.commit();
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

/**
 * The target never took it. Nothing was released, so there is nothing to put
 * back: drop the transferring mark and the Workspace is simply still here, its
 * xterms receiving output again the moment Rust unsuppresses them.
 */
function handleArrivalFailed(workspaceId: WorkspaceId, reason: string): void {
  if (!inFlight.delete(workspaceId)) return;
  clearWorkspaceTransferring(workspaceId);
  console.warn(`[workspace-move] ${workspaceId} was not adopted (${reason}); it stays here`);
}

// --- Target ------------------------------------------------------------------

/**
 * Workspaces this Window is mounting right now. `take_arrivals` answers with
 * every record still in flight — the boot drain and the listener drain overlap
 * by design — so the same payload can be handed over twice before `adopt_done`
 * has retired it.
 */
const adopting = new Set<WorkspaceId>();

/**
 * Resume the arriving Workspace's Sessions and build the plan its Wall mounts
 * from. `adopt_ready` is the hop that removes the "arrived before armed" bug
 * class: the host does not list or replay anything until the collector below is
 * listening, and it answers with **exactly this arrival's** PTYs, so two
 * Workspaces landing at once cannot resume over each other's.
 *
 * **Throws rather than cold-restoring when the host never answers.** An arrival
 * whose `pty:list` did not come back is not an arrival with no PTYs: those
 * shells are still running, and restoring from the record would start a second
 * set over them. Every caller turns the throw into `adopt_failed`.
 */
async function planArrival(
  platform: PlatformAdapter,
  payload: MovePayload,
): Promise<WallBootPlans[string]> {
  // Seed the older persisted state before replay re-derives a running watch.
  for (const pane of payload.workspace.session.panes) {
    if (pane.alert) platform.alertSeed?.(pane.id, pane.alert);
  }
  const ptyIds = new Set(payload.terminalIds);
  const live = await collectLivePtys(platform, {
    // The token rides through Rust to the sidecar's `list` and comes back on the
    // answer, so two Workspaces arriving at once cannot finish on each other's.
    trigger: (requestId) =>
      void invoke("adopt_ready", { workspaceId: payload.workspaceId, requestId }).catch((err) =>
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
  return wallBootFromResult(result);
}

/** Settle one arrival with Rust, whichever way it went. */
function settle(command: "adopt_done" | "adopt_failed", workspaceId: WorkspaceId, reason?: string): void {
  void invoke(command, { workspaceId, ...(reason === undefined ? {} : { reason }) }).catch((err) =>
    console.error(`[workspace-move] ${command} failed`, err));
}

/** Mount an arriving Workspace, then release its source. */
async function adoptWorkspace(platform: PlatformAdapter, payload: MovePayload): Promise<void> {
  const { id, name, session } = payload.workspace;
  if (adopting.has(id)) return;
  adopting.add(id);
  try {
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
    // Last, and only now: it is what tells the source to let the Workspace go.
    // Awaited, because a refusal is the one signal that the transaction was
    // retired underneath this window.
    try {
      await invoke("adopt_done", { workspaceId: id });
    } catch (err) {
      console.error("[workspace-move] adopt_done refused; unwinding the mount", err);
      await unwindAdoption(id);
    }
  } catch (err) {
    console.error("[workspace-move] adoption failed; handing the Workspace back", err);
    settle("adopt_failed", id, err instanceof Error ? err.message : String(err));
  } finally {
    adopting.delete(id);
  }
}

/**
 * `adopt_done` was refused: the `ARRIVAL_MAX` watchdog had already expired the
 * record and handed the shells back, and the source cleared its transferring
 * mark and kept the Workspace. Left mounted here too, the same Workspace would
 * be live in two windows and persisted by both — the next launch restoring it
 * twice over one set of PTYs. Take it out the way a departure does: the
 * Sessions released, **never killed**, because the shells are the source's
 * again; the notes dropped; the record and the parked plan forgotten.
 */
async function unwindAdoption(id: WorkspaceId): Promise<void> {
  const handle = getWallHandle(id);
  if (handle) (await handle.prepareWorkspaceTransfer()).commit();
  closeWorkspace(id);
  forgetWorkspaceSession(id);
  forgetWorkspaceBootPlan(id);
}

/**
 * Every Workspace Rust is still holding for this window.
 *
 * Drained rather than pushed: an `emit_to` a window with no listener yet is
 * lost, and a window still booting — or torn out moments ago — is a legal drop
 * target (`docs/specs/standalone.md` → "Arrival queue"). The answer is not
 * consumed by the drain, so `adopting` is what keeps one from being mounted
 * twice.
 */
async function drainArrivals(): Promise<MovePayload[]> {
  try {
    return (await invoke<MovePayload[] | null>("take_arrivals")) ?? [];
  } catch (err) {
    console.error("[workspace-move] take_arrivals failed", err);
    return [];
  }
}

/** Listen for Workspaces arriving in, and leaving, this window. */
export function initWorkspaceMoves(platform: PlatformAdapter): void {
  const adoptQueued = async () => {
    for (const payload of await drainArrivals()) await adoptWorkspace(platform, payload);
  };
  void listenToWindow("dormouse://workspace-arriving", () => {
    void adoptQueued();
  });
  void listenToWindow<{ workspaceId: WorkspaceId }>("dormouse://workspace-departed", (event) => {
    handleDeparted(event.payload.workspaceId);
  });
  void listenToWindow<{ workspaceId: WorkspaceId; reason?: string }>(
    "dormouse://workspace-arrival-failed",
    (event) => handleArrivalFailed(event.payload.workspaceId, event.payload.reason ?? "no reason given"),
  );
  // Immediately, and not only on the nudge: a Workspace dropped on this window
  // while it was still booting is already in the queue, and its `emit_to`
  // reached no listener.
  void adoptQueued();
}

/**
 * Boot a window that was just torn out. Its payload is *pulled* rather than
 * pushed: an `emit_to` a window that does not exist yet is lost, so Rust queues
 * it and the new webview takes it here. Returns null for an ordinary window —
 * and for a tear-out whose Workspace could not be resumed, which then boots
 * fresh rather than blank.
 */
export async function bootFromTearOut(platform: PlatformAdapter): Promise<WallBootPlans | null> {
  // A window with a snapshot is an ordinary one restoring itself, even if
  // something was dropped on it while it booted: that arrival is mounted by
  // `initWorkspaceMoves`, over the Window this restores.
  if (platform.getWindowState?.()) return null;
  const [first, ...rest] = await drainArrivals();
  if (!first?.workspace) return null;
  const { id, name, session } = first.workspace;
  adopting.add(id);
  let plan: WallBootPlans[string];
  try {
    plan = await planArrival(platform, first);
  } catch (err) {
    // Never into `bootstrap()`: the caller falls back to a fresh Window, which
    // is a window the user can use rather than a blank one. Anything else in
    // the queue is left for `initWorkspaceMoves` to drain over it.
    console.error("[workspace-move] the torn-out Workspace could not be resumed", err);
    settle("adopt_failed", id, err instanceof Error ? err.message : String(err));
    adopting.delete(id);
    return null;
  }
  try {
    await invoke("adopt_done", { workspaceId: id });
  } catch (err) {
    console.error("[workspace-move] torn-out adoption refused; starting fresh", err);
    for (const surfaceId of first.allIds) {
      removeSurface(surfaceId);
      forgetHelper(surfaceId);
    }
    for (const terminalId of first.terminalIds) releaseSession(terminalId);
    adopting.delete(id);
    return null;
  }
  // Nothing on disk yet: this window's first aggregator flush writes its
  // snapshot, and from there it is an ordinary restorable window. After the
  // plan, so a refused arrival leaves no half-installed Window behind.
  installWindowPersistence(platform, { version: 1, workspaces: [{ id, name, session }], activeWorkspaceId: id });
  publishWorkspaceSession(id, session);
  adopting.delete(id);
  // A second Workspace dropped on this window between the tear-out and this
  // drain rides in the same queue.
  for (const payload of rest) await adoptWorkspace(platform, payload);
  return { [id]: plan };
}

/** @internal Forget what this window is moving (tests). */
export function _resetWorkspaceMovesForTesting(): void {
  inFlight.clear();
  adopting.clear();
}
