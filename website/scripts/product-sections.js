// The workspace packages whose runtime dependency graphs a user actually runs.
// A package belongs here if its dependencies reach a user's disk, however they
// get there: `dormouse-sidecar` ships as a Tauri bundle resource
// (`standalone/src-tauri/tauri.conf.json` -> `bundle.resources`), node_modules
// and all, and `relay` is installed and run by a selfhoster (SELF_HOST.md) —
// `web-push` in particular signs with a private key and makes outbound
// requests. See docs/specs/security-supply-chain.md -> "Disclosure".
//
// Each section is disclosed as its own table, walked in this order: a package
// belongs to the first section that reaches it, and a root of a later section is
// not entered from an earlier one, so `dor` -> `dor-tools-builtin` leaves the
// built-in Tools' graph to its own section. A root may serve several sections;
// the first lists its graph.
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
];

// These packages do not install an artifact on a user's disk. Any new workspace
// requires classification here or a runtime edge from a product root.
export const excludedWorkspacePackages = [
  "canopy", // Storybook-only rendering lab; no production build imports it.
  "dormouse-website", // Visitor browser code; no installed artifact.
  "dormouse-hosted", // Workers and browser code; no desktop or selfhost import.
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
