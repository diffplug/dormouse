import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The hardened-runtime exceptions the signed macOS Node sidecar carries. Each
 * one loosens what the OS enforces on a process every terminal's `dor` runs
 * through, so the set is pinned exactly and a new one is a reviewed change
 * (docs/specs/security-ci.md -> "Desktop Releases"; why each is held:
 * docs/specs/security-ci.rationale.md).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const plist = readFileSync(join(here, '..', 'src-tauri', 'entitlements-macos-node.plist'), 'utf8');
const signScript = readFileSync(join(repo, 'scripts', 'sign-and-deploy.sh'), 'utf8');

test('the Node sidecar holds exactly three entitlements, each simply true', () => {
  const body = plist.match(/<dict>([\s\S]*)<\/dict>/)?.[1] ?? '';
  const entries = [...body.matchAll(/<key>([^<]+)<\/key>\s*(<[^>]+>)/g)].map(([, key, value]) => [key, value]);
  assert.deepEqual(entries, [
    ['com.apple.security.cs.allow-jit', '<true/>'],
    ['com.apple.security.cs.allow-unsigned-executable-memory', '<true/>'],
    ['com.apple.security.cs.disable-library-validation', '<true/>'],
  ]);
  // Nothing hides between or around the pairs the scan read.
  assert.equal(body.replace(/<key>[^<]+<\/key>\s*<true\/>/g, '').trim(), '');
});

test('only the Node sidecar is signed with them', () => {
  const uses = signScript.split('\n').filter((line) => /--entitlements\b/.test(line));
  assert.deepEqual(uses.map((line) => line.trim()), ['--entitlements "$MACOS_NODE_ENTITLEMENTS" \\']);
  const branch = signScript.slice(signScript.lastIndexOf('if [[', signScript.indexOf('--entitlements "$MACOS_NODE')), signScript.indexOf('--entitlements "$MACOS_NODE'));
  assert.match(branch, /if \[\[ "\$binary" == "\$app_path\/Contents\/MacOS\/node" \]\]; then/);
});
