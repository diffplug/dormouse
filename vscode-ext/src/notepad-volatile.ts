/**
 * The extension host's volatile notepad mirror (`docs/specs/notepad.md` →
 * Archive and Lifecycle).
 *
 * VS Code can destroy a webview without asking — an editor tab closed, a window
 * gone — so the close coordinator that normally archives a Surface's notes may
 * never run. Every webview therefore mirrors its live notes here, and a teardown
 * archives from the mirror instead.
 *
 * **Memory only, never a file.** Module state is cleared by an extension restart
 * by construction, which is the point: this is not a draft store, it is the
 * bridge across one disposal. It hydrates exactly one path — a live resume, a
 * webview re-resolved over PTYs this extension host still owns — never a cold
 * restore.
 */
import { readMirrorTerminalId, readNotepadArchive } from '../../lib/src/lib/notepad/archive-model';
import type {
  VolatileNotepadSnapshot,
  VolatileSurfaceNotes,
} from '../../lib/src/lib/notepad/types';
import { settleAllWithin } from '../../lib/src/lib/settle-within';
import { cwdFromProcessPath, processCwdMayReplace } from '../../lib/src/lib/terminal-state';

type StagedDeletions = VolatileNotepadSnapshot['stagedDeletions'];

/** Live notes by Surface id, so a resume can be handed exactly the ids its PTYs still have. */
const mirroredSurfaces = new Map<string, VolatileSurfaceNotes>();
/** Which router last reported each Surface, so a router's next snapshot can
 *  retire what it dropped without touching another webview's notes. */
const surfaceOwner = new Map<string, string>();
/** Archive deletions staged in each router's open Archive view. */
const stagedByRouter = new Map<string, StagedDeletions>();

const EMPTY_STAGED: StagedDeletions = Object.freeze({ deleteBatchIds: [], deleteNotes: [] });

/**
 * Keep only what the archive validator will read back.
 *
 * The webview is our own code, but what it mirrors here is written verbatim into
 * the archive by a teardown that has no webview left to ask, and one malformed
 * note would make the *whole* archive unreadable on the next load. Round-tripping
 * the batch this Surface would produce through the shared validator is the
 * cheapest way to be sure. The validator *rejects* unknown fields rather than
 * dropping them, which is what the webview sends anyway — `buildVolatileSnapshot`
 * maps every note through `toArchivedNote` and the CWD is the canonical
 * `CwdState` (`readNotepadArchive` in `lib/src/lib/notepad/archive-model.ts`).
 */
function sanitizeSurface(value: unknown): VolatileSurfaceNotes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const surface = value as Record<string, unknown>;
  if (typeof surface.surfaceId !== 'string' || !surface.surfaceId) return null;
  const archive = readNotepadArchive({
    version: 1,
    batches: [
      {
        id: 'probe',
        closedAt: 0,
        surfaceTitle: surface.surfaceTitle,
        surfaceKind: surface.surfaceKind,
        cwd: surface.cwd ?? null,
        notes: surface.notes ?? [],
      },
    ],
  });
  const batch = archive?.batches[0];
  if (!batch) return null;
  // Mirror-only, so it goes around the batch validator rather than through it: a
  // batch carrying this field would be rejected on the next load.
  const terminalId = readMirrorTerminalId(surface.terminalId);
  return {
    surfaceId: surface.surfaceId,
    surfaceTitle: batch.surfaceTitle,
    surfaceKind: batch.surfaceKind,
    cwd: batch.cwd,
    ...(terminalId ? { terminalId } : {}),
    notes: batch.notes,
  };
}

function sanitizeStaged(value: unknown): StagedDeletions {
  if (!value || typeof value !== 'object') return { deleteBatchIds: [], deleteNotes: [] };
  const staged = value as Record<string, unknown>;
  const deleteBatchIds = Array.isArray(staged.deleteBatchIds)
    ? staged.deleteBatchIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const deleteNotes: Array<{ batchId: string; noteId: string }> = [];
  if (Array.isArray(staged.deleteNotes)) {
    for (const entry of staged.deleteNotes) {
      if (!entry || typeof entry !== 'object') continue;
      const { batchId, noteId } = entry as Record<string, unknown>;
      if (typeof batchId !== 'string' || typeof noteId !== 'string') continue;
      deleteNotes.push({ batchId, noteId });
    }
  }
  return { deleteBatchIds, deleteNotes };
}

/**
 * Replace one router's whole contribution.
 *
 * A router reports its live Surfaces every time they change, so anything it
 * stops reporting has been closed through the ordinary path (already archived by
 * the webview) or replaced in place. Only what this router still owns is
 * retired: two webviews mirror into the same map, and one must never drop the
 * other's notes.
 */
export function setVolatileForRouter(routerId: string, snapshot: unknown): void {
  const raw = (snapshot ?? {}) as Record<string, unknown>;
  const surfaces: VolatileSurfaceNotes[] = [];
  if (Array.isArray(raw.surfaces)) {
    for (const entry of raw.surfaces) {
      const surface = sanitizeSurface(entry);
      if (surface) surfaces.push(surface);
    }
  }

  const next = new Set(surfaces.map((surface) => surface.surfaceId));
  for (const [id, owner] of surfaceOwner) {
    if (owner !== routerId || next.has(id)) continue;
    surfaceOwner.delete(id);
    mirroredSurfaces.delete(id);
  }
  for (const surface of surfaces) {
    mirroredSurfaces.set(surface.surfaceId, surface);
    surfaceOwner.set(surface.surfaceId, routerId);
  }
  stagedByRouter.set(routerId, sanitizeStaged(raw.stagedDeletions));
}

