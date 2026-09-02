/**
 * Just enough raw CDP for the two things `agent-browser` cannot do: give the
 * Pocket page a virtual WebAuthn authenticator, and keep a record of everything
 * that page logs (`scripts/pairing-walkthrough/README.md` → The Pocket browser).
 *
 * The CLI has no raw-CDP verb, so this opens a WebSocket of its own to the page
 * target's `webSocketDebuggerUrl`. Chrome accepts that second client while
 * `agent-browser` stays attached, and the two never touch the same domain.
 */

import { waitFor } from './proc.mjs';

/** Every page target the browser at `port` currently has. */
async function pageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list answered ${res.status}`);
  return (await res.json()).filter((target) => target.type === 'page');
}

/**
 * A CDP connection to one target: `send` awaits the matching reply, and
 * everything the page logs accumulates in `messages`.
 *
 * **Held open for the whole run.** Chrome tears a domain's state down when the
 * client that enabled it goes away, and the virtual authenticator is exactly
 * that state — closing this socket would delete the passkey mid-ceremony.
 */
class CdpSession {
  #ws;
  #nextId = 1;
  #pending = new Map();

  /** Everything the page logged, in order, as `LEVEL text` lines. */
  messages = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method) {
        const line = describeLogEvent(message);
        if (line !== null) this.messages.push(line);
        return;
      }
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

/** One log line for a CDP event, or null for an event that is not one. */
function describeLogEvent({ method, params }) {
  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? `[${arg.type}]`)
      .join(' ');
    return `${params.type.toUpperCase()} ${text}`;
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails;
    return `EXCEPTION ${details.exception?.description ?? details.text} (${details.url ?? '?'})`;
  }
  if (method === 'Log.entryAdded') {
    return `${params.entry.level.toUpperCase()} ${params.entry.text} (${params.entry.url ?? '?'})`;
  }
  return null;
}

/**
 * Attach to the first page target `matches` accepts and start recording its log.
 *
 * **Attached before the app is opened**, so the record covers the first paint:
 * the target survives a same-tab navigation, which is what the `open` that
 * follows is. `agent-browser console` is not a substitute — it answers empty
 * for a browser it merely connected to.
 */
export async function attachPage(port, matches, what = 'a page target') {
  const target = await waitFor(
    async () => (await pageTargets(port)).find(matches) ?? null,
    { what, timeoutMs: 30_000, intervalMs: 250 },
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not open a CDP socket')), {
      once: true,
    });
  });
  const session = new CdpSession(ws);
  // Both: `Runtime` carries what the page's own code logs, `Log` carries what
  // the browser says about the page — a blocked request, a worker that would
  // not register.
  await session.send('Runtime.enable');
  await session.send('Log.enable');
  return session;
}

/**
 * Give `session`'s page an authenticator that answers every prompt by itself.
 *
 * Every option is load-bearing. `ctap2` + `internal` is a platform
 * authenticator, which is what a phone has; `hasResidentKey` is what
 * `residentKey: 'required'` in `webauthn.ts` demands; `hasUserVerification` +
 * `isUserVerified` make the assertion carry the UV bit; and
 * `automaticPresenceSimulation` is the missing finger — without it every
 * `navigator.credentials.*` call hangs until its own timeout.
 *
 * **The authenticator belongs to the target, not the browser.** A flow that
 * opens a new tab needs a session on that tab and this called again.
 */
export async function addVirtualAuthenticator(session) {
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
  return authenticatorId;
}

/** Where `session`'s page currently is, asked of the page rather than of `/json/list`. */
export async function pageUrl(session) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  return result.value;
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
