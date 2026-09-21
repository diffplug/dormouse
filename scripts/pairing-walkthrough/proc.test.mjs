/**
 * The line plumbing `waitForLine` reads (`scripts/pairing-walkthrough/proc.mjs`).
 * Pinned here because a corrupted line is invisible in the tee'd log — the log
 * takes the raw bytes and looks right while `lines` carries the damage.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { killTree, lineAccumulator, spawnLogged, waitForLine } from './proc.mjs';

// "▀" is U+2580, E2 96 80 — the block the QR code is drawn from, so a chunk
// boundary inside one is what the walkthrough actually hits.
const BLOCK = Buffer.from('▀', 'utf8');

test('a multi-byte character split across two chunks survives into the line', () => {
  const lines = [];
  const accumulate = lineAccumulator((line) => lines.push(line));
  accumulate(Buffer.concat([Buffer.from('qr: ', 'utf8'), BLOCK.subarray(0, 1)]));
  accumulate(Buffer.concat([BLOCK.subarray(1), Buffer.from('\n', 'utf8')]));
  assert.deepEqual(lines, ['qr: ▀']);
});

test('stdout and stderr do not complete each other\'s partial characters or lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dormouse-proc-'));
  // stdout stops mid-character, stderr writes a whole line into the gap, then
  // stdout finishes the character. A decoder or carry shared between the two
  // pipes yields one spliced line ("qr: �warn: x") instead of two.
  const child = [
    `process.stdout.write(Buffer.from([${[...Buffer.from('qr: ', 'utf8'), ...BLOCK.subarray(0, 1)]}]));`,
    'setTimeout(() => {',
    '  process.stderr.write("warn: x\\n");',
    `  setTimeout(() => process.stdout.write(Buffer.from([${[...BLOCK.subarray(1)]}, 10])), 60);`,
    '}, 60);',
    // Stay alive past the last write: `waitForLine` gives up the moment the
    // child has exited, and a pipe can deliver its tail after `exit` fires.
    'setTimeout(() => {}, 10000);',
  ].join('');
  const handle = spawnLogged(process.execPath, ['-e', child], {
    logPath: join(dir, 'child.log'),
    prefix: 'child',
  });
  try {
    await waitForLine(handle, /^qr: ▀$/, { timeoutMs: 10_000, what: 'the completed block line' });
    assert.ok(handle.lines.includes('warn: x'), `stderr line was spliced: ${JSON.stringify(handle.lines)}`);
  } finally {
    await killTree(handle);
  }
});
