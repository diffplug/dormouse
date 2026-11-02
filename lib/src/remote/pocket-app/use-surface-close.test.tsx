/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceCloseResult } from 'remote-lib-common';
import { MobileCloseDialog } from '../../components/MobileCloseDialog';
import { connectToolEditor, getEditorClosePrompt } from '../../lib/tool-editor';
import { recordToolDirty } from '../../lib/tool-dirty-store';
import { useSurfaceClose, type SurfaceCloseSession } from './use-surface-close';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let close: (id: string) => void;
let closingId: string | null;

function Harness({ session }: { session: SurfaceCloseSession }) {
  const result = useSurfaceClose(session);
  close = result.close;
  closingId = result.closing;
  return result.dialog ? <MobileCloseDialog state={result.dialog} /> : null;
}

/** A session answering these, in order, and recording what it was asked. */
function sessionAnswering(...answers: SurfaceCloseResult[]) {
  const asked: unknown[] = [];
  const session: SurfaceCloseSession = {
    request: vi.fn(async (_method: string, params?: unknown) => {
      asked.push(structuredClone(params));
      return answers.shift();
    }) as SurfaceCloseSession['request'],
  };
  return { session, asked };
}

const tick = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve); }));
const dialogTitle = () => document.querySelector('#mobile-close-title')?.textContent ?? null;
const press = async (label: string | RegExp) => {
  const button = [...document.querySelectorAll('button')].find((b) => {
    const name = b.getAttribute('aria-label') ?? b.textContent ?? '';
    return typeof label === 'string' ? name === label : label.test(name);
  });
  if (!button) throw new Error(`no button ${String(label)}`);
  await act(async () => button.click());
  await tick();
};

async function start(session: SurfaceCloseSession) {
  await act(async () => root.render(<Harness session={session} />));
  await act(async () => close('surface:1'));
  await tick();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  recordToolDirty('surface:1', null);
});

describe('useSurfaceClose', () => {
  it('asks nothing when the computer closes at once', async () => {
    const { session, asked } = sessionAnswering({ outcome: 'closed' });
    await start(session);
    expect(asked).toEqual([{ surfaceId: 'surface:1' }]);
    expect(dialogTitle()).toBeNull();
  });

  it('confirms with a tapped letter, in the desktop\'s words, then sends the consent', async () => {
    const { session, asked } = sessionAnswering({ outcome: 'confirm' }, { outcome: 'closed' });
    await start(session);
    expect(dialogTitle()).toBe('Confirm kill');
    expect(document.body.textContent).toMatch(/Tap [a-z] to confirm/);
    expect(document.querySelector('[aria-label^="Confirm with"]')?.textContent).not.toMatch(/[xku]/);
    await press(/^Confirm with/);
    expect(asked).toEqual([{ surfaceId: 'surface:1' }, { surfaceId: 'surface:1', confirmed: true }]);
    expect(dialogTitle()).toBeNull();
  });

  it('sends nothing more on Cancel', async () => {
    const { session, asked } = sessionAnswering({ outcome: 'confirm' });
    await start(session);
    await press('Cancel');
    expect(asked).toHaveLength(1);
    expect(dialogTitle()).toBeNull();
  });

  it('carries each consent onto the next ask, the unsaved choice after the confirmation', async () => {
    const { session, asked } = sessionAnswering({ outcome: 'confirm' }, { outcome: 'unsaved', label: 'notes.md' }, { outcome: 'closed' });
    await start(session);
    await press(/^Confirm with/);
    expect(dialogTitle()).toBe('Save changes?');
    expect(document.body.textContent).toContain('notes.md');
    await press('Discard');
    expect(asked[2]).toEqual({ surfaceId: 'surface:1', confirmed: true, unsaved: 'discard' });
  });

  it('shows the computer\'s refusal as it reads, and can close again after', async () => {
    const { session } = sessionAnswering({ outcome: 'refused', message: 'This terminal is already closing' }, { outcome: 'closed' });
    await start(session);
    expect(document.body.textContent).toContain('This terminal is already closing');
    await press('OK');
    expect(dialogTitle()).toBeNull();
    await act(async () => close('surface:1'));
    await tick();
    expect(session.request).toHaveBeenCalledTimes(2);
  });

  it('shows a failed request as a refusal', async () => {
    const session: SurfaceCloseSession = { request: vi.fn(async () => { throw new Error('session ended'); }) as SurfaceCloseSession['request'] };
    await start(session);
    expect(document.body.textContent).toContain('session ended');
  });

  it('asks about the phone\'s own unsaved edits first, which the computer cannot see', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const disconnect = connectToolEditor('surface:1', 'phone-copy.md', frame, 'https://frame.example');
    recordToolDirty('surface:1', true);
    const { session, asked } = sessionAnswering({ outcome: 'closed' });
    await start(session);
    expect(dialogTitle()).toBe('Save changes?');
    expect(document.body.textContent).toContain('phone-copy.md');
    expect(asked).toEqual([]);
    await press('Cancel');
    expect(asked).toEqual([]);

    await act(async () => close('surface:1'));
    await tick();
    await press('Discard');
    expect(asked).toEqual([{ surfaceId: 'surface:1' }]);
    disconnect();
    frame.remove();
  });

  it('keeps asking about its own edits until a save holds, then goes on', async () => {
    recordToolDirty('surface:1', true);
    const { session, asked } = sessionAnswering({ outcome: 'closed' });
    await start(session);
    // No editor answers, so this one cannot be saved from here.
    await press('Save');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Save this Tool in its own view');
    expect(asked).toEqual([]);
    recordToolDirty('surface:1', null);
    await press('Save');
    expect(asked).toEqual([{ surfaceId: 'surface:1' }]);
    expect(dialogTitle()).toBeNull();
  });

  it('holds its own edits\' dialog through Escape while a save is running', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const posted = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
    const disconnect = connectToolEditor('surface:1', 'phone-copy.md', frame, window.location.origin);
    const { connection } = posted.mock.calls[0]![0] as { connection: string };
    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { dorTool: 1, kind: 'state', connection, dirty: true },
    })));
    const { session, asked } = sessionAnswering({ outcome: 'closed' });
    await start(session);
    await press('Save');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await tick();
    expect(dialogTitle()).toBe('Save changes?');
    expect(asked).toEqual([]);
    disconnect();
    frame.remove();
  });

  it('names the Surface it is closing until the close ends, however it ends', async () => {
    const { session } = sessionAnswering({ outcome: 'confirm' }, { outcome: 'closed' });
    await start(session);
    expect(closingId).toBe('surface:1');
    await press(/^Confirm with/);
    expect(closingId).toBeNull();
    const refusing = sessionAnswering({ outcome: 'refused', message: 'no' });
    await start(refusing.session);
    expect(closingId).toBe('surface:1');
    await press('OK');
    expect(closingId).toBeNull();
  });

  it('goes with the wall, leaving nothing whose answer would reach the next Burrow', async () => {
    recordToolDirty('surface:1', true);
    const { session, asked } = sessionAnswering({ outcome: 'closed' });
    await start(session);
    expect(dialogTitle()).toBe('Save changes?');
    // Not the module-wide prompt, which would outlive this hook.
    expect(getEditorClosePrompt()).toBeNull();
    await act(async () => root.render(null));
    await tick();
    expect(dialogTitle()).toBeNull();
    expect(asked).toEqual([]);
  });
});
