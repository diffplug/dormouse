/**
 * Environment → {@link ServerConfig}. Pure and separate from `index.ts` so the
 * mapping is testable without binding a port or mutating `process.env`
 * (docs/specs/server.md, "Configuration").
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  return { port, bindHost, setupPassword, origin, stateDir, pocketDir };
}
