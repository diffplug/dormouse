/**
 * Production assertions on the built Pocket app — the last step of
 * `build:pocket`, so an output that would fail on a phone fails here instead.
 * Two rules, each defending a claim made elsewhere that the bundler could break
 * silently:
 *
 * * **The worker** (`docs/specs/pocket-app.md` -> Installable web app).
 *   `registerPushServiceWorker` registers `/sw.js` classic, with no
 *   `type: 'module'`, from the scope root. A worker carrying module syntax, a
 *   dynamic-import loader, or a sibling chunk installs on nothing — and the
 *   failure is invisible from the desktop, because push is the one feature no
 *   developer machine exercises.
 * * **The shell** (`docs/specs/pocket-app.md` -> Deployment). The origin is
 *   served `script-src 'self'` with no nonce pipeline, which is only safe while
 *   the shell carries no inline script and loads nothing off-origin. Vite emits
 *   an inline module-preload polyfill for some builds, so this reads the real
 *   output rather than the source shell — and it lives here, in the build,
 *   because no test suite builds the app first.
 *
 * Pure so `lib/src/remote/pocket-app/assert-pocket-worker.test.ts` can drive
 * both against fixtures; the CLI at the bottom is the build's entry point.
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

/** The shell the server serves, and the only HTML in the build. */
export const SHELL_FILE = 'index.html';

/** Every `<script …>…</script>`, with its attributes and its body. */
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
/** The `src`/`href` of a tag, single- or double-quoted. */
const SRC_ATTRIBUTE = /\ssrc=["']([^"']*)["']/;
/** Every `<link …href="…">` — the stylesheet, the manifest, the icons. */
const LINK_HREF = /<link\b[^>]*\shref=["']([^"']*)["']/g;

/**
 * Whether a reference stays on the app's own origin.
 *
 * The bundle mounts at the origin root (Deployment), so a same-origin
 * reference is root-relative — **except** the protocol-relative form, which
 * also starts with `/` and resolves to another host entirely. Both spellings
 * are what a `base` pointing at a CDN produces, and a `base` change is the one
 * input that makes this guard fire at all.
 */
function isSameOriginRef(value) {
  return value.startsWith('/') && !value.startsWith('//');
}

/**
 * Check the built shell in `outDir` against `script-src 'self'`, throwing on
 * the first violation. Returns how many scripts it approved.
 *
 * {@link isSameOriginRef} is the whole test: anything else is inline or
 * off-origin, and the policy blocks both with no console error the build would
 * otherwise see.
 */
export function assertPocketShell(outDir) {
  let html;
  try {
    html = readFileSync(join(outDir, SHELL_FILE), 'utf8');
  } catch {
    throw new Error(`${join(outDir, SHELL_FILE)} does not exist — run the Pocket app build first.`);
  }

  let scripts = 0;
  for (const [, attributes, body] of html.matchAll(SCRIPT_TAG)) {
    if (body.trim() !== '') {
      throw new Error(
        `${SHELL_FILE} carries an inline script (…${body.trim().slice(0, 60)}…). The Pocket ` +
          "origin is served `script-src 'self'` with no nonce, so it would never run.",
      );
    }
    const src = SRC_ATTRIBUTE.exec(attributes)?.[1];
    if (!src || !isSameOriginRef(src)) {
      throw new Error(
        `${SHELL_FILE} has a script that is not same-origin (<script${attributes}>). ` +
          "The Pocket origin is served `script-src 'self'`.",
      );
    }
    scripts += 1;
  }
  for (const [, href] of html.matchAll(LINK_HREF)) {
    if (isSameOriginRef(href)) continue;
    throw new Error(
      `${SHELL_FILE} links an off-origin resource (${href}). The Pocket origin is served ` +
        "`default-src 'self'`.",
    );
  }
  return scripts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] ?? fileURLToPath(new URL('../dist-pocket', import.meta.url));
  try {
    const bytes = assertPocketWorker(outDir);
    console.log(`pocket worker ok: ${WORKER_FILE}, ${bytes} bytes, classic and self-contained`);
    const scripts = assertPocketShell(outDir);
    console.log(`pocket shell ok: ${SHELL_FILE}, ${scripts} script(s), all same-origin and external`);
  } catch (error) {
    console.error(`pocket build check failed: ${error.message}`);
    process.exit(1);
  }
}
