/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BurrowLink } from '../lib/platform/types';
import { makeEventedBurrowLink, oneTimeWaiting } from '../host/remote/test-burrow-link';
import type { OneTimeState } from '../remote/burrow/one-time-runtime';

let burrow: BurrowLink | undefined;

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({ burrow }),
}));

import { OneTimeIndicator } from './OneTimeIndicator';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let emit: (state: OneTimeState) => void = () => {};

/** A service holding `initial`, whose `oneTimeEnd` ends it as the real one does. */
function serve(initial: OneTimeState) {
  let state = initial;
  const command = vi.fn(async (cmd: string) => {
    if (cmd === 'oneTimeEnd') {
      emit({ status: 'ended', reason: 'user-ended' });
      return {};
    }
    return cmd === 'oneTimeStatus' ? state : null;
  });
  const link = makeEventedBurrowLink(command);
  emit = (next) => {
    state = next;
    link.emit('one-time', { name: 'one-time', state });
  };
  burrow = link;
  return command;
}

async function render() {
  await act(async () => root.render(<OneTimeIndicator />));
}

function endButton(): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="End the one-time connection"]');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  burrow = undefined;
});

describe('OneTimeIndicator', () => {
  it('renders nothing on a build with no Burrow service', async () => {
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('stays hidden until the phone has been allowed in', async () => {
    serve({ status: 'idle' });
    await render();
    for (const state of [
      oneTimeWaiting(),
      { status: 'confirming', label: 'Pixel 9', expiresAt: 1 },
      { status: 'ended', reason: 'direct-failed' },
    ] as OneTimeState[]) {
      await act(async () => emit(state));
      expect(container.innerHTML).toBe('');
    }

    await act(async () => emit({ status: 'connecting', label: 'Pixel 9' }));
    expect(container.textContent).toContain('Phone connecting…');
    await act(async () => emit({ status: 'connected', label: 'Pixel 9', since: 1 }));
    expect(container.textContent).toContain('Phone connected');
    expect(container.textContent).not.toContain('connecting');
  });

  it('names the phone in its tooltip, not in the Baseboard', async () => {
    serve({ status: 'connected', label: 'Pixel 9', since: 1 });
    await render();
    expect(container.textContent).not.toContain('Pixel 9');
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(
      'Pixel 9 has full control of your terminals.',
    );
  });

  it('ends the connection from End, and goes when it has', async () => {
    const command = serve({ status: 'connected', label: 'Pixel 9', since: 1 });
    await render();

    await act(async () => endButton()!.click());
    expect(command).toHaveBeenCalledWith('oneTimeEnd');
    expect(container.innerHTML).toBe('');
  });
});
