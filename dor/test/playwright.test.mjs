import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';

// A host binding names real directories and executables: `dor pw` checks both.
const root = mkdtempSync(join(tmpdir(), 'dor-pw-'));
const firstProject = join(root, 'first-project');
const guiProject = join(root, 'gui');
// The directory `dor pw` runs from, which the host pins for a key's first command.
const caller = join(root, 'caller');
mkdirSync(firstProject);
mkdirSync(guiProject);
mkdirSync(caller);
const pinnedCli = join(root, 'first', 'playwright-cli');
mkdirSync(join(root, 'first'));
writeFileSync(pinnedCli, '#!/bin/sh\n');
chmodSync(pinnedCli, 0o755);

/** `binding` is what the host holds for the key or Surface; without one, a key
 *  is minted as the host would and a Surface has no session to drive. */
function fixture(binding = null) {
  const calls = [];
  const options = {
    env: { PWD: caller, DORMOUSE_PLAYWRIGHT_BIN: '/tools/playwright-cli' },
    client: {
      resolveBrowser: async request => {
        calls.push(['resolve', request]);
        if (binding) return { binding };
        if (request.surface !== undefined) throw new Error(`surface '${request.surface}' has no playwright session yet`);
        return { binding: { session: `dormouse.1.${request.key}`, ...request.proposed } };
      },
      browserSurface: async request => { calls.push(['surface', request]); return {}; },
    },
    execPlaywright: async (...args) => { calls.push(['exec', ...args]); return { exitCode: 0, stdout: 'native output\n', stderr: '' }; },
  };
  return { calls, options };
}

test('pw alias forwards native arguments and binds only to Playwright', async () => {
  const { calls, options } = fixture();
  const result = await runCli(['pw', '--key', 'app', 'open', ':5173', '--headed'], options);
  assert.equal(result.stdout, 'native output\n');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls.find(c => c[0] === 'exec'), ['exec', '/tools/playwright-cli', ['--session=dormouse.1.app', 'open', 'http://localhost:5173/', '--headed'], caller]);
  assert.equal(calls.at(-1)[1].provider, 'playwright');
});
test('existing key pins executable, cwd and native session across terminal directories', async () => {
  const { calls, options } = fixture({ session: 'gui-123', cwd: firstProject, binaryPath: pinnedCli });
  await runCli(['playwright', 'screenshot', 'relative.png'], options);
  assert.deepEqual(calls.find(c => c[0] === 'exec'), ['exec', pinnedCli, ['--session=gui-123', 'screenshot', 'relative.png'], firstProject]);
});
test('a pinned executable that is gone runs the caller\'s own, and says so', async () => {
  const gone = join(root, 'uninstalled', 'playwright-cli');
  const { calls, options } = fixture({ session: 'gui-123', cwd: firstProject, binaryPath: gone });
  const result = await runCli(['pw', 'snapshot'], options);
  assert.deepEqual(calls.find(c => c[0] === 'exec'), ['exec', '/tools/playwright-cli', ['--session=gui-123', 'snapshot'], firstProject]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, new RegExp(`playwright-cli \\(${gone}\\) is gone`));
  // The pane then learns the executable that ran.
  assert.equal(calls.at(-1)[1].binaryPath, '/tools/playwright-cli');
});
test('a pinned directory that is gone is named, not reported as a missing playwright-cli', async () => {
  const gone = join(root, 'removed-worktree');
  const { calls, options } = fixture({ session: 'gui-123', cwd: gone, binaryPath: pinnedCli });
  const result = await runCli(['pw', '--key', 'app', 'snapshot'], options);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, new RegExp(`no longer exists: ${gone}`));
  assert.doesNotMatch(result.stderr, /not installed/);
  assert.equal(calls.some(c => c[0] === 'exec'), false);
});
test('a pinned executable outside the allowlist runs the caller\'s own instead', async () => {
  // The binding comes back from the host, and off a hand-editable session file.
  for (const binaryPath of ['/bin/sh', './playwright-cli', '/opt/../bin/playwright-cli']) {
    const { calls, options } = fixture({ session: 'gui-123', cwd: firstProject, binaryPath });
    await runCli(['pw', 'snapshot'], options);
    assert.deepEqual(calls.find(c => c[0] === 'exec'), ['exec', '/tools/playwright-cli', ['--session=gui-123', 'snapshot'], firstProject], binaryPath);
  }
});
test('an empty DORMOUSE_PLAYWRIGHT_BIN is unset', async () => {
  const { calls, options } = fixture();
  options.env.DORMOUSE_PLAYWRIGHT_BIN = '';
  await runCli(['pw', 'snapshot'], options);
  assert.equal(calls.find(c => c[0] === 'exec')[1], 'playwright-cli');
});
test('raw -s bypasses workspace addressing', async () => {
  const { calls, options } = fixture();
  await runCli(['pw', '-s=raw-session', 'goto', ':8080'], options);
  assert.equal(calls.some(c => c[0] === 'resolve'), false);
  assert.deepEqual(calls[0].slice(2), [['--session=raw-session', 'goto', 'http://localhost:8080/'], caller]);
  assert.equal(calls.at(-1)[1].key, undefined);
});
test('surface addressing resolves GUI-created sessions and rejects missing sessions', async () => {
  const { calls, options } = fixture({ session: 'gui-123', cwd: guiProject });
  await runCli(['pw', '--surface', 'surface:3', 'snapshot'], options);
  assert.equal(calls[0][1].surface, 'surface:3');
  const missing = fixture();
  assert.equal((await runCli(['pw', '--surface', 'surface:3', 'snapshot'], missing.options)).exitCode, 1);
  assert.equal(missing.calls.some(c => c[0] === 'exec'), false);
});
test('native failures and close do not create or resurrect panes', async () => {
  const { calls, options } = fixture();
  await runCli(['pw', 'close'], options);
  assert.equal(calls.some(c => c[0] === 'surface'), false);
  options.execPlaywright = async () => ({ exitCode: 7, stdout: '', stderr: 'native error' });
  assert.deepEqual(await runCli(['pw', 'open', ':8080'], options), { exitCode: 7, stdout: '', stderr: 'native error' });
});
test('viewer failure preserves native command output and exit status', async () => {
  const { options } = fixture();
  options.client.browserSurface = async () => { throw new Error('Chromium only'); };
  const result = await runCli(['pw', 'snapshot'], options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'native output\n');
  assert.match(result.stderr, /Chromium only/);
});
test('identity flags are mutually exclusive', async () => {
  const { calls, options } = fixture();
  assert.equal((await runCli(['pw', '--key', 'app', '-s', 'raw', 'snapshot'], options)).exitCode, 1);
  assert.deepEqual(calls, []);
});
