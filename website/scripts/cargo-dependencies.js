// The Cargo packages the standalone app ships, from `cargo metadata`.
// Development edges ship nothing; Cargo resolves them only for the root.
export function getShippedCargoGraph(metadata) {
  const nodesById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const rootNode = nodesById.get(metadata.resolve.root);
  if (!rootNode) throw new Error("Could not find root package in Cargo metadata");

  const directDeps = rootNode.deps.filter((dep) => dep.dep_kinds.some((kind) => kind.kind !== "dev"));
  const shippedIds = new Set();
  const pending = directDeps.map((dep) => dep.pkg);
  while (pending.length > 0) {
    const id = pending.pop();
    if (shippedIds.has(id)) continue;
    shippedIds.add(id);
    pending.push(...nodesById.get(id).deps.map((dep) => dep.pkg));
  }
  return { directDeps, shippedIds };
}

// A crate patched to a git fork ships the fork's code, so it is disclosed there.
export function getCargoGitRepository(source) {
  if (!source?.startsWith("git+")) return null;
  return source.slice("git+".length).replace(/[?#].*$/, "").replace(/\.git$/, "");
}
