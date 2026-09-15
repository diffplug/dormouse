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

// Recursive: a listener in a subdirectory is exactly as unscoped as one beside
// the wrapper, and a scan that skipped it would report a clean bill of health.
const sources = readdirSync(src, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()
    && /\.tsx?$/.test(entry.name)
    && !entry.name.includes('.test.')
    && entry.name !== WRAPPER)
  .map((entry) => ({
    name: entry.name,
    text: readFileSync(join(entry.parentPath, entry.name), 'utf8'),
  }));

test('the scan found the sources it is meant to be reading', () => {
  // A walk that found nothing passes both checks below without reading a line.
  assert.ok(sources.length > 10, `only ${sources.length} sources under ${src}`);
  assert.ok(sources.some((file) => file.name === 'tauri-adapter.ts'));
});

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
