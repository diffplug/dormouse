import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWallHandle, resetWallHandles, stubWallHandle } from 'dormouse-lib/components/wall/wall-handles';
import { closeWorkspace, createWorkspace, moveWorkspace, renameWorkspace, resetWorkspaces, setActiveWorkspace } from 'dormouse-lib/lib/workspace-store';
import { recordToolDirty, resetToolDirty } from 'dormouse-lib/lib/tool-dirty-store';
import { cancelEditorClose, decideEditorClose, getEditorClosePrompt } from 'dormouse-lib/lib/tool-editor';
import { createTeardownFlow, _resetTeardownArbiterForTesting, type TeardownFlow } from './teardown-flow';
import { _resetQuitConfirmForTesting } from './quit-confirm-store';

const invoke = vi.hoisted(() => vi.fn(async (_command: string) => {}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// A native teardown owns its scope from the first consent question, including
// the unsaved-editor gate that comes before the running-work dialog.
describe.each(['quit', 'close-window'] as const)('%s unsaved-editor consent', kind => {
  let flow: TeardownFlow;
  const proceed = vi.fn();
  const gate = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaces();
    resetWallHandles();
    _resetTeardownArbiterForTesting();
    _resetQuitConfirmForTesting();
    createWorkspace({ id: 'second', name: 'Second' });
    recordToolDirty('editor', true);
    registerWallHandle(stubWallHandle('workspace:1', { dirtyToolIds: () => ['editor'] }));
    flow = createTeardownFlow({ kind, ack: 'ack', cancelCommand: 'cancel', gate: () => gate,
      mustConfirm: () => false, proceed });
  });
  afterEach(() => {
    flow.reset();
    cancelEditorClose();
    resetToolDirty();
    resetWallHandles();
    _resetQuitConfirmForTesting();
  });

  it.each(['arrival', 'departure'] as const)('cancels on a Workspace %s before discard can authorize a changed scope', async change => {
    flow.request({ kind });
    expect(getEditorClosePrompt()).not.toBeNull();
    if (change === 'arrival') createWorkspace({ id: 'third' });
    else closeWorkspace('second');
    await decideEditorClose('discard');
    await settle();
    expect(invoke).toHaveBeenCalledWith('cancel');
    expect(getEditorClosePrompt()).toBeNull();
    expect(proceed).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    createWorkspace({ id: 'fourth' });
    expect(invoke.mock.calls.filter(([command]) => command === 'cancel')).toHaveLength(1);
  });

  it('keeps consent through rename, focus, and reorder, then stops watching after commitment', async () => {
    flow.request({ kind });
    const prompt = getEditorClosePrompt();
    renameWorkspace('second', 'Renamed');
    setActiveWorkspace('workspace:1');
    moveWorkspace('second', 0);
    expect(getEditorClosePrompt()).toBe(prompt);
    await decideEditorClose('discard');
    await settle();
    expect(proceed).toHaveBeenCalledOnce();
    createWorkspace({ id: 'third' });
    expect(invoke).not.toHaveBeenCalledWith('cancel');
  });

  it('releases the scope watch when another window cancels', async () => {
    flow.request({ kind });
    flow.reset();
    createWorkspace({ id: 'third' });
    await settle();
    expect(getEditorClosePrompt()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('cancel');
    expect(proceed).not.toHaveBeenCalled();
  });
});
