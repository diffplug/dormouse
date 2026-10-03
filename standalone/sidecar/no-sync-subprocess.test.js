// Pins docs/specs/transport.md -> "Universal invariants": no synchronous
// subprocess on a PTY host's event loop. These sources run there — the sidecar
// directly, the host modules and spawn helper bundled into it and VS Code's
// pty-host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const SOURCES = [
  ['standalone/sidecar', /\.js$/],
  ['lib/src/host', /\.ts$/],
  ['dor-lib-common/src', /\.ts$/],
  ['vscode-ext/src', /^pty-host\.js$/],
];

function* sourceFiles(dir, pattern) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* sourceFiles(relative, pattern); }
    else if (pattern.test(entry.name) && !/\.test\.[jt]s$/.test(entry.name)) yield relative;
  }
}

test('no PTY-host source spawns a synchronous subprocess', () => {
  const offenders = [];
  for (const [dir, pattern] of SOURCES) {
    for (const file of sourceFiles(dir, pattern)) {
      if (/\b(execFileSync|execSync|spawnSync)\b/.test(fs.readFileSync(path.join(root, file), 'utf8'))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});
