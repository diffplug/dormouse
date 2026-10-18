/**
 * Managed voice in the VS Code extension host (`docs/specs/vscode.md` ->
 * "Managed voice"): every window runs its own `createManagedVoiceHost`, the
 * one the standalone sidecar runs, over a store in `SecretStorage`. The token
 * is a bearer credential, and `SecretStorage` is the store whose changes every
 * window of the extension hears, so a sign-in or sign-out the broker's Burrow
 * service writes reaches every window's status, cache, and refusal latch.
 */

import type * as vscode from 'vscode';

import {
  createManagedVoiceHost,
  type ManagedVoiceCredential,
  type ManagedVoiceStore,
} from '../../lib/src/host/managed-voice-host';
import { bakedRelay } from '../../lib/src/host/relay-origin';
import type { ManagedVoiceStatus } from '../../lib/src/lib/platform/managed-voice-types';
import { log } from './log';

/** The voice token: a bearer credential, as the enrollment's `burrowToken` is. */
export const MANAGED_VOICE_TOKEN_KEY = 'dormouse.managed-voice.token';
/**
 * The member's voice. Not a credential: it rides `SecretStorage` only so a
 * choice in one window reaches the others, as the one-time serving marker does.
 */
export const MANAGED_VOICE_ID_KEY = 'dormouse.managed-voice.voice-id';

const KEYS = { token: MANAGED_VOICE_TOKEN_KEY, voiceId: MANAGED_VOICE_ID_KEY } as const;

/** Each field under a key of its own, so two windows writing different fields never lose one. */
export function secretManagedVoiceStore(secrets: vscode.SecretStorage): ManagedVoiceStore {
  return {
    async read() {
      const [token, voiceId] = await Promise.all([secrets.get(KEYS.token), secrets.get(KEYS.voiceId)]);
      return { token, voiceId };
    },
    async write(next, changed) {
      const value = next[changed];
      if (value === null) await secrets.delete(KEYS[changed]);
      else await secrets.store(KEYS[changed], value);
    },
  };
}

/** What this module needs from the router, injected as the Burrow's deps are. */
export interface ManagedVoiceDeps {
  /** Post to every live webview in this window. */
  broadcastStatus(status: ManagedVoiceStatus): void;
  /** Whether the network policy lets this window reach Hosted, asked at every speak. */
  networkAllowed(): Promise<boolean>;
}

let deps: ManagedVoiceDeps | null = null;
let host: ReturnType<typeof createManagedVoiceHost> | null = null;

export function configureManagedVoice(next: ManagedVoiceDeps): void {
  deps = next;
}

/** Build this window's host; its `SecretStorage` watch is the cross-window channel. */
export function initManagedVoice(context: vscode.ExtensionContext): vscode.Disposable {
  const voice = createManagedVoiceHost({
    store: secretManagedVoiceStore(context.secrets),
    onStatus: (status) => deps?.broadcastStatus(status),
    log: (message) => log.error(message),
    relay: bakedRelay(),
    networkAllowed: () => deps?.networkAllowed() ?? Promise.resolve(false),
  });
  host = voice;
  const watch = context.secrets.onDidChange?.((event) => {
    if (event.key === KEYS.token || event.key === KEYS.voiceId) voice.invalidate();
  });
  return {
    dispose() {
      watch?.dispose();
      if (host === voice) host = null;
    },
  };
}

/** A webview's `voice:command`; `null` where this window has no host. */
export function handleVoiceCommand(payload: unknown): Promise<unknown> {
  return host ? host.handle(payload) : Promise.resolve(null);
}

/** What the broker's Burrow service saves a sign-in's token through. */
export function managedVoiceCredential(): ManagedVoiceCredential | undefined {
  return host?.credential;
}
