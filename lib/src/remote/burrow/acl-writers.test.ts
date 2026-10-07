import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The only path into a Burrow's ACL is typing, on that Burrow, the two digits
 * the phone shows (docs/specs/security-remote.md -> "Trust boundary"). The
 * runtime tests show that path works and spends itself; a second writer would
 * pass them all, so the writers are counted across every shipped tree here.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHIPPED = ['lib/src', 'vscode-ext/src', 'standalone/src', 'standalone/sidecar', 'relay/src', 'hosted/server', 'remote-lib-common/src', 'dor/src'];
const RUNTIME = 'lib/src/remote/burrow/burrow-runtime.ts';

/** Every call site of `pattern` in shipped, non-test source, as `file` → offsets. */
function callSites(pattern: RegExp): Record<string, number[]> {
  const found: Record<string, number[]> = {};
  for (const root of SHIPPED) {
    for (const entry of readdirSync(join(repo, root), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(c|m)?[jt]sx?$/.test(entry.name)) continue;
      const rel = relative(repo, join(entry.parentPath, entry.name)).split(sep).join('/');
      if (/\.test\.|(^|\/)(test|tests|node_modules|dist)\//.test(rel) || /(^|\/)test-[^/]*$/.test(rel)) continue;
      const text = readFileSync(join(repo, rel), 'utf8');
      const offsets = [...text.matchAll(pattern)].map((match) => match.index);
      if (offsets.length) found[rel] = offsets;
    }
  }
  return found;
}

/** `[start, end)` of a class member's body: from its declaration to the next member at the same indent. */
function memberSpan(text: string, member: string): [number, number] {
  const start = text.indexOf(`\n  ${member}(`);
  expect(start, `${member} not found`).toBeGreaterThan(0);
  const next = text.slice(start + 1).search(/\n  (?:async |static |get |set )?[#\w]+\s*[(<]/);
  return [start, next < 0 ? text.length : start + 1 + next];
}

describe('Burrow ACL writers', () => {
  const runtime = readFileSync(join(repo, RUNTIME), 'utf8');
  const [start, end] = memberSpan(runtime, '#approvePairing');

  it('mint a record only in the runtime’s local approval', () => {
    const mints = callSites(/\.approve\(\s*\{/g);
    expect(Object.keys(mints)).toEqual([RUNTIME]);
    for (const at of mints[RUNTIME]!) expect(at > start && at < end, `approve({ at ${at}`).toBe(true);
  });

  it('save the ACL only from that approval, through the service’s one wiring', () => {
    const saves = callSites(/\.#?saveAcl\(/g);
    expect(Object.keys(saves).sort()).toEqual(['lib/src/host/remote/service.ts', RUNTIME]);
    expect(saves['lib/src/host/remote/service.ts']).toHaveLength(1);
    for (const at of saves[RUNTIME]!) expect(at > start && at < end, `saveAcl( at ${at}`).toBe(true);
  });
});
