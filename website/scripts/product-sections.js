// The workspace packages whose runtime dependency graphs reach a user: onto
// their disk, onto their phone, or into the Workers Dormouse Hosted runs for
// them. A package belongs here however it gets there: `dormouse-sidecar` ships
// as a Tauri bundle resource (`standalone/src-tauri/tauri.conf.json` ->
// `bundle.resources`), node_modules and all; `relay` is installed and run by a
// selfhoster (SELF_HOST.md) — `web-push` in particular signs with a private key
// and makes outbound requests; `dormouse-hosted` is deployed by
// `hosted/package.json`'s `build`. See docs/specs/security-supply-chain.md ->
// "Disclosure".
//
// Each section is disclosed as its own table, walked in this order: a package
// belongs to the first section that reaches it, and a root of a later section is
// not entered from an earlier one, so `dor` -> `dor-tools-builtin` leaves the
// built-in Tools' graph to its own section. A root may serve several sections,
// as `dormouse-lib` does; the first lists its graph.
export const productSections = [
  {
    id: "terminal",
    roots: [
      "dor", // Staged on every Dormouse terminal's PATH.
      "dormouse", // Installed VS Code extension (vscode-ext/package.json).
      "dormouse-standalone", // Installed standalone frontend.
      "dormouse-lib", // Compiled into both hosts; relative imports bypass the VSIX's dependency walk.
      "dormouse-sidecar", // Tauri bundle.resources includes this node_modules tree.
    ],
  },
  {
    id: "builtinTools",
    roots: [
      "dor-tools-builtin", // Bundled into `dor`'s runtime; its viewers load only when a built-in Tool opens a file.
    ],
  },
  {
    id: "relay",
    roots: [
      "relay", // Built and installed by the selfhost runbook.
    ],
  },
  {
    id: "hosted",
    roots: [
      // Hosted's three Workers and the account page. One package, so the walk
      // cannot tell the relay Worker's graph from the account's or voice's.
      "dormouse-hosted",
      // Pocket and the one-time page relay.dormouse.sh serves, from its
      // `build:pocket` and `build:one-time`; `hosted/` declares no edge to it.
      "dormouse-lib",
    ],
  },
];

// These packages reach no user: nothing installed, served to their devices, or
// run for them. Any new workspace requires classification here or a runtime
// edge from a product root.
export const excludedWorkspacePackages = [
  "canopy", // Storybook-only rendering lab; no production build imports it.
  "dormouse-website", // Visitor browser code; no installed artifact, key, or session.
];

/** Each root's section ids, in walk order. */
export const sectionsOfRoot = productSections.reduce((map, { id, roots }) => {
  for (const root of roots) map.set(root, [...(map.get(root) ?? []), id]);
  return map;
}, new Map());

/** Whether `section`'s walk enters workspace `name`: never a root only other sections name. */
export function entersWorkspace(name, section) {
  return !sectionsOfRoot.has(name) || sectionsOfRoot.get(name).includes(section);
}
