import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITERM2_COMPAT_VERSION } from './terminal-protocol';
import { OPEN_PORT_TIMEOUT_MS } from './platform/types';

// Pins for constants defined in more than one language/runtime, where an
// import is impossible (the sidecar is plain CJS, the Tauri backend is Rust)
// and only a "keep in sync" comment tied the copies together. Each test
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
