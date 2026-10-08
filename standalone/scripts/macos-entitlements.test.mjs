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
 * docs/specs/security-ci.rationale.md). Which binary is signed with them is
 * `scripts/sign-and-deploy.test.mjs`'s.
 */

const plist = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'entitlements-macos-node.plist'), 'utf8');

test('the Node sidecar holds exactly three entitlements', () => {
  const body = plist.match(/<dict>([\s\S]*)<\/dict>/)?.[1] ?? '';
  const entry = (name) => `<key>com.apple.security.cs.${name}</key><true/>`;
  assert.equal(body.replace(/\s+/g, ''), ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation'].map(entry).join(''));
});
