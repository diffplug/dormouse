/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cancelEditorClose, connectToolEditor, confirmToolEditorsClose, decideEditorClose, getEditorClosePrompt } from './tool-editor';
import { getToolDirty, recordToolDirty, resetToolDirty } from './tool-dirty-store';

let disconnect: (() => void) | undefined;
afterEach(async () => { await decideEditorClose('cancel'); disconnect?.(); resetToolDirty(); document.body.textContent = ''; vi.restoreAllMocks(); });

function editor() {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  disconnect = connectToolEditor('file', 'example.ts', frame, 'http://localhost:4000');
  const connection = post.mock.calls[0][0].connection;
  const emit = (data: Record<string, unknown>, origin = 'http://localhost:4000') => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow, origin, data: { dorTool: 1, connection, ...data },
  }));
  return { post, emit };
}

it('accepts editor state only from the bound frame, origin and connection', () => {
  const { emit } = editor();
  emit({ kind: 'ready', dirty: true }, 'https://elsewhere.test');
  emit({ kind: 'ready', dirty: true, connection: 'old' });
  expect(getToolDirty('file')).toBeNull();
  emit({ kind: 'ready', dirty: true });
  expect(getToolDirty('file')).toBe(true);
});

it('cancel preserves edits; discard permits only the requested close', async () => {
  recordToolDirty('file', true);
  const cancelled = confirmToolEditorsClose(['file']);
  await decideEditorClose('cancel'); expect(await cancelled).toBe(false);
  const discarded = confirmToolEditorsClose(['file']);
  await decideEditorClose('discard'); expect(await discarded).toBe(true);
  expect(getToolDirty('file')).toBe(true);
});

it('waits for save acknowledgement and refuses to close over newer edits', async () => {
  const { emit, post } = editor(); emit({ kind: 'ready', dirty: true });
  const close = confirmToolEditorsClose(['file']);
  const save = decideEditorClose('save');
  const request = post.mock.calls.at(-1)![0].request;
  emit({ kind: 'saved', request, dirty: true });
  await save;
  expect(getEditorClosePrompt()?.error).toMatch(/New edits/);
  const retry = decideEditorClose('save');
  emit({ kind: 'saved', request: post.mock.calls.at(-1)![0].request, dirty: false });
  await retry;
  expect(await close).toBe(true);
  expect(getEditorClosePrompt()).toBeNull();
});

it('leaves the prompt open when saving reports a disk conflict', async () => {
  const { emit, post } = editor(); emit({ kind: 'ready', dirty: true });
  const close = confirmToolEditorsClose(['file']);
  const save = decideEditorClose('save');
  emit({ kind: 'saved', request: post.mock.calls.at(-1)![0].request, dirty: true, error: 'Changed on disk' });
  await save;
  expect(getEditorClosePrompt()?.error).toBe('Changed on disk');
  await decideEditorClose('cancel'); expect(await close).toBe(false);
});

it('an externally cancelled save cannot settle or reopen a newer close prompt', async () => {
  const { emit, post } = editor(); emit({ kind: 'ready', dirty: true });
  const first = confirmToolEditorsClose(['file']);
  const saving = decideEditorClose('save');
  const request = post.mock.calls.at(-1)![0].request;
  cancelEditorClose();
  expect(await first).toBe(false);
  const second = confirmToolEditorsClose(['file']);
  const newer = getEditorClosePrompt();
  emit({ kind: 'saved', request, dirty: true, error: 'Late failure' });
  await saving;
  expect(getEditorClosePrompt()).toBe(newer);
  await decideEditorClose('cancel');
  expect(await second).toBe(false);
});

it('ignores an old preview frame after its replacement connects', () => {
  const first = editor(); first.emit({ kind: 'ready', dirty: false });
  const oldDisconnect = disconnect!;
  const second = editor(); second.emit({ kind: 'ready', dirty: true });
  first.emit({ kind: 'state', dirty: false });
  expect(getToolDirty('file')).toBe(true);
  oldDisconnect();
  second.emit({ kind: 'state', dirty: false });
  expect(getToolDirty('file')).toBe(false);
});
