import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeftIcon } from '@phosphor-icons/react';
import {
  MODAL_OVERLAY_INSET,
  ModalCloseButton,
  ModalFrame,
  OVERLAY_MAX_HEIGHT,
  modalActionButton,
} from './design';
import {
  ensureArchiveLoaded,
  getArchiveSnapshot,
  messageOf,
  mutateArchive,
  refreshArchive,
  resetUnreadableArchive,
  subscribeToArchive,
} from '../lib/notepad/archive-service';
import { setStagedArchiveDeletions } from '../lib/notepad/notepad-store';
import { copyNote } from './use-notepad';
import { NoteList } from './NoteList';
import type { ArchiveBatch, ArchivedNote } from '../lib/notepad/types';
import { cwdDisplay } from '../lib/terminal-state';

const TITLE_ID = 'notepad-archive-title';


/**
 * Staged deletions, held only while this view is open (docs/specs/notepad.md ->
 * Archive). A note is keyed by its batch as well as its own id, because note ids
 * are only unique within a batch; the space separator is safe because both
 * halves are minted ids, and `splitNoteKey` splits on the first one either way.
 */
interface StagedDeletions {
  batchIds: ReadonlySet<string>;
  notes: ReadonlySet<string>;
}

const NOTHING_STAGED: StagedDeletions = { batchIds: new Set(), notes: new Set() };

function noteKey(batchId: string, noteId: string): string {
  return `${batchId} ${noteId}`;
}

function splitNoteKey(key: string): { batchId: string; noteId: string } {
  const gap = key.indexOf(' ');
  return { batchId: key.slice(0, gap), noteId: key.slice(gap + 1) };
}

function isAnythingStaged(staged: StagedDeletions): boolean {
  return staged.batchIds.size > 0 || staged.notes.size > 0;
}

/** The one shape both the mirror and the commit want. */
function stagedMutation(staged: StagedDeletions) {
  return {
    deleteBatchIds: [...staged.batchIds],
    deleteNotes: [...staged.notes].map(splitNoteKey),
  };
}

/** Built once: constructing an `Intl.DateTimeFormat` per batch per render is the
 *  expensive half of formatting a date. The locale is the host's, so a fixed
 *  timestamp still renders deterministically for a story or a snapshot. */
const CLOSED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatClosedAt(closedAt: number): string {
  return CLOSED_AT_FORMAT.format(new Date(closedAt));
}

/**
 * The archive as its own view, reached from the Settings dialog's Notepad
 * archive entry and returning there (docs/specs/notepad.md -> Archive). Wider
 * than Settings because a batch is a captured terminal excerpt, not a form row.
 *
 * Deletions are staged rather than applied: every one of them hides its target
 * immediately, and the whole set is committed as one mutation on the way out —
 * so Undo costs nothing and a failed write leaves the view exactly as it was.
 */
