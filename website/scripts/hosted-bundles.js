import { builtinModules, createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  const scripts = [...readFileSync(join(hosted, 'index.html'), 'utf-8').matchAll(/<script[^>]*\stype="module"[^>]*\ssrc="\/([^"]+)"/g)];
  if (scripts.length === 0) throw new Error('hosted/index.html: no module script to bundle');
  if (workers.length === 0) throw new Error('hosted/: no wrangler*.jsonc to bundle');
  return [...workers, ...scripts.map(([, entry]) => ({ entry, platform: 'browser' }))];
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
