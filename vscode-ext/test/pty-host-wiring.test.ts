// `pty-host.js` is the VS Code side's only bridge from IPC messages to the shared
// `pty-core`, and it is plain JS that loads only as a forked child: neither
// `pnpm typecheck` nor a runtime test reaches it. A handler naming a manager
// function `pty-core` no longer exports throws a TypeError inside the child, and
// the caller just waits out its timeout. These source checks pin the wiring
// both ways, as `standalone/sidecar/main-wiring.test.js` does for the sidecar.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const hostSource = read('../src/pty-host.js');
const managerSource = read('../src/pty-manager.ts');

const { create } = createRequire(import.meta.url)('../../lib/pty-core.cjs');

describe('pty-host wiring', () => {
  it('reaches pty-core only through functions it exports', () => {
    const mgr = create(() => {}, { spawn() { throw new Error('unused'); } });
    const used = [...new Set([...hostSource.matchAll(/\bmgr\.(\w+)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => typeof mgr[name] !== 'function')).toEqual([]);
  });

  it('handles every message type pty-manager sends, and no other', () => {
    const sent = [...new Set([...managerSource.matchAll(/\btype: '([\w:]+)'/g)].map((m) => m[1]))];
    expect(sent.length).toBeGreaterThan(0);
    const handled = [...hostSource.matchAll(/case '([\w:]+)':/g)].map((m) => m[1]);
    expect(new Set(handled)).toEqual(new Set(sent));
  });

  it('hands the graceful kill the ids the extension host names', () => {
    // pty-core kills nothing when `ids` is missing, and still acks.
    expect(hostSource).toMatch(/case 'gracefulKill':\s*mgr\.gracefulKill\(msg\.ids,\s*msg\.timeout,\s*msg\.requestId\)/);
  });
});
