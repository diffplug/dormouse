/**
 * Environment → {@link ServerConfig}. Pure and separate from `index.ts` so the
 * mapping is testable without binding a port or mutating `process.env`
 * (docs/specs/server.md, "Configuration").
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeOrigin } from 'server-lib-common';

import { defaultVapidSubject, type VapidKeys } from './push.js';
import { isSetupPassword } from './setup-password.js';

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
  /**
   * Demand a user-verified passkey assertion (biometric/PIN), not merely user
   * presence. Off by default because a deployment whose authenticators cannot
   * do UV would lock itself out; it is mirrored to every Host at enrollment so
   * the two sides cannot disagree about what a valid assertion is.
   */
  readonly requireUserVerification: boolean;
  /**
   * Absolute path the server records `{pid, releaseId, port}` into once it has
   * bound, so an installer can ask *which release is answering* without
   * reconstructing it from the process table. `null` — the default — writes
   * nothing, which is what a dev run, a container and every test want.
   * See `runtime-file.ts`.
   */
  runtimeFile: string | null;
  /**
   * Absolute path of the installer's `EnrollmentOffer`; `null` — the default —
   * refuses every `enrollToken`. See `enroll-token.ts` and, for the policy,
   * `docs/specs/server.md` → "Configuration".
   */
  enrollTokenFile: string | null;
  /**
   * The release directory's name, supplied by the installer's `run-server`
   * wrapper. `null` when the server was not started by an installer.
   */
  releaseId: string | null;
}

/** Thrown for a missing or unusable environment; the entrypoint exits on it. */
export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function readConfig(env: Env = process.env): ServerConfig {
  // Blank is unset, the way `DORMOUSE_BIND_HOST` reads it below. `Number('')` is
  // 0, which passes the range check and asks the OS for an ephemeral port — so
  // a `PORT=` left empty in a `.env` would silently move the server off 3000
  // and out from under the proxy in front of it. An explicit `PORT=0` is
  // refused for the same reason rather than honoured: nothing can be pointed at
  // a port that changes every restart.
  const rawPort = env.PORT?.trim() || undefined;
  const port = Number(rawPort ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got ${env.PORT}`);
  }

  const setupPassword = env.DORMOUSE_SETUP_PASSWORD;
  if (!isSetupPassword(setupPassword)) {
    throw new ConfigError(
      'DORMOUSE_SETUP_PASSWORD must be 64 lowercase hexadecimal characters ' +
        'generated from 32 random bytes — it gates host enrollment.',
    );
  }

  const bindHost = env.DORMOUSE_BIND_HOST?.trim() || undefined;
  // Opt-in, and only the exact string: an unset or misspelled value must read
  // as "off" rather than as "on", because turning this on without
  // UV-capable authenticators locks the account out of its own server.
  const requireUserVerification = env.DORMOUSE_REQUIRE_USER_VERIFICATION?.trim() === 'true';
  const origin = requireOrigin(env.DORMOUSE_ORIGIN?.trim() || `http://localhost:${port}`);
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

  // Installer-supplied, and absent everywhere else.
  const runtimeFile = installerPath(env, 'DORMOUSE_RUNTIME_FILE');
  const enrollTokenFile = installerPath(env, 'DORMOUSE_ENROLL_TOKEN_FILE');
  const releaseId = env.DORMOUSE_RELEASE_ID?.trim() || null;

  return {
    port,
    bindHost,
    requireUserVerification,
    setupPassword,
    origin,
    stateDir,
    pocketDir,
    vapidKeys,
    vapidSubject,
    runtimeFile,
    enrollTokenFile,
    releaseId,
  };
}

/**
 * `DORMOUSE_ORIGIN` reduced to a bare scheme-host-port, once, here — everything
 * downstream compares against this string rather than parsing it again. A
 * trailing slash or a path reads as correct in an `.env` and fails every one of
 * those compares, so it is normalized rather than refused; a value that is not
 * an http(s) URL with a host cannot be guessed at.
 */
function requireOrigin(raw: string): string {
  const origin = normalizeOrigin(raw);
  // The scheme too, not merely "has a host": `ws://…` reduces to a bare origin
  // and would boot the server on one no browser can ever send as
  // `clientData.origin`, failing every WebAuthn check with a valid-looking
  // config. (`origin` is bare here, so the prefix test is exact.)
  if (origin === null || !(origin.startsWith('http://') || origin.startsWith('https://'))) {
    throw new ConfigError(
      `DORMOUSE_ORIGIN must be an absolute URL with a host, e.g. https://dormouse.tailnet.ts.net, got '${raw}'.`,
    );
  }
  return origin;
}

/**
 * The installer-supplied absolute path at `env[name]`, or `null` when unset or
 * blank. A relative value is refused rather than resolved against the cwd: the
 * `run-server` wrapper runs under a service manager whose working directory is
 * not the installer's, so it would land somewhere neither side can predict.
 */
function installerPath(env: Env, name: string): string | null {
  const value = env[name]?.trim() || null;
  if (value !== null && !isAbsolute(value)) {
    throw new ConfigError(`${name} must be an absolute path, got '${value}'.`);
  }
  return value;
}
