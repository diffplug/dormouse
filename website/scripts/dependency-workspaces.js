import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Every package `pnpm-workspace.yaml` lists under `repoRoot`, with its directory and manifest. */
export function getWorkspacePackages(repoRoot) {
  const workspaceYaml = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf-8');
  const dirs = [];
  let inPackages = false;
  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;

    const match = inPackages ? line.match(/^\s*-\s+["']?(.+?)["']?\s*$/) : null;
    if (match) dirs.push(match[1]);
  }
  return dirs.map((dir) => {
    const absoluteDir = resolve(repoRoot, dir);
    return { dir: absoluteDir, pkg: JSON.parse(readFileSync(resolve(absoluteDir, 'package.json'), 'utf-8')) };
  });
}

// Coverage is checked before resolving node_modules: a newly shipped workspace
// must not silently disappear just because no existing root depends on it.
export function assertWorkspaceCoverage(workspacePackages, roots, exclusions) {
  const byName = new Map(workspacePackages.map(({ pkg }) => [pkg.name, pkg]));
  if (byName.size !== workspacePackages.length) {
    throw new Error('Workspace package names must be unique');
  }
  for (const name of [...roots, ...exclusions]) {
    if (!byName.has(name)) throw new Error(`Workspace package "${name}" was not found`);
  }

  const covered = new Set();
  function visit(name) {
    if (covered.has(name)) return;
    covered.add(name);
    const pkg = byName.get(name);
    for (const { name: dependency } of getDependencyNames(pkg)) {
      if (byName.has(dependency)) visit(dependency);
    }
  }
  roots.forEach(visit);
  for (const name of exclusions) {
    if (covered.has(name)) throw new Error(`Excluded workspace "${name}" is reachable from a product root`);
  }
  const excluded = new Set(exclusions);
  const missing = [...byName.keys()].filter((name) => !covered.has(name) && !excluded.has(name));
  if (missing.length) {
    throw new Error(`Unclassified workspace packages: ${missing.join(', ')}. Add product roots or explicit exclusions.`);
  }
}

// `optional` rides along because an unresolvable dependency means something
// different on each edge: a required one is a broken install, an optional one is
// a package this machine cannot hold. A peer edge counts whenever pnpm linked
// the peer for this instance (`linkedPeerPackageJsonPath`): it installs a
// required peer always and an optional one when something in the graph supplies
// it, as `debug` gets `supports-color` in the Relay. pnpm also reads an optional
// peer named only in `peerDependenciesMeta`.
export function getDependencyNames(pkg) {
  const edges = [
    ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false, peer: false })),
    ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true, peer: false })),
  ];
  const declared = new Set(edges.map(({ name }) => name));
  const peerMeta = pkg.peerDependenciesMeta ?? {};
  const peers = new Set([
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(peerMeta).filter((name) => peerMeta[name]?.optional),
  ]);
  for (const name of peers) {
    if (!declared.has(name)) edges.push({ name, optional: Boolean(peerMeta[name]?.optional), peer: true });
  }
  return edges;
}

/**
 * Where pnpm linked `peerName` for this one instance of `packageName`, or null
 * when it linked none. An external package's peers are linked beside it in its
 * own `.pnpm/<id>/node_modules`, which is per peer context; a workspace's in its
 * own `node_modules`. Node resolution would climb on into the hidden hoist
 * (`node_modules/.pnpm/node_modules`) and find a peer pnpm supplied to some other
 * instance, so it is never consulted.
 */
export function linkedPeerPackageJsonPath(packageDir, packageName, peerName, isWorkspace) {
  const linkDir = isWorkspace
    ? join(packageDir, 'node_modules')
    : dirname(packageName.startsWith('@') ? dirname(packageDir) : packageDir);
  if (!isWorkspace && basename(linkDir) !== 'node_modules') {
    throw new Error(`"${packageName}" at ${packageDir} is not inside a node_modules directory, so its peers cannot be located`);
  }
  const candidate = join(linkDir, peerName, 'package.json');
  return existsSync(candidate) ? candidate : null;
}

// What a dependency this machine did not install means
// (docs/specs/security-supply-chain.md -> "Disclosure"). A required edge is a
// broken install. An optional one is absent by design only where a rule covers
// it: an external package's ships to nobody, since every bundle stages only
// what a product root declares (the addon's own list also names builds this
// project never releases, android and musl); a product root's ships on the
// platform that can hold it, so it is described from a sibling; any other
// workspace's has no rule and must not vanish. An optional peer nothing
// supplied is not installed anywhere, so it ships to nobody.
export function missingDependency({ optional, peer, isWorkspace, isProductRoot }) {
  if (!optional) return 'throw';
  if (peer) return 'skip';
  if (!isWorkspace) return 'skip';
  return isProductRoot ? 'describe' : 'throw';
}

/**
 * The names declared beside `packageName` in the same `optionalDependencies`
 * block at the same exact version string. A prebuilt family is published in
 * lockstep from one repository under one pinned version, so any of these
 * describes an absent one exactly — which is also what keeps this disclosure
 * identical on every machine that generates it.
 */
export function optionalSiblingsAtSameVersion(pkg, packageName) {
  const optionalDependencies = pkg.optionalDependencies ?? {};
  const version = optionalDependencies[packageName];
  return Object.keys(optionalDependencies).filter(
    (name) => name !== packageName && optionalDependencies[name] === version,
  );
}

/**
 * Whether `manifest` is a platform build (naming an `os`, `cpu`, or `libc`) that
 * an external package declares optionally. Which one installs depends on the
 * generating machine — `typescript` brings `@typescript/typescript-darwin-arm64`
 * on one and `-linux-x64` on another. A family a product root declares is left
 * to that root, which names only the builds this project ships.
 */
function isExternalPlatformBuild({ optional, isWorkspace }, manifest, productRootOptionals) {
  if (!optional || isWorkspace) return false;
  if (!(manifest.os || manifest.cpu || manifest.libc)) return false;
  return !productRootOptionals.has(manifest.name);
}

/**
 * The siblings to describe from an installed external platform build: it ships
 * wherever a copied `node_modules` does, so the whole family is disclosed.
 */
export function externalPlatformSiblings(edge, manifest, productRootOptionals) {
  if (!isExternalPlatformBuild(edge, manifest, productRootOptionals)) return [];
  return optionalSiblingsAtSameVersion(edge.pkg, manifest.name);
}

/**
 * Whether an installed external platform build has no sibling to describe it
 * from, as `fsevents` has none beside it in `vite`. It is then skipped, as on a
 * machine that cannot install it, where nothing describes it: disclosing it here
 * alone would make the snapshot depend on the generating machine.
 */
export function isLonePlatformBuild(edge, manifest, productRootOptionals) {
  return isExternalPlatformBuild(edge, manifest, productRootOptionals)
    && optionalSiblingsAtSameVersion(edge.pkg, manifest.name).length === 0;
}
