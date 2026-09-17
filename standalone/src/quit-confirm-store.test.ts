import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginQuitProgress,
  getQuitConfirmIntent,
  cancelQuit,
  dismissQuitConfirm,
  getQuitConfirmChar,
  getQuitConfirmWorkspaceNames,
  confirmQuit,
  getQuitArchiveError,
  getQuitConfirmPhase,
  openQuitArchiveFailure,
  openQuitConfirm,
  subscribeQuitConfirm,
  _resetQuitConfirmForTesting,
} from "./quit-confirm-store";

import { chromeKeyboardHeld } from '../../lib/src/components/wall/chrome-keyboard-lease';
import { createWorkspace, closeWorkspace, moveWorkspace, renameWorkspace, resetWorkspaces, setActiveWorkspace } from 'dormouse-lib/lib/workspace-store';
import { getWorkspaceUiSnapshot, resetWorkspaceUi, setPendingWorkspaceClose, setPendingWorkspaceMove, setRenamingWorkspace, setWorkspaceMoveError } from 'dormouse-lib/lib/workspace-ui-store';
import { isWorkspaceTransferPending, resetWindowSessionAggregator, setWorkspaceTransferPending } from 'dormouse-lib/lib/window-session-aggregator';

// The gate↔orchestrator seam itself is covered by quit.test.ts.
const makeCtx = () => ({ confirm: vi.fn(), cancel: vi.fn() });

