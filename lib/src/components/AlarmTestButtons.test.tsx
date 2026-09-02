/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let platform: { remoteHost?: unknown } = {};

vi.mock('../lib/platform', () => ({
  IS_MAC: false,
  getPlatform: () => platform,
}));

import { PushTestButton, SpeakTestButton } from './AlarmTestButtons';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function text(): string {
  return container.textContent ?? '';
}

function button(): HTMLButtonElement {
  const found = container.querySelector('button');
  if (!found) throw new Error('no button rendered');
  return found;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  platform = {};
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SpeakTestButton', () => {
  it('speaks and says so when the webview has a speech engine', async () => {
    const speak = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn() });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        constructor(public text: string) {}
      },
    );

    await act(async () => root.render(<SpeakTestButton />));
    await act(async () => button().click());

    expect(speak).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Speaking now');
  });

  it('says there is no speech engine rather than looking like it worked', async () => {
    // A webview with no backend and one with the volume down produce the same
    // observation, so silence has to be reported.
    vi.stubGlobal('speechSynthesis', undefined);

    await act(async () => root.render(<SpeakTestButton />));
    await act(async () => button().click());

    expect(text()).toContain('no speech engine');
  });
});

describe('PushTestButton', () => {
  it('renders nothing where there is no Host service', async () => {
    platform = {};
    await act(async () => root.render(<PushTestButton />));
    expect(container.innerHTML).toBe('');
  });

  it('reports a delivered push', async () => {
    platform = {
      remoteHost: {
        command: vi.fn(async () => ({ targeted: 2, delivered: 2, failed: 0 })),
        on: () => () => {},
        respond: () => {},
        notify: () => {},
      },
    };
    await act(async () => root.render(<PushTestButton />));
    await act(async () => button().click());

    expect(text()).toContain('Sent to 2 phones');
  });

  it('distinguishes "nowhere to send it" from a failure', async () => {
    platform = {
      remoteHost: {
        command: vi.fn(async () => ({ targeted: 0, delivered: 0, failed: 0 })),
        on: () => () => {},
        respond: () => {},
        notify: () => {},
      },
    };
    await act(async () => root.render(<PushTestButton />));
    await act(async () => button().click());

    expect(text()).toContain('No paired phone has push notifications turned on');
    // The ordinary answer on a freshly enrolled machine — not rendered as an error.
    expect(container.querySelector('[role="status"]')?.className).not.toContain('text-error');
  });

  it('reports a fan-out that reached nobody', async () => {
    platform = {
      remoteHost: {
        command: vi.fn(async () => ({ targeted: 2, delivered: 0, failed: 2 })),
        on: () => () => {},
        respond: () => {},
        notify: () => {},
      },
    };
    await act(async () => root.render(<PushTestButton />));
    await act(async () => button().click());

    expect(text()).toContain('No phone accepted the push');
  });

  it('names what a partly-failed fan-out reached, like every other outcome', async () => {
    platform = {
      remoteHost: {
        command: vi.fn(async () => ({ targeted: 3, delivered: 2, failed: 1 })),
        on: () => () => {},
        respond: () => {},
        notify: () => {},
      },
    };
    await act(async () => root.render(<PushTestButton />));
    await act(async () => button().click());

    expect(text()).toContain('Sent to 2 phones; 1 failed.');
  });

  it('surfaces the service error', async () => {
    platform = {
      remoteHost: {
        command: vi.fn(async () => {
          throw new Error('This machine is not connected to a Dormouse server.');
        }),
        on: () => () => {},
        respond: () => {},
        notify: () => {},
      },
    };
    await act(async () => root.render(<PushTestButton />));
    await act(async () => button().click());

    expect(text()).toContain('not connected to a Dormouse server');
  });
});
