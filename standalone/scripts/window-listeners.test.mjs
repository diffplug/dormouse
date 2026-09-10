import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A listener registered with Tauri's default `Any` target receives every event
 * in the process, including the ones Rust addressed to one window
 * (`match_any_or_filter` in Tauri's event listener). The whole per-window
 * routing would then be decoration: every window would take every other
 * window's terminal output, its `pty:list`, its Workspace arrivals and its
 * teardown order (docs/specs/standalone.md -> "Routing").
 *
 * The failure is silent — nothing errors, the events simply go everywhere — so
 * this scans the source rather than trusting review.
 */

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** The one module allowed to reach the bare API: it is the wrapper. */
const WRAPPER = 'window-label.ts';

const sources = readdirSync(src)
  .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.') && name !== WRAPPER)
  .map((name) => ({ name, text: readFileSync(join(src, name), 'utf8') }));

test('every window listener is scoped through listenToWindow', () => {
  // `listen(` preceded by a word character or a dot is something else
  // (`listenToWindow(`, `appWindow.listen(`).
  const offenders = sources.filter((file) => /(?<![\w.])listen\s*\(/.test(file.text));
  assert.deepEqual(offenders.map((file) => file.name), []);
});

test('the wrapper is the only importer of the bare event API', () => {
  const offenders = sources.filter((file) => /from ['"]@tauri-apps\/api\/event['"]/.test(file.text));
  assert.deepEqual(offenders.map((file) => file.name), []);
});
