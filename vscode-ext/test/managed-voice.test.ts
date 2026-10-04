/**
 * Managed voice across VS Code windows (`docs/specs/vscode.md` -> "Managed
 * voice"): each window's extension host runs its own voice host over one
 * shared `SecretStorage`, so a sign-in or sign-out the broker's Burrow service
 * writes reaches every window, and each keeps its own status, cache, and latch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { MANAGED_VOICES } from '../../lib/src/lib/platform/managed-voice-types';
import type { ManagedVoiceStatus } from '../../lib/src/lib/platform/managed-voice-types';

type ManagedVoiceModule = typeof import('../src/managed-voice');

const TOKEN = `dmv_${'A'.repeat(43)}`;

/** One `SecretStorage` every window shares, firing `onDidChange` in all of them. */
function sharedSecrets() {
  const values = new Map<string, string>();
  const watchers = new Set<(event: { key: string }) => void>();
  const announce = (key: string) => { for (const watcher of watchers) watcher({ key }); };
  const secrets = {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => { values.set(key, value); announce(key); },
    delete: async (key: string) => { values.delete(key); announce(key); },
    onDidChange: (watcher: (event: { key: string }) => void) => {
      watchers.add(watcher);
      return { dispose: () => void watchers.delete(watcher) };
    },
  } as unknown as vscode.SecretStorage;
  return { values, secrets };
}

/** One window: a fresh copy of the module, as each extension host loads its own. */
async function openWindow(secrets: vscode.SecretStorage) {
  vi.resetModules();
  const module = (await import('../src/managed-voice')) as ManagedVoiceModule;
  const statuses: ManagedVoiceStatus[] = [];
  module.configureManagedVoice({
    broadcastStatus: (status) => void statuses.push(status),
    networkAllowed: async () => true,
  });
  const disposable = module.initManagedVoice({ secrets } as vscode.ExtensionContext);
  return { module, statuses, disposable };
}

const opened: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const disposable of opened.splice(0)) disposable.dispose();
});

describe('managed voice in the VS Code extension host', () => {
  it('keeps the token in SecretStorage, never in a status, and a sign-in reaches every window', async () => {
    const { values, secrets } = sharedSecrets();
    const broker = await openWindow(secrets);
    const sibling = await openWindow(secrets);
    opened.push(broker.disposable, sibling.disposable);

    await broker.module.managedVoiceCredential()!.save(TOKEN);
    expect(values.get(broker.module.MANAGED_VOICE_TOKEN_KEY)).toBe(TOKEN);
    await vi.waitFor(() => expect(sibling.statuses.at(-1)).toMatchObject({ configured: true }));
    expect(await sibling.module.handleVoiceCommand({ op: 'status' })).toMatchObject({ configured: true });
    expect(JSON.stringify([broker.statuses, sibling.statuses])).not.toContain(TOKEN);
  });

  it('carries a voice choice and a sign-out to the other windows, field by field', async () => {
    const { values, secrets } = sharedSecrets();
    const broker = await openWindow(secrets);
    const sibling = await openWindow(secrets);
    opened.push(broker.disposable, sibling.disposable);
    await broker.module.managedVoiceCredential()!.save(TOKEN);

    const voiceId = MANAGED_VOICES[1]!.id;
    const brokerHeard = broker.statuses.length;
    const siblingHeard = sibling.statuses.length;
    expect(await sibling.module.handleVoiceCommand({ op: 'configure', update: { voiceId } })).toMatchObject({ ok: true, voiceId });
    await vi.waitFor(() => expect(broker.statuses.at(-1)).toMatchObject({ configured: true, voiceId }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Heard once: the choice changed nothing else, and the sibling's own write echoed nothing.
    expect(broker.statuses.length).toBe(brokerHeard + 1);
    expect(sibling.statuses.length).toBe(siblingHeard + 1);
    // Writing the voice left the token the broker wrote.
    expect(values.get(broker.module.MANAGED_VOICE_TOKEN_KEY)).toBe(TOKEN);

    await broker.module.managedVoiceCredential()!.clear();
    expect(values.has(broker.module.MANAGED_VOICE_TOKEN_KEY)).toBe(false);
    await vi.waitFor(() => expect(sibling.statuses.at(-1)).toEqual({ configured: false, voiceId, notEntitled: false }));
    expect(await sibling.module.handleVoiceCommand({ op: 'speak', text: 'build finished' }))
      .toEqual({ ok: false, reason: 'unconfigured' });
  });
});
