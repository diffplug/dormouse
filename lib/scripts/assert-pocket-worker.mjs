/**
 * Production assertions for the built Pocket service worker
 * (`docs/specs/pocket-app.md` -> Installable web app). The last step of
 * `build:pocket`, so a build that would ship a worker no phone can install
 * fails here rather than at the phone.
 *
 * What it defends: `registerPushServiceWorker` registers `/sw.js` classic, with
 * no `type: 'module'`, from the scope root. A worker carrying module syntax, a
 * dynamic-import loader, or a sibling chunk installs on nothing — and the
 * failure is invisible from the desktop, because push is the one feature no
 * developer machine exercises.
 *
 * Pure so `lib/src/remote/pocket-app/assert-pocket-worker.test.ts` can drive it
 * against fixtures; the CLI at the bottom is the build's entry point.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one name the registration hard-codes. */
export const WORKER_FILE = 'sw.js';

/**
 * A dynamic `import(...)`. Rollup emits one only when it kept a chunk boundary,
 * so this catches the loader and the split it implies in the same test.
 */
const DYNAMIC_IMPORT = /\bimport\s*\(/;

/**
 * A top-level `import` statement — the bare specifier form (`import 'x'`), the
 * namespace and named forms, and a default binding. Anchored on a statement
 * boundary so the substring inside an identifier cannot match.
 */
const STATIC_IMPORT = /(?:^|[;}\s])import\s*(?:[*{'"]|[A-Za-z_$])/;

/** A top-level `export` statement, in any of the forms Rollup emits. */
const STATIC_EXPORT = /(?:^|[;}\s])export\s*(?:[*{]|default\b|(?:var|let|const|function|class|async)\b)/;

/**
 * Check the built worker in `outDir`, throwing on the first violation.
 *
 * Returns the worker's byte length, so the build step can say what it approved.
 */
export function assertPocketWorker(outDir) {
  let entries;
  try {
    entries = readdirSync(outDir, { withFileTypes: true });
  } catch {
    throw new Error(`${outDir} does not exist — run the Pocket app build first.`);
  }

  // Vite content-hashes everything it emits into `assets/`, so a script at the
  // root is either the worker or a chunk that escaped `inlineDynamicImports`.
  const rootScripts = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
  if (rootScripts.length !== 1 || rootScripts[0] !== WORKER_FILE) {
    throw new Error(
      `expected exactly one root script, ${WORKER_FILE}, in ${outDir}; found ` +
        `${rootScripts.length === 0 ? 'none' : rootScripts.join(', ')}. A second file here is ` +
        'a worker chunk, and a classic worker cannot load one.',
    );
  }

  const source = readFileSync(join(outDir, WORKER_FILE), 'utf8');
  for (const [pattern, what] of [
    [DYNAMIC_IMPORT, 'a dynamic import() loader'],
    [STATIC_IMPORT, 'a top-level import statement'],
    [STATIC_EXPORT, 'a top-level export statement'],
  ]) {
    const match = pattern.exec(source);
    if (match) {
      throw new Error(
        `${WORKER_FILE} contains ${what} (…${source.slice(Math.max(0, match.index - 40), match.index + 40)}…). ` +
          'It is registered as a classic worker, so module syntax would fail to install.',
      );
    }
  }
  return source.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] ?? fileURLToPath(new URL('../dist-pocket', import.meta.url));
  try {
    const bytes = assertPocketWorker(outDir);
    console.log(`pocket worker ok: ${WORKER_FILE}, ${bytes} bytes, classic and self-contained`);
  } catch (error) {
    console.error(`pocket worker check failed: ${error.message}`);
    process.exit(1);
  }
}
