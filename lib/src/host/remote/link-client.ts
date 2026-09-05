/**
 * The webview's end of the Burrow service bridge, minus the transport.
 *
 * Every host that runs a Burrow service gives its webview the same
 * {@link BurrowLink}: commands out with a bounded wait for their result,
 * asks in with an answer that always comes back, and pushed events fanned to
 * whoever subscribed. What differs between the Tauri app, the browser dev
 * harness, and VS Code is only how a message travels — one Rust invoke, one dev
 * WebSocket, one `postMessage` — so that is the injected part and everything
 * else lives here. Three copies of the correlation and timeout rules is three
 * chances for one host to settle a command the others would not.
 *
 * The contract on the wire is `service-protocol.ts`; this is the client half of
 * it.
 */

import type { BurrowLink } from '../../lib/platform/types';
import type { BurrowCommand, BurrowResult } from './service-protocol';

/**
 * How long a command may wait for the service. Generous — `enroll` makes an
 * HTTP round trip to the Relay — but finite, so a sidecar that died or a
 * broker window that closed surfaces as a rejected promise instead of a hung
 * console call.
 */
export const BURROW_COMMAND_TIMEOUT_MS = 15_000;

/** How this host moves a message to the service. */
export interface BurrowLinkTransport {
  /** Send one command; its result arrives back through {@link BurrowLinkClient.onResult}. */
  sendCommand(cmd: BurrowCommand): void;
  /** Answer an outstanding ask. `askId` is the ask's own id, never a new one. */
  answerAsk(askId: string, results: unknown[]): void;
  /** Announce that future answers may differ. */
  notify(): void;
}

export interface BurrowLinkClient {
  link: BurrowLink;
  /** A `burrow:result` arrived. */
  onResult(payload: BurrowResult | undefined): void;
  /** A `burrow:ask` arrived; answering is this client's job, not the caller's. */
  onAsk(askId: string, op: string, params: unknown): void;
  /** A `burrow:event` arrived, carrying its own `name`. */
  onEvent(payload: unknown): void;
  /** The bridge is gone: nothing will ever answer what is outstanding. */
  dispose(): void;
}

/**
 * A short random component for this client's `burrowRequestId`s. Results are broadcast to
 * every webview the service can reach, so a plain counter would let two of them
 * mint the same id and settle each other's commands.
 */
function randomTag(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? uuid.slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

let envelopeSeq = 0;

/**
 * Wrap an answer as an ordinary command, for a transport with one channel to
 * the service (standalone's single passthrough invoke). The envelope's own
 * `burrowRequestId` is never answered — the ask's id travels in the params — so it only
 * has to exist.
 */
export function answerAskCommand(askId: string, results: unknown[]): BurrowCommand {
  return { burrowRequestId: `rh-tunnel-${++envelopeSeq}`, cmd: 'answer', params: { burrowRequestId: askId, results } };
}

/** {@link answerAskCommand}, for a notify — which carries nothing but its name. */
export function notifyCommand(): BurrowCommand {
  return { burrowRequestId: `rh-tunnel-${++envelopeSeq}`, cmd: 'notify' };
}

export function createBurrowLinkClient(
  transport: BurrowLinkTransport,
): BurrowLinkClient {
  interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, Pending>();
  const responders = new Map<string, (params: unknown) => unknown[]>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const tag = randomTag();
  let seq = 0;

  const link: BurrowLink = {
    command(cmd, params) {
      const burrowRequestId = `rh-${tag}-${++seq}`;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(burrowRequestId);
          reject(new Error(`burrow command timed out: ${cmd}`));
        }, BURROW_COMMAND_TIMEOUT_MS);
        pending.set(burrowRequestId, { resolve, reject, timer });
        transport.sendCommand({ burrowRequestId, cmd, params });
      });
    },

    respond(op, handler) {
      responders.set(op, handler);
    },

    notify() {
      transport.notify();
    },

    on(name, listener) {
      let named = listeners.get(name);
      if (!named) {
        named = new Set();
        listeners.set(name, named);
      }
      const subscribed = named;
      subscribed.add(listener);
      return () => {
        subscribed.delete(listener);
      };
    },
  };

  return {
    link,

    onResult(payload) {
      const settled = payload ? pending.get(payload.burrowRequestId) : undefined;
      if (!settled || !payload) return;
      pending.delete(payload.burrowRequestId);
      clearTimeout(settled.timer);
      if (typeof payload.error === 'string') settled.reject(new Error(payload.error));
      else settled.resolve(payload.result);
    },

    /**
     * Answer what this webview's own panes are called and how big they are.
     *
     * Always answer, even with no responder installed and even to say nothing:
     * the service settles once everyone has replied, so silence would make it
     * wait out the full budget on what is usually a miss. An empty answer claims
     * nothing, so it can never beat the real owner.
     */
    onAsk(askId, op, params) {
      const handler = responders.get(op);
      let results: unknown[] = [];
      try {
        results = handler ? handler(params) : [];
      } catch (error) {
        console.error(`[dormouse] burrow ask ${op} failed:`, error);
      }
      transport.answerAsk(askId, results);
    },

    onEvent(payload) {
      const name = (payload as { name?: unknown } | null)?.name;
      if (typeof name !== 'string') return;
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },

    dispose() {
      for (const settled of pending.values()) {
        clearTimeout(settled.timer);
        settled.reject(new Error('burrow bridge closed'));
      }
      pending.clear();
    },
  };
}
