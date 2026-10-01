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
// a package this machine cannot hold.
export function getDependencyNames(pkg) {
  return [
    ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
    ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
  ];
}
