/**
 * Just enough raw CDP for the one thing `agent-browser` cannot do: give the
 * Pocket page a virtual WebAuthn authenticator
 * (`scripts/pairing-walkthrough/README.md` → Stage (b) notes).
 *
 * The CLI has no raw-CDP verb, so this opens a WebSocket of its own to the page
 * target's `webSocketDebuggerUrl`. Chrome accepts that second client while
 * `agent-browser` stays attached, and the two never touch the same domain.
 */

import { waitFor } from './proc.mjs';

/** Every page target the browser at `port` currently has. */
export async function pageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list answered ${res.status}`);
  return (await res.json()).filter((target) => target.type === 'page');
}

/**
 * A CDP connection to one target, with `send` awaiting the matching reply.
 *
 * **Held open for the whole run.** Chrome tears a domain's state down when the
 * client that enabled it goes away, and the virtual authenticator is exactly
 * that state — closing this socket would delete the passkey mid-ceremony.
 */
export class CdpSession {
  #ws;
  #nextId = 1;
  #pending = new Map();

  constructor(ws, target) {
    this.#ws = ws;
    this.target = target;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${waiter.method})`));
      else waiter.resolve(message.result);
    });
    ws.addEventListener('close', () => {
      for (const waiter of this.#pending.values()) waiter.reject(new Error('CDP socket closed'));
      this.#pending.clear();
    });
  }

  static async attach(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('could not open a CDP socket')), {
        once: true,
      });
    });
    return new CdpSession(ws, target);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // Already gone.
    }
  }
}

/**
 * Give the page whose URL matches `urlPattern` a virtual authenticator that
 * answers every prompt by itself.
 *
 * Every option is load-bearing. `ctap2` + `internal` is a platform
 * authenticator, which is what a phone has; `hasResidentKey` is what
 * `residentKey: 'required'` in `webauthn.ts` demands; `hasUserVerification` +
 * `isUserVerified` make the assertion carry the UV bit; and
 * `automaticPresenceSimulation` is the missing finger — without it every
 * `navigator.credentials.*` call hangs until its own timeout.
 *
 * **The authenticator belongs to the target, not the browser.** A flow that
 * opens a new tab needs this called again for that tab.
 */
export async function installVirtualAuthenticator(port, urlPattern) {
  const target = await waitFor(
    async () => (await pageTargets(port)).find((t) => urlPattern.test(t.url)) ?? null,
    { what: `a page target matching ${urlPattern}`, timeoutMs: 30_000, intervalMs: 250 },
  );
  const session = await CdpSession.attach(target);
  await session.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { session, authenticatorId, targetId: target.id, targetUrl: target.url };
}

/**
 * What the virtual authenticator holds: one entry per registration, each
 * `signCount` counting the assertions made with it. Two authenticator
 * operations on a first run therefore read as one credential with a non-zero
 * count, which is the assertion the `code` step makes.
 */
export async function virtualCredentials({ session, authenticatorId }) {
  const { credentials } = await session.send('WebAuthn.getCredentials', { authenticatorId });
  return credentials.map((credential) => ({
    credentialId: credential.credentialId,
    isResidentCredential: credential.isResidentCredential,
    rpId: credential.rpId,
    signCount: credential.signCount,
  }));
}
