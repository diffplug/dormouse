import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enrollmentOfferPath } from '../host/remote/enroll-offer';
import { PAIRING_CODE_LABEL } from '../remote/pocket-app/App';
import { SCAN_LABEL } from '../remote/setup-copy';
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
// reads the installer's enrollment offer from the path each installer writes it
// to, and nothing links the two sides at build time — a drift is a one-click
// enrollment that silently never appears. The whole path is followed, root and
// leaf: the file name is as much of a shared constant as the directory.
describe('enrollment-offer path mirrors the installers', () => {
  const HOME = '/home/ned';

  /** The shell forms the installers' path variables use, and nothing else. */
  const expand = (expr: string, vars: Record<string, string>) =>
    expr
      .replace(/\$\{(\w+):-([^}]*)\}/g, (_, name: string, fallback: string) => vars[name] || fallback)
      .replace(/\$(\w+)/g, (whole: string, name: string) => vars[name] ?? whole);

  /** `ENROLL_OFFER_FILE` as one of the `sh` installers assembles it. */
  const shellOfferFile = (file: string, env: Record<string, string> = {}) => {
    const source = readRepoFile(file);
    const vars: Record<string, string> = { HOME, ...env };
    let resolved = '';
    // Each one is defined in terms of the one before it, so they resolve in order.
    for (const name of ['INSTALL_ROOT', 'RUN_DIR', 'ENROLL_OFFER_FILE'] as const) {
      resolved = expand(extract(source, file, new RegExp(`^${name}="([^"]+)"$`, 'm')), vars);
      vars[name] = resolved;
    }
    return resolved;
  };

  it('follows the macOS offer path', () => {
    expect(enrollmentOfferPath('darwin', {}, HOME)).toBe(
      shellOfferFile('deploy/local/install-macos.sh'),
    );
  });

  it('follows the Linux offer path, XDG_DATA_HOME set or not', () => {
    const file = 'deploy/local/install-linux.sh';
    const env = { XDG_DATA_HOME: '/data' };
    expect(enrollmentOfferPath('linux', env, HOME)).toBe(shellOfferFile(file, env));
    expect(enrollmentOfferPath('linux', {}, HOME)).toBe(shellOfferFile(file));
  });

  it('follows the Windows offer path', () => {
    const file = 'deploy/local/install-windows.ps1';
    const source = readRepoFile(file);
    const variable = extract(source, file, /^\$INSTALL_ROOT = Join-Path \$env:(\w+) '[^']+'$/m);
    const local = 'C:\\Users\\ned\\AppData\\Local';
    const root = join(
      local,
      extract(source, file, /^\$INSTALL_ROOT = Join-Path \$env:\w+ '([^']+)'$/m),
    );
    const run = join(root, extract(source, file, /^\$RUN_DIR = Join-Path \$INSTALL_ROOT '([^']+)'$/m));
    const offerFile = join(
      run,
      extract(source, file, /^\$ENROLL_OFFER_FILE = Join-Path \$RUN_DIR '([^']+)'$/m),
    );
    expect(enrollmentOfferPath('win32', { [variable]: local }, HOME)).toBe(offerFile);
  });
});

// scripts/pairing-walkthrough/README.md -> Steps. The walkthrough drives the
// built Pocket app from plain Node, so it cannot import either constant; a
// drift is not a failed build but a run that stalls against a live Chrome and a
// real Server, saying only that it never found the button.
describe('the pairing walkthrough mirrors the copy it clicks', () => {
  const file = 'scripts/pairing-walkthrough/steps.mjs';
  const source = readRepoFile(file);

  it('presses the scan button by its shipped label', () => {
    expect(extract(source, file, /^const SCAN_LABEL = '([^']+)';$/m)).toBe(SCAN_LABEL);
  });

  it('finds the two digits by the live region’s shipped accessible name', () => {
    const selector = extract(source, file, /^const PAIRING_CODE_REGION = '([^']+)';$/m);
    expect(selector).toBe(`[role="status"][aria-label="${PAIRING_CODE_LABEL}"]`);
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