/** Remove and return the mirrored notes for these Surface ids. */
export function takeVolatileForSurfaces(ids: Iterable<string>): VolatileSurfaceNotes[] {
  const taken: VolatileSurfaceNotes[] = [];
  for (const id of ids) {
    const surface = mirroredSurfaces.get(id);
    if (!surface) continue;
    taken.push(surface);
    mirroredSurfaces.delete(id);
    surfaceOwner.delete(id);
  }
  return taken;
}

/** Every Surface this router currently owns. */
export function surfaceIdsForRouter(routerId: string): string[] {
  const ids: string[] = [];
  for (const [id, owner] of surfaceOwner) {
    if (owner === routerId) ids.push(id);
  }
  return ids;
}

/**
 * Take one router's staged archive deletions.
 *
 * Drained on *every* disposal, not only a killing one: the Archive view's
 * contract is that a deletion is irreversible once the window closes, and the
 * webview is the window. Left here they would reappear as still-pending in the
 * next resolve and then be committed hours later by `deactivate()`, with no
 * Undo left anywhere.
 */
export function takeStagedForRouter(routerId: string): StagedDeletions {
  const staged = stagedByRouter.get(routerId) ?? EMPTY_STAGED;
  stagedByRouter.delete(routerId);
  return staged;
}

/** Drain one router's mirror — what its disposal has to archive. */
export function takeVolatileForRouter(routerId: string): VolatileNotepadSnapshot {
  const surfaces = takeVolatileForSurfaces(surfaceIdsForRouter(routerId));
  return { surfaces, stagedDeletions: takeStagedForRouter(routerId) };
}

/**
 * Fill in the process CWD of every mirrored terminal Surface, while its PTY is
 * still alive.
 *
 * The mirror carries whatever CWD the webview last reported, which for a shell
 * with no CWD escapes is nothing at all — and a teardown archives it verbatim.
 * The PTY is still running at that moment, so the host asks it directly, exactly
 * as the session-save path does per pane. Pure: the caller archives what comes
 * back (`docs/specs/notepad.md` → "VS Code lifecycle").
 *
 * A Surface whose CWD came from shell integration keeps it, and is never even
 * asked — `processCwdMayReplace` is the same rule the webview side applies in
 * `updateCwdIfAllowed`. Bounded as one batch and best effort: on this path the
 * kill is waiting behind it.
 */
export async function refreshMirrorCwds(
  mirror: VolatileNotepadSnapshot,
  getCwd: (terminalId: string) => Promise<string | null>,
  boundMs: number,
): Promise<VolatileNotepadSnapshot> {
  const asking = mirror.surfaces.filter(
    (surface): surface is VolatileSurfaceNotes & { terminalId: string } => (
      !!surface.terminalId
      && surface.notes.length > 0
      && processCwdMayReplace(surface.cwd?.source)
    ),
  );
  const paths = await settleAllWithin(
    // `async` so a `getCwd` that throws outright is a rejection like any other.
    asking.map(async (surface) => getCwd(surface.terminalId)),
    boundMs,
    null,
  );
  const answered = new Map(asking.map((surface, index) => [surface.surfaceId, paths[index]]));
  const surfaces = mirror.surfaces.map((surface) => {
    const path = answered.get(surface.surfaceId);
    const cwd = path ? cwdFromProcessPath(path) : null;
    return cwd ? { ...surface, cwd } : surface;
  });
  return { ...mirror, surfaces };
}

/** Drain everything — what `deactivate()` has to archive. */
export function takeAllVolatile(): VolatileNotepadSnapshot {
  const surfaces = [...mirroredSurfaces.values()];
  mirroredSurfaces.clear();
  surfaceOwner.clear();
  const stagedDeletions = mergeStaged([...stagedByRouter.keys()]);
  stagedByRouter.clear();
  return { surfaces, stagedDeletions };
}

/**
 * The mirror a resuming webview boots with, for the pane ids of its saved
 * session — the same ids it claims recovery commands under.
 *
 * Non-destructive on purpose: a webview that is served this and then never comes
 * back (a crash between boot and its first sync) must still have its notes
 * archived by `deactivate()`. The resumed webview re-reports them under its own
 * router, which is what re-establishes ownership. Returns `null` when there is
 * nothing to hand over, so the boot payload matches the panel case exactly.
 *
 * Only the notes survive a disposal: the staged archive deletions behind them
 * were committed by it (`takeStagedForRouter`), so there is never anything
 * pending left to hand a resume.
 */
export function snapshotForLiveResume(liveSurfaceIds: Iterable<string>): VolatileNotepadSnapshot | null {
  const surfaces: VolatileSurfaceNotes[] = [];
  for (const id of liveSurfaceIds) {
    const surface = mirroredSurfaces.get(id);
    if (!surface) continue;
    surfaces.push(surface);
  }
  if (surfaces.length === 0) return null;
  return { surfaces, stagedDeletions: EMPTY_STAGED };
}

/** Deletions are archive-wide, so a resume inherits every staged set behind it. */
function mergeStaged(routerIds: readonly string[]): StagedDeletions {
  const deleteBatchIds = new Set<string>();
  const deleteNotes = new Map<string, { batchId: string; noteId: string }>();
  for (const routerId of routerIds) {
    const staged = stagedByRouter.get(routerId);
    if (!staged) continue;
    for (const id of staged.deleteBatchIds ?? []) deleteBatchIds.add(id);
    for (const ref of staged.deleteNotes ?? []) deleteNotes.set(`${ref.batchId} ${ref.noteId}`, ref);
  }
  return { deleteBatchIds: [...deleteBatchIds], deleteNotes: [...deleteNotes.values()] };
}
