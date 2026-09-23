/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import type { ManagedVoiceConfigUpdate, ManagedVoicePort, ManagedVoiceStatus } from '../lib/platform/managed-voice-types';
import { ManagedVoiceSection } from './ManagedVoiceSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = `dmv_${'B'.repeat(43)}`;
let container: HTMLDivElement;
let root: Root;
let stored: { token: string | null; voiceId: string };
let updates: ManagedVoiceConfigUpdate[];

function makePort(offerSetup = true): ManagedVoicePort {
  const status = (): ManagedVoiceStatus => ({ configured: stored.token !== null, voiceId: stored.voiceId });
  return {
    offerSetup,
    status: async () => status(),
    configure: async (update) => {
      updates.push(update);
      if ('token' in update) {
        if (update.token !== null && !update.token?.startsWith('dmv_')) return { ok: false, reason: 'invalid-token' };
        stored.token = update.token ?? null;
      }
      if (update.voiceId) stored.voiceId = update.voiceId;
      return { ok: true, ...status() };
    },
    speak: vi.fn(),
  };
}

const text = () => container.textContent ?? '';
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!;
const input = (type: string) => container.querySelector<HTMLInputElement>(`input[type="${type}"]`)!;

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function render(adapter: FakePtyAdapter) {
  setPlatform(adapter);
  await act(async () => root.render(<ManagedVoiceSection />));
  await act(async () => {});
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stored = { token: null, voiceId: 'defaultVoice' };
  updates = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('ManagedVoiceSection', () => {
  it('renders nothing where the host has no managed voice', async () => {
    await render(new FakePtyAdapter());
    expect(container.innerHTML).toBe('');
  });

  it('stays hidden on a public build until a token is configured', async () => {
    await render(Object.assign(new FakePtyAdapter(), { managedVoice: makePort(false) }));
    expect(container.innerHTML).toBe('');
  });

  it('shows on a public build once a token is configured', async () => {
    stored.token = TOKEN;
    await render(Object.assign(new FakePtyAdapter(), { managedVoice: makePort(false) }));
    expect(text()).toContain('Voice token configured.');
    await act(async () => button('Clear token').click());
    await act(async () => {});
    // Cleared on a public build: the section goes away with the token.
    expect(container.innerHTML).toBe('');
  });

  it('states what is sent before a token is configured, and never echoes the token back', async () => {
    const adapter = Object.assign(new FakePtyAdapter(), { managedVoice: makePort() });
    await render(adapter);
    expect(text()).toContain('Only the spoken pane label and voice id are sent to hosted.dormouse.sh');
    expect(text()).toContain("ElevenLabs' copy is usually deleted within seconds");

    await act(async () => type(input('password'), TOKEN));
    await act(async () => button('Use managed voice').click());
    await act(async () => {});

    expect(updates).toEqual([{ token: TOKEN }]);
    expect(text()).toContain('Voice token configured.');
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('shows the refusal for a malformed token', async () => {
    await render(Object.assign(new FakePtyAdapter(), { managedVoice: makePort() }));
    await act(async () => type(input('password'), 'sk-nope'));
    await act(async () => button('Use managed voice').click());
    await act(async () => {});
    expect(text()).toContain('That is not a voice token');
  });

  it('clears a configured token', async () => {
    stored.token = TOKEN;
    await render(Object.assign(new FakePtyAdapter(), { managedVoice: makePort() }));
    await act(async () => button('Clear token').click());
    await act(async () => {});
    expect(updates).toEqual([{ token: null }]);
    expect(input('password')).toBeTruthy();
  });

  it('commits the voice id on Enter, not per keystroke', async () => {
    await render(Object.assign(new FakePtyAdapter(), { managedVoice: makePort() }));
    const field = container.querySelector<HTMLInputElement>('input:not([type])')!;
    expect(field.value).toBe('defaultVoice');
    await act(async () => type(field, 'other1'));
    expect(updates).toEqual([]);
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await act(async () => {});
    expect(updates).toEqual([{ voiceId: 'other1' }]);
  });
});
