/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceCloseResult } from 'remote-lib-common';
import { MobileCloseDialog } from '../../components/MobileCloseDialog';
import { connectToolEditor } from '../../lib/tool-editor';
import { recordToolDirty } from '../../lib/tool-dirty-store';
import { useSurfaceClose, type SurfaceCloseSession } from './use-surface-close';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let close: (id: string) => void;

function Harness({ session }: { session: SurfaceCloseSession }) {
  const result = useSurfaceClose(session);
  close = result.close;
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
});
