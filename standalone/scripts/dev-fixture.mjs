// Shared scaffolding for the two dev-runner integration tests beside this file.
// Both stand up a throwaway worktree, put fake CLIs on PATH, and read a runner's
// interleaved stdout/stderr; only the runner and its stubs differ. Not a
// `*.test.mjs`, so `node --test scripts/*.test.mjs` does not run it directly.
import { copyFile, mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));

/**
 * A temp worktree that Vite can serve: `<root>/standalone` holding the real
 * `vite.config.ts` plus a one-line page, and an empty `<root>/bin` for shims.
 * Removing `root` is the caller's `t.after`, which must stop its runs first.
 */
export async function devWorkspace(prefix) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `${prefix}-`)));
  const standalone = path.join(root, 'standalone');
  const bin = path.join(root, 'bin');
  await mkdir(path.join(standalone, 'scripts'), { recursive: true });
  await mkdir(bin);
  await mirrorNodeModules(standalone);
  await Promise.all([
    copyFile(path.resolve(scripts, '../vite.config.ts'), path.join(standalone, 'vite.config.ts')),
    writeFile(path.join(standalone, 'index.html'), '<script type="module" src="/app.js"></script>'),
    writeFile(path.join(standalone, 'app.js'), 'console.log(import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST);'),
  ]);
  return { root, standalone, bin };
}

/**
 * Entry-by-entry symlinks rather than one symlink of the whole directory:
 * Vite writes its dep-optimizer cache to `node_modules/.vite`, so a whole-tree
 * symlink would have every test run overwrite the real app's warm cache with a
 * fixture-sized one and leave `deps_temp_*` directories behind. Resolution is
 * unchanged — pnpm's `node_modules` is itself a directory of symlinks.
 */
async function mirrorNodeModules(standalone) {
  const real = path.resolve(scripts, '../node_modules');
  const target = path.join(standalone, 'node_modules');
  await mkdir(target);
  const entries = await readdir(real);
  await Promise.all(entries
    .filter(name => !name.startsWith('.vite'))
    .map(name => symlink(path.join(real, name), path.join(target, name), 'junction')));
}

/** A `<bin>/<name>` shim per name, each running `cli` on this Node. */
export function writeShims(bin, cli, names) {
  return Promise.all(names.map(name => (process.platform === 'win32'
    ? writeFile(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${cli}" %*\r\n`)
    : writeFile(path.join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 }))));
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

/** The environment a runner sees: this one minus every knob under test. */
export function cleanEnv(bin) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DORMOUSE_|VITE_|TAURI_)/.test(key)));
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  return env;
}

/**
 * Reads a spawned runner's interleaved output. `wait` resolves off the `data`
 * events themselves rather than polling, so a match costs no sleep; `close`
 * (not `exit`) settles `exited`, so final diagnostics are available to
 * assertions.
 */
export function runner(child, label) {
  let output = '';
  let closed = false;
  const waiters = new Set();
  const settle = () => {
    for (const waiter of waiters) {
      const match = output.match(waiter.pattern);
      if (match) waiter.settle(() => match);
      else if (closed) waiter.settle(() => { throw new Error(`${label} did not log ${waiter.pattern}:\n${output}`); });
    }
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output += chunk; settle(); });
  }
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; settle(); resolve({ code, signal }); });
  });
  return {
    exited,
    get output() { return output; },
    get closed() { return closed; },
    wait(pattern) {
      return new Promise((resolve, reject) => {
        const waiter = { pattern };
        waiter.settle = (result) => {
          waiters.delete(waiter);
          clearTimeout(timer);
          try { resolve(result()); } catch (err) { reject(err); }
        };
        const timer = setTimeout(
          () => waiter.settle(() => { throw new Error(`${label} did not log ${pattern}:\n${output}`); }),
          20000,
        );
        waiters.add(waiter);
        settle();
      });
    },
  };
}