describe("quit-confirm store", () => {
  beforeEach(() => {
    _resetQuitConfirmForTesting();
    resetWorkspaces();
    resetWorkspaceUi();
    resetWindowSessionAggregator();
  });
  afterEach(() => _resetQuitConfirmForTesting());

  it("opens with phase 'open' and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeQuitConfirm(listener);

    openQuitConfirm(makeCtx());

    expect(getQuitConfirmPhase()).toBe("open");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("cancel closes the dialog and calls ctx.cancel exactly once", () => {
    const ctx = makeCtx();
    openQuitConfirm(ctx);

    cancelQuit();
    expect(getQuitConfirmPhase()).toBeNull();
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
    expect(ctx.confirm).not.toHaveBeenCalled();

    // A repeat cancel is a no-op.
    cancelQuit();
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
  });

  it("confirm keeps the dialog up as 'quitting' and calls ctx.confirm exactly once", () => {
    const ctx = makeCtx();
    openQuitConfirm(ctx);

    confirmQuit();
    expect(getQuitConfirmPhase()).toBe("quitting");
    expect(ctx.confirm).toHaveBeenCalledTimes(1);

    // Double-confirm and late cancel are no-ops after the decision.
    confirmQuit();
    cancelQuit();
    expect(ctx.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.cancel).not.toHaveBeenCalled();
    expect(getQuitConfirmPhase()).toBe("quitting");
  });

  // The archive gate's phase (docs/specs/notepad.md → "Standalone quit").
  it("takes the archive-failed phase over a decision already made", () => {
    const first = makeCtx();
    openQuitConfirm(first);
    confirmQuit(); // the user said quit; the gate then refused

    const retry = makeCtx();
    openQuitArchiveFailure("disk is full", retry);

    expect(getQuitConfirmPhase()).toBe("archive-failed");
    expect(getQuitArchiveError()).toBe("disk is full");

    // Quit anyway reaches the gate's context, not the spent confirmation one.
    confirmQuit();
    expect(retry.confirm).toHaveBeenCalledTimes(1);
    expect(first.confirm).toHaveBeenCalledTimes(1);
    expect(getQuitConfirmPhase()).toBe("quitting");
    expect(getQuitArchiveError()).toBeNull();
  });

  it("opens the archive-failed phase from no dialog at all (an all-idle quit)", () => {
    const ctx = makeCtx();
    openQuitArchiveFailure("disk is full", ctx);

    cancelQuit();
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
    expect(getQuitConfirmPhase()).toBeNull();
    expect(getQuitArchiveError()).toBeNull();
  });

  it("ignores a redundant open while a dialog is already up", () => {
    const first = makeCtx();
    const second = makeCtx();
    openQuitConfirm(first);
    openQuitConfirm(second);

    confirmQuit();
    // The decision reaches the first request's context, not the ignored one.
    expect(first.confirm).toHaveBeenCalledTimes(1);
    expect(second.confirm).not.toHaveBeenCalled();
  });

  it('keeps its letter and captured scope through focus, reorder and rename', () => {
    const second = createWorkspace({ id: 'second', name: 'Second' });
    const ctx = makeCtx();
    openQuitConfirm(ctx);
    const char = getQuitConfirmChar();
    const names = getQuitConfirmWorkspaceNames();
    expect(char).toMatch(/^[a-z]$/);
    expect(names).toContain('Second');
    setActiveWorkspace('workspace-1');
    moveWorkspace(second.id, 0);
    renameWorkspace(second.id, 'Renamed');
    expect(getQuitConfirmChar()).toBe(char);
    expect(getQuitConfirmWorkspaceNames()).toBe(names);
    expect(ctx.cancel).not.toHaveBeenCalled();
  });

  it.each(['arrival', 'departure'])('cancels a pending decision on workspace %s', (change) => {
    createWorkspace({ id: 'second' });
    const ctx = makeCtx();
    openQuitConfirm(ctx);
    if (change === 'arrival') createWorkspace({ id: 'third' });
    else closeWorkspace('second');
    expect(ctx.cancel).toHaveBeenCalledExactlyOnceWith();
    expect(getQuitConfirmPhase()).toBeNull();
    expect(chromeKeyboardHeld()).toBe(false);
    createWorkspace({ id: 'fourth' });
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed or archive-failed decision through membership changes', () => {
    const ctx = makeCtx();
    openQuitConfirm(ctx);
    confirmQuit();
    createWorkspace({ id: 'second' });
    expect(ctx.cancel).not.toHaveBeenCalled();
    const archiveCtx = makeCtx();
    openQuitArchiveFailure('disk full', archiveCtx);
    closeWorkspace('second');
    expect(getQuitConfirmPhase()).toBe('archive-failed');
    expect(archiveCtx.cancel).not.toHaveBeenCalled();
    expect(chromeKeyboardHeld()).toBe(true);
    cancelQuit();
    expect(archiveCtx.cancel).toHaveBeenCalledOnce();
    expect(chromeKeyboardHeld()).toBe(false);
  });

  it.each(['confirm', 'archive'])('clears competing chrome when opening %s without dropping transfer guards', (kind) => {
    setPendingWorkspaceClose({ id: 'workspace-1', char: 'a' });
    setPendingWorkspaceMove({ id: 'workspace-1', char: 'b', iframeCount: 1, proceed: vi.fn() });
    setRenamingWorkspace('workspace-1');
    setWorkspaceMoveError({ id: 'workspace-1', reason: 'Wait for the Tool browser to connect' });
    setWorkspaceTransferPending('workspace-1', true);
    if (kind === 'confirm') openQuitConfirm(makeCtx());
    else openQuitArchiveFailure('disk full', makeCtx());
    expect(getWorkspaceUiSnapshot()).toEqual({ pendingClose: null, pendingMove: null, renamingId: null, moveError: null });
    expect(isWorkspaceTransferPending('workspace-1')).toBe(true);
    expect(chromeKeyboardHeld()).toBe(true);
  });

  it('holds one keyboard lease through commitment and releases it on matching dismissal', () => {
    openQuitConfirm(makeCtx(), { kind: 'close-window' });
    expect(chromeKeyboardHeld()).toBe(true);
    confirmQuit();
    expect(chromeKeyboardHeld()).toBe(true);
    dismissQuitConfirm('quit');
    expect(chromeKeyboardHeld()).toBe(true);
    dismissQuitConfirm('close-window');
    expect(chromeKeyboardHeld()).toBe(false);
    openQuitConfirm(makeCtx());
    _resetQuitConfirmForTesting();
    expect(chromeKeyboardHeld()).toBe(false);
  });


  it('owns an all-idle progress request and releases its lease on reset', () => {
    beginQuitProgress({ kind: 'close-window', discardsUpdate: true });
    expect(getQuitConfirmPhase()).toBe('quitting');
    expect(getQuitConfirmIntent()).toEqual({ kind: 'close-window', discardsUpdate: true });
    expect(chromeKeyboardHeld()).toBe(true);
    cancelQuit();
    expect(getQuitConfirmPhase()).toBe('quitting');
    _resetQuitConfirmForTesting();
    expect(getQuitConfirmPhase()).toBeNull();
    expect(chromeKeyboardHeld()).toBe(false);
  });

});