export function NotepadArchiveView({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const state = useSyncExternalStore(subscribeToArchive, getArchiveSnapshot);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [staged, setStaged] = useState<StagedDeletions>(NOTHING_STAGED);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  useEffect(() => {
    void ensureArchiveLoaded();
  }, []);

  // The VS Code extension host commits these on our behalf if the webview dies
  // before the view closes, so the mirror has to track every change rather than
  // only the final set (docs/specs/notepad.md -> Archive and Lifecycle).
  useEffect(() => {
    // Nothing staged mirrors as nothing at all, so a host cannot tell an
    // emptied set from a view that never staged anything.
    setStagedArchiveDeletions(isAnythingStaged(staged) ? stagedMutation(staged) : {});
  }, [staged]);
  useEffect(() => () => setStagedArchiveDeletions({}), []);

  /**
   * Leave, committing whatever is staged first. On failure the view stays put
   * with its staged set intact and the error inline: pressing Back or close
   * again is the retry, which is why nothing here is cleared on the way out.
   */
  const leave = useCallback(
    (after: () => void) => {
      if (committing) return;
      if (!isAnythingStaged(staged)) {
        after();
        return;
      }
      setCommitting(true);
      setCommitError(null);
      void mutateArchive(stagedMutation(staged)).then(
        () => {
          setStagedArchiveDeletions({});
          setStaged(NOTHING_STAGED);
          setCommitting(false);
          after();
        },
        (error: unknown) => {
          setCommitting(false);
          setCommitError(messageOf(error));
        },
      );
    },
    [committing, staged],
  );

  const back = useCallback(() => leave(onBack), [leave, onBack]);
  const close = useCallback(() => leave(onClose), [leave, onClose]);

  const deleteBatch = useCallback((batchId: string) => {
    setStaged((current) => ({
      batchIds: new Set(current.batchIds).add(batchId),
      notes: current.notes,
    }));
  }, []);

  const deleteNote = useCallback((batchId: string, noteId: string) => {
    setStaged((current) => ({
      batchIds: current.batchIds,
      notes: new Set(current.notes).add(noteKey(batchId, noteId)),
    }));
  }, []);

  // Newest first, notes in their original order within each batch. A batch left
  // with nothing visible goes with them, so deleting the last note of a batch
  // reads as deleting the batch.
  const visible = useMemo(() => {
    return state.archive.batches
      .filter((batch) => !staged.batchIds.has(batch.id))
      .map((batch) => ({
        batch,
        notes: batch.notes.filter((note) => !staged.notes.has(noteKey(batch.id, note.id))),
      }))
      .filter((entry) => entry.notes.length > 0)
      .sort((a, b) => b.batch.closedAt - a.batch.closedAt);
  }, [state.archive, staged]);

  return (
    <ModalFrame
      titleId={TITLE_ID}
      layer="app"
      padding="spacious"
      overlayClassName={MODAL_OVERLAY_INSET}
      // Only the list scrolls: an archive is unbounded, and Back / Undo / close
      // have to stay reachable however long it gets.
      className={`${OVERLAY_MAX_HEIGHT.modal} flex w-full max-w-[48rem] flex-col overflow-hidden`}
      initialFocusRef={closeRef}
      // Escape leaves the dialog entirely, as it does from Settings — Back is
      // the one control that returns there. It commits like every other exit.
      onEscape={close}
    >
      <div className="flex items-start gap-3">
        <h2 id={TITLE_ID} className="min-w-0 flex-1 text-sm leading-5 font-semibold text-foreground">
          Notepad archive
        </h2>
        <button
          type="button"
          className={`${modalActionButton()} flex items-center gap-1`}
          onClick={back}
          disabled={committing}
        >
          <ArrowLeftIcon size={11} weight="bold" />
          Back to Settings
        </button>
        <ModalCloseButton ref={closeRef} onClick={close} disabled={committing} />
      </div>

      {isAnythingStaged(staged) ? (
        <div className="mt-3 flex items-center gap-3 rounded bg-header-inactive-bg px-2.5 py-1.5 text-sm text-foreground">
          <span className="min-w-0 flex-1">
            Deletion is irreversible once this window closes.
          </span>
          <button
            type="button"
            className={modalActionButton()}
            onClick={() => setStaged(NOTHING_STAGED)}
            disabled={committing}
          >
            Undo
          </button>
        </div>
      ) : null}

      {commitError ? (
        <div role="alert" className="mt-3 text-sm leading-relaxed text-error">
          Those deletions could not be saved: {commitError}
        </div>
      ) : null}

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {/* `absent` renders nothing at all: it is both "this host has no
            archive" — which the Settings entry gates on, so it cannot be
            reached — and the frame before the first load lands. The chrome
            above still renders, so the dialog is never a dead end. */}
        {state.status === 'loading' ? (
          <div className="text-sm text-muted">Loading the archive…</div>
        ) : null}
        {state.status === 'unreadable' ? (
          <UnreadableArchive />
        ) : null}
        {state.status === 'error' ? (
          <div className="text-sm leading-relaxed text-foreground">
            <div role="alert" className="text-error">{state.error}</div>
            <button
              type="button"
              className={`${modalActionButton()} mt-2`}
              onClick={() => void refreshArchive()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {state.status === 'ready' ? (
          <ArchiveList
            entries={visible}
            emptyArchive={state.archive.batches.length === 0}
            busy={committing}
            onDeleteBatch={deleteBatch}
            onDeleteNote={deleteNote}
          />
        ) : null}
      </div>
    </ModalFrame>
  );
}

/**
 * Stored data validation rejected. The copy has one job beyond the apology: say
 * that nothing was replaced, because the single recovery offered here is the
 * only thing in the app that ever moves an archive aside.
 */
function UnreadableArchive() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recover = () => {
    setRunning(true);
    setError(null);
    void resetUnreadableArchive().then(
      () => setRunning(false),
      (failure: unknown) => {
        setRunning(false);
        setError(messageOf(failure));
      },
    );
  };

  return (
    <div className="text-sm leading-relaxed text-foreground">
      <div>
        The stored notepad archive could not be read. Nothing has been changed or
        replaced — the archived notes are still exactly as they were on disk.
      </div>
      <div className="mt-1 text-muted">
        Recovering moves that data aside, keeping a copy, and starts an empty
        archive. Until then nothing new can be archived.
      </div>
      <button
        type="button"
        className={`${modalActionButton({ tone: 'primary' })} mt-2`}
        onClick={recover}
        disabled={running}
      >
        Move it aside and start a new archive
      </button>
      {error ? (
        <div role="alert" className="mt-2 text-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

interface VisibleBatch {
  batch: ArchiveBatch;
  notes: ArchivedNote[];
}

function ArchiveList({
  entries,
  emptyArchive,
  busy,
  onDeleteBatch,
  onDeleteNote,
}: {
  entries: VisibleBatch[];
  /** Nothing has ever been archived, as opposed to everything being staged for
   *  deletion — the two empty lists want different copy. */
  emptyArchive: boolean;
  /** A commit is in flight. Staging during one would be dropped when the commit
   *  succeeds and resets the set, so the list goes inert instead. */
  busy: boolean;
  onDeleteBatch: (batchId: string) => void;
  onDeleteNote: (batchId: string, noteId: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="text-sm leading-relaxed text-muted">
        {emptyArchive
          ? 'Nothing archived yet. When a terminal or browser holding notes closes, its notes land here.'
          : 'Everything here is staged for deletion. Undo above brings it all back.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {entries.map((entry) => (
        <ArchiveBatchCard
          key={entry.batch.id}
          batch={entry.batch}
          notes={entry.notes}
          busy={busy}
          onDeleteBatch={onDeleteBatch}
          onDeleteNote={onDeleteNote}
        />
      ))}
    </div>
  );
}

function ArchiveBatchCard({
  batch,
  notes,
  busy,
  onDeleteBatch,
  onDeleteNote,
}: {
  batch: ArchiveBatch;
  notes: ArchivedNote[];
  busy: boolean;
  onDeleteBatch: (batchId: string) => void;
  onDeleteNote: (batchId: string, noteId: string) => void;
}) {
  // Rendered from the stored `CwdState`, never from a label persisted beside it:
  // the whole path and the remote host are what a batch is identified by weeks
  // later (docs/specs/terminal-state.md).
  const cwd = batch.cwd
    ? cwdDisplay(batch.cwd, { style: 'full', includeHost: 'always' })
    : null;

  return (
    <section className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-2">
        <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={batch.surfaceTitle}>
          {batch.surfaceTitle}
        </span>
        <span className="shrink-0 rounded bg-header-inactive-bg px-1 text-xs text-header-inactive-fg">
          {batch.surfaceKind}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {formatClosedAt(batch.closedAt)}
        </span>
        <button
          type="button"
          className={modalActionButton()}
          onClick={() => onDeleteBatch(batch.id)}
          disabled={busy}
        >
          Delete batch
        </button>
      </div>
      {cwd ? (
        <div className="mt-0.5 truncate text-xs text-muted" title={cwd}>
          {cwd}
        </div>
      ) : null}
      <div className="mt-2">
        {/* Read-only by construction: no `onEdit`, no `onRevealSource` — the
            markers a pin needs died with the terminal this came from. */}
        <NoteList
          notes={notes}
          onCopy={copyNote}
          onDelete={(note) => onDeleteNote(batch.id, note.id)}
          disabled={busy}
        />
      </div>
    </section>
  );
}
