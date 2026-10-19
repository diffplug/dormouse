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
// built-in Tools' graph to its own section.
// A section follows the optional peers pnpm supplied unless it sets
// `optionalPeers: false`.
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
      // Pocket and the one-time page, which relay.dormouse.sh serves, are built
      // from `dormouse-lib`, so the Terminal's root discloses them.
      "dormouse-hosted",
    ],
    // Hosted ships esbuild bundles alone, never a `node_modules`, and a bundle
    // holds an optional peer only if code imports it: `better-auth` declares
    // `vitest` and `next`, which pnpm supplies from the workspace, and imports
    // neither in a Worker.
    optionalPeers: false,
  },
];

// These packages reach no user: nothing installed, served to their devices, or
// run for them. Any new workspace requires classification here or a runtime
// edge from a product root.
export const excludedWorkspacePackages = [
  "canopy", // Storybook-only rendering lab; no production build imports it.
  "dormouse-website", // Visitor browser code; no installed artifact, key, or session.
];

