import { posix } from 'node:path';

/** Follow relative TypeScript imports from the route-owned entrypoints.
 * Git paths use forward slashes on every OS; native path.join on Windows
 * silently drops imported components from the checked documentation surfaces.
 *
 * `aliases` maps a bare specifier prefix to the repo path it resolves to, so a
 * surface shared from another package is still followed; `roots`, when given,
 * bounds the walk to those path prefixes, so a shared module's own relative
 * imports do not drag in the rest of its package.
 */
export function collectDocsSurfaces(seeds, files, read, { aliases = {}, roots } = {}) {
  const tracked = new Set(files);
  const seen = new Set();
  const queue = [...seeds];
  const resolve = (rel, spec) => {
    if (spec.startsWith('.')) return posix.join(posix.dirname(rel), spec);
    const prefix = Object.keys(aliases).find((alias) => spec.startsWith(alias));
    return prefix === undefined ? null : aliases[prefix] + spec.slice(prefix.length);
  };
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel) || !tracked.has(rel)) continue;
    seen.add(rel);
    for (const [, spec] of read(rel).matchAll(/from\s+["']([^"']+)["']/g)) {
      const resolved = resolve(rel, spec);
      if (resolved === null) continue;
      if (roots && !roots.some((root) => resolved.startsWith(root))) continue;
      for (const ext of ['.tsx', '.ts']) {
        if (tracked.has(resolved + ext)) queue.push(resolved + ext);
      }
    }
  }
  return {
    surfaces: [...seen].filter(rel => rel.endsWith('.tsx')).sort(),
    missingSeeds: seeds.filter(rel => !tracked.has(rel)),
  };
}
