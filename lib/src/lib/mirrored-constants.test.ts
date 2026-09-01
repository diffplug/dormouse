import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enrollmentOfferPath } from '../host/remote/enroll-offer';
import { ITERM2_COMPAT_VERSION } from './terminal-protocol';
import { OPEN_PORT_TIMEOUT_MS } from './platform/types';

// Pins for constants defined in more than one language/runtime, where an
// import is impossible (the sidecar is plain CJS, the Tauri backend is Rust,
// the installers are sh and PowerShell) and only a "keep in sync" comment tied
// the copies together. Each test
// fs-reads the sibling definition and compares values, so drifting one copy
// fails loudly. Pattern per AGENTS.md — a "must stay in sync" claim names the
// test that pins it.
const here = dirname(fileURLToPath(import.meta.url));
const readRepoFile = (rel: string) => readFileSync(resolve(here, '../../..', rel), 'utf8');

function extract(source: string, file: string, re: RegExp): string {
  const m = source.match(re);
  if (!m) throw new Error(`Could not locate ${re} in ${file}`);
  return m[1];
}

// docs/specs/terminal-escapes.md -> "iTerm2 identity"
describe('ITERM2_COMPAT_VERSION mirrors', () => {
  it('matches the sidecar copy in standalone/sidecar/pty-core.js', () => {
    const file = 'standalone/sidecar/pty-core.js';
    const version = extract(readRepoFile(file), file, /^const ITERM2_COMPAT_VERSION = '([^']+)';$/m);
    expect(version).toBe(ITERM2_COMPAT_VERSION);
  });
});

// docs/specs/dor-cli.md: the control-socket handshake. The CLI is a bundled ESM
// binary with no shared build against the CJS server module, so the proof
// domains are duplicated — and drift is silent: the server's own test builds
// its client frames from the server's copy, so only a failed handshake at
// runtime would notice.
describe('dor control-socket proof-domain mirrors', () => {
  const client = 'dor/src/control-client.ts';
  const server = 'standalone/sidecar/dor-control-server.js';
  const clientSrc = readRepoFile(client);
  const serverSrc = readRepoFile(server);

  for (const name of ['CLIENT_PROOF_DOMAIN', 'SERVER_PROOF_DOMAIN'] as const) {
    it(`${name} matches between the dor CLI and the sidecar server`, () => {
      const re = new RegExp(`^const ${name} = '([^']+)';$`, 'm');
      expect(extract(clientSrc, client, re)).toBe(extract(serverSrc, server, re));
    });
  }
});

// docs/specs/server.md -> "Remote control, in the Settings dialog". The Host
// reads the installer's enrollment offer from under the install root each
// installer picks, and nothing links the two sides at build time — a drift is a
// one-click enrollment that silently never appears.
describe('enrollment-offer path mirrors the installers', () => {
  const OFFER_FILE = ['run', 'enroll-offer.json'];
  const HOME = '/home/ned';

  /** The two shell forms the installers' `INSTALL_ROOT` uses, and nothing else. */
  const expand = (expr: string, env: Record<string, string> = {}) =>
    expr
      .replace(/\$\{(\w+):-([^}]*)\}/g, (_, name: string, fallback: string) => env[name] || fallback)
      .replace(/\$HOME/g, HOME);

  it('follows the macOS install root', () => {
    const file = 'deploy/local/install-macos.sh';
    const root = extract(readRepoFile(file), file, /^INSTALL_ROOT="([^"]+)"$/m);
    expect(enrollmentOfferPath('darwin', {}, HOME)).toBe(join(expand(root), ...OFFER_FILE));
  });

  it('follows the Linux install root, XDG_DATA_HOME set or not', () => {
    const file = 'deploy/local/install-linux.sh';
    const root = extract(readRepoFile(file), file, /^INSTALL_ROOT="([^"]+)"$/m);
    const env = { XDG_DATA_HOME: '/data' };
    expect(enrollmentOfferPath('linux', env, HOME)).toBe(join(expand(root, env), ...OFFER_FILE));
    expect(enrollmentOfferPath('linux', {}, HOME)).toBe(join(expand(root), ...OFFER_FILE));
  });

  it('follows the Windows install root', () => {
    const file = 'deploy/local/install-windows.ps1';
    const source = readRepoFile(file);
    const variable = extract(source, file, /^\$INSTALL_ROOT = Join-Path \$env:(\w+) '[^']+'$/m);
    const leaf = extract(source, file, /^\$INSTALL_ROOT = Join-Path \$env:\w+ '([^']+)'$/m);
    const local = 'C:\\Users\\ned\\AppData\\Local';
    expect(enrollmentOfferPath('win32', { [variable]: local }, HOME)).toBe(
      join(local, leaf, ...OFFER_FILE),
    );
  });
});

// docs/specs/standalone.md -> "Rust <-> sidecar bridge"
describe('OPEN_PORT_TIMEOUT_MS mirrors', () => {
  it('matches the sidecar copy in standalone/sidecar/pty-core.js', () => {
    const file = 'standalone/sidecar/pty-core.js';
    const ms = extract(readRepoFile(file), file, /^const OPEN_PORT_TIMEOUT_MS = (\d+);$/m);
    expect(Number(ms)).toBe(OPEN_PORT_TIMEOUT_MS);
  });

  it('matches the Rust copy in standalone/src-tauri/src/lib.rs', () => {
    const file = 'standalone/src-tauri/src/lib.rs';
    const ms = extract(readRepoFile(file), file, /^const OPEN_PORT_TIMEOUT_MS: u64 = (\d+);$/m);
    expect(Number(ms)).toBe(OPEN_PORT_TIMEOUT_MS);
  });
});
