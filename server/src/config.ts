/**
 * Environment → {@link ServerConfig}. Pure and separate from `index.ts` so the
 * mapping is testable without binding a port or mutating `process.env`
 * (docs/specs/server.md, "Configuration").
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultVapidSubject, type VapidKeys } from './push.js';

/** Everything the entrypoint needs, resolved from the environment. */
export interface ServerConfig {
  port: number;
  /**
   * Interface to bind. `undefined` listens on every interface, which is what a
   * container wants; a host that fronts the server with a TLS proxy on the same
   * machine must set `DORMOUSE_BIND_HOST=127.0.0.1` so the plaintext port is not
   * reachable from the LAN or a tailnet.
   */
  bindHost: string | undefined;
  setupPassword: string;
  origin: string;
  stateDir: string;
  pocketDir: string;
  /**
   * The configured VAPID keypair, or `null` to mint and persist one on disk —
   * which is the entrypoint's job, not this pure mapping's.
   */
  vapidKeys: VapidKeys | null;
  /**
   * The operator contact the push JWT is signed with. `null` means push is off:
   * `web-push` cannot construct a send without a subject, and this server's own
   * origin is unusable as one on a loopback dev server.
   */
  vapidSubject: string | null;
}

/** Thrown for a missing or unusable environment; the entrypoint exits on it. */
export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function readConfig(env: Env = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535, got ${env.PORT}`);
  }

  const setupPassword = env.DORMOUSE_SETUP_PASSWORD;
  if (!setupPassword) {
    throw new ConfigError(
      'DORMOUSE_SETUP_PASSWORD is required — it gates account creation and host enrollment.',
    );
  }

  const bindHost = env.DORMOUSE_BIND_HOST?.trim() || undefined;
  const origin = env.DORMOUSE_ORIGIN ?? `http://localhost:${port}`;
  const stateDir = env.DORMOUSE_STATE_DIR ?? './data';

  // Default to `lib/dist-pocket` resolved from this compiled file's location
  // (server/dist/config.js → repo root two levels up), so it works regardless of
  // the process's cwd. Override with DORMOUSE_POCKET_DIR.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pocketDir = env.DORMOUSE_POCKET_DIR ?? join(repoRoot, 'lib', 'dist-pocket');

  // VAPID keys sign the push JWT and identify this server to every push service.
  // Supply both through env to control them; supply neither and the entrypoint
  // mints a pair once and persists it, so a selfhost POC needs no key ceremony.
  // Supplying exactly one is a misconfiguration, not a default worth guessing
  // at: the pair must match or every subscription silently stops working.
  const publicKey = env.DORMOUSE_VAPID_PUBLIC_KEY;
  const privateKey = env.DORMOUSE_VAPID_PRIVATE_KEY;
  if (!!publicKey !== !!privateKey) {
    throw new ConfigError(
      'DORMOUSE_VAPID_PUBLIC_KEY and DORMOUSE_VAPID_PRIVATE_KEY must be set together, or neither.',
    );
  }
  const vapidKeys = publicKey && privateKey ? { publicKey, privateKey } : null;
  // An unset subject falls back to this server's own origin, which
  // `defaultVapidSubject` refuses for a loopback dev server — there push is
  // switched off rather than left half-working, because a phone cannot route to
  // localhost anyway and a subject a push service rejects made every iPhone
  // delivery fail silently.
  const vapidSubject = env.DORMOUSE_VAPID_SUBJECT ?? defaultVapidSubject(origin);

  return {
    port,
    bindHost,
    setupPassword,
    origin,
    stateDir,
    pocketDir,
    vapidKeys,
    vapidSubject,
  };
}
