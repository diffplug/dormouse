import { builtinModules, createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { workspaceSourceAliases } from '../../scripts/workspace-sources.mjs';

// Hosted's disclosure is a walk over `dormouse-hosted`'s declared edges that
// skips optional peers (website/scripts/product-sections.js), so a package a
// Worker or the account page bundles, supplied only by a development
// dependency, would be missed by the walk. This bundles each of them the way
// its deploy does and fails on any bundled release the disclosure lacks. See
// docs/specs/security-supply-chain.md -> "Disclosure".

/**
 * What Hosted bundles: each `hosted/wrangler*.jsonc`'s `main`, bundled for
 * workerd as Wrangler does, and the account page's module script in
 * `hosted/index.html`, bundled for the browser as Vite does. Read from the
 * deploy's own configuration, so a new Worker is checked without an edit here.
 */
export function hostedBundleEntries(repoRoot) {
  const hosted = resolve(repoRoot, 'hosted');
  const workers = readdirSync(hosted)
    .filter((name) => /^wrangler(\..+)?\.jsonc$/.test(name))
    .sort()
    .map((name) => {
      const main = readFileSync(join(hosted, name), 'utf-8').match(/^\s{2}"main":\s*"([^"]+)"/m)?.[1];
      if (!main) throw new Error(`hosted/${name}: no top-level "main" to bundle`);
      return { entry: main, platform: 'worker' };
    });
  const scripts = moduleScriptEntries(readFileSync(join(hosted, 'index.html'), 'utf-8'));
  if (scripts.length === 0) throw new Error('hosted/index.html: no module script to bundle');
  if (workers.length === 0) throw new Error('hosted/: no wrangler*.jsonc to bundle');
  return [...workers, ...scripts.map((entry) => ({ entry, platform: 'browser' }))];
}

/** Each module script's root-relative `src`, attributes in any order. A module
 * script whose `src` this cannot read throws rather than going unbundled. */
export function moduleScriptEntries(html) {
  return [...html.matchAll(/<script\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => /\stype=["']?module\b/.test(tag))
    .map((tag) => {
      const src = tag.match(/\ssrc="\/([^"]+)"/)?.[1];
      if (!src) throw new Error(`hosted/index.html: cannot read the src of ${tag}`);
      return src;
    });
}

/**
 * The npm releases one esbuild metafile's inputs come from, each read from the
 * `package.json` at its root under the last `node_modules/` in the input path.
 * Workspace sources resolve to their real paths, outside any `node_modules`.
 */
export function bundledReleases(metafile, absWorkingDir) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf('node_modules/');
    if (at === -1) continue;
    const [first, second] = input.slice(at + 'node_modules/'.length).split('/');
    roots.add(input.slice(0, at + 'node_modules/'.length) + (first.startsWith('@') ? `${first}/${second}` : first));
  }
  return [...roots].map((root) => {
    const manifest = resolve(absWorkingDir, root, 'package.json');
    if (!existsSync(manifest)) throw new Error(`A bundled package has no package.json at ${manifest}`);
    const { name, version } = JSON.parse(readFileSync(manifest, 'utf-8'));
    return { name, version };
  });
}

/** Each `name@version` in `releases` that no section of `disclosure` lists, sorted. */
export function undisclosedReleases(releases, disclosure) {
  const disclosed = new Set(
    Object.values(disclosure).flatMap((rows) => rows.flatMap((row) => row.versions.map((version) => `${row.name}@${version}`))),
  );
  return [...new Set(releases.map(({ name, version }) => `${name}@${version}`))].filter((release) => !disclosed.has(release)).sort();
}

/** Every npm release Hosted's Workers and account page bundle, by entry. */
export async function hostedBundles(repoRoot) {
  const hosted = resolve(repoRoot, 'hosted');
  const esbuild = createRequire(join(hosted, 'package.json'))('esbuild');
  const builtins = builtinModules.flatMap((name) => [name, `${name}/*`]);
  return Promise.all(hostedBundleEntries(repoRoot).map(async ({ entry, platform }) => {
    const { metafile } = await esbuild.build({
      absWorkingDir: realpathSync(hosted),
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      logLevel: 'silent',
      jsx: 'automatic',
      loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.sql': 'text' },
      // Hosted's Vite build reads internal packages from source; a dist-less one (`lath`) has nothing else.
      alias: workspaceSourceAliases(),
      ...(platform === 'worker'
        ? { platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], mainFields: ['browser', 'module', 'main'], external: ['node:*', 'cloudflare:*', ...builtins] }
        : { platform: 'browser' }),
    });
    return { entry, releases: bundledReleases(metafile, realpathSync(hosted)) };
  }));
}

