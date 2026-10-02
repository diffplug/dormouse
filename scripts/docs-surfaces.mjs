import { posix } from 'node:path';

/** Follow relative TypeScript imports from the route-owned entrypoints.
 * Git paths use forward slashes on every OS; native path.join on Windows
 * silently drops imported components from the checked documentation surfaces.
 */
export function collectDocsSurfaces(seeds, files, read) {
  const tracked = new Set(files);
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel) || !tracked.has(rel)) continue;
    seen.add(rel);
    for (const [, spec] of read(rel).matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const resolved = posix.join(posix.dirname(rel), spec);
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