/** Throw unless every release Hosted bundles is in `disclosure` (dependencies-npm.json's shape). */
export async function assertHostedBundlesDisclosed(disclosure, repoRoot) {
  const missing = (await hostedBundles(repoRoot)).flatMap(({ entry, releases }) =>
    undisclosedReleases(releases, disclosure).map((release) => `${release} (bundled from hosted/${entry})`));
  if (missing.length > 0) {
    throw new Error(`Hosted bundles releases the disclosure does not list: ${missing.join(', ')}. Declare each as a dependency of dormouse-hosted, or of the package that imports it.`);
  }
}

// The Terminal's and the built-in Tools' walks read `dependencies` alone, and
// each of their bundlers resolves any installed package, so a source file that
// imports a devDependency ships it undisclosed. These are the entries their
// builds bundle, with the externals each build keeps out: the sidecar's
// (standalone/scripts/build-sidecar-proxy.mjs), the extension's
// (vscode-ext/scripts/esbuild.mjs), the webviews, Pocket, and the one-time page
// (their Vite configs), `dor` (dor/package.json), and the built-in Tools'
// (dor-tools-builtin/scripts/build.mjs, build-viewer.mjs). A new bundle is
// added here by hand.
const nodeBundle = (external = []) => ({ platform: 'node', format: 'cjs', external: ['bufferutil', 'utf-8-validate', ...external] });
const pageBundle = { platform: 'browser', format: 'esm', jsx: 'automatic', external: ['virtual:*', '@standalone-latest'] };
const sidecar = (entry, external) => ({ dir: 'lib', entry: `src/host/${entry}`, options: nodeBundle(external) });
const extension = (entry) => ({ dir: 'vscode-ext', entry, options: nodeBundle(['vscode', 'node-pty', 'node-datachannel', 'node-datachannel/*']) });
const page = (dir, entry, extra = {}) => ({ dir, entry, options: { ...pageBundle, ...extra } });
export const PRODUCT_BUNDLES = [
  ...['iframe-proxy.ts', 'browser-host.ts', 'agent-browser-host.ts', 'playwright-host.ts', 'tool-host.ts', 'git-info.ts', 'recovery.ts'].map((entry) => sidecar(entry)),
  sidecar('remote/sidecar-entry.ts', ['node-datachannel', 'node-datachannel/*', '@node-datachannel/*']),
  extension('src/extension.ts'),
  extension('src/pty-host.js'),
  ...['src/main.tsx', 'src/remote/pocket-app/main.tsx', 'src/remote/pocket-app/sw-entry.ts', 'src/remote/one-time-app/main.tsx',
    'src/remote/frame-origin/worker-entry.ts', 'src/remote/frame-origin/bootstrap.ts'].map((entry) => page('lib', entry)),
  page('standalone', 'src/main.tsx'),
  // Its build writes these two first; they hold text, not imports.
  { dir: 'dor', entry: 'src/dor.ts', options: { platform: 'node', format: 'esm', external: ['./generated-skill.js', './generated-version.js'] } },
  { dir: 'dor-tools-builtin', entry: 'src/runtime.ts', options: { platform: 'node', format: 'esm' } },
  ...['viewer/editor.ts', 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js', 'viewer/image/main.tsx', 'viewer/image/png-worker.ts', 'viewer/tooltip-page.ts']
    .map((entry) => page('dor-tools-builtin', entry)),
  page('dor-tools-builtin', 'viewer/markdown.tsx', { splitting: true, outdir: 'out' }),
];

/** Every npm release the Terminal and the built-in Tools bundle, by entry. */
export async function productBundles(repoRoot, bundles = PRODUCT_BUNDLES) {
  const esbuild = createRequire(join(resolve(repoRoot, 'hosted'), 'package.json'))('esbuild');
  const alias = workspaceSourceAliases();
  return Promise.all(bundles.map(async ({ dir, entry, options }) => {
    const absWorkingDir = realpathSync(resolve(repoRoot, dir));
    const { metafile } = await esbuild.build({
      absWorkingDir, entryPoints: [entry], bundle: true, write: false, metafile: true, logLevel: 'silent', alias,
      loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty', '.sql': 'text' },
      define: { 'process.env.NODE_ENV': '"production"' },
      ...options,
    });
    return { entry: `${dir}/${entry}`, releases: bundledReleases(metafile, absWorkingDir) };
  }));
}

/** Throw unless every release the Terminal and the built-in Tools bundle is in `disclosure`. */
export async function assertProductBundlesDisclosed(disclosure, repoRoot, bundles = PRODUCT_BUNDLES) {
  const missing = (await productBundles(repoRoot, bundles)).flatMap(({ entry, releases }) =>
    undisclosedReleases(releases, disclosure).map((release) => `${release} (bundled from ${entry})`));
  if (missing.length > 0) {
    throw new Error(`The Terminal or the built-in Tools bundle releases the disclosure does not list: ${missing.join(', ')}. Declare each as a dependency of the package whose build bundles it.`);
  }
}
