# Supply Chain Security

> - Owns what Dormouse puts on a user's machine — the dependency graph, the bundled runtime, the themes — how that is disclosed, and the cooldown before a new release is adopted, maintainer tooling outside the lockfile included.
> - Defers the disclosure page's rendering to `docs/specs/website-docs.md -> "Reference page chrome"` and the runtime's build to `docs/specs/standalone.md`.
> - Read `docs/specs/security.md` first; `docs/specs/security-audit.md` says how the `FAIL IF` lines here are run.

## Disclosure

The runtime dependency surface is kept small: a dependency is added only when necessary, each change justified against its supply-chain risk.

**Every dependency Dormouse *puts on a user's machine* is listed at [dormouse.sh/supply-chain](https://dormouse.sh/supply-chain).** The test is narrower than "everything a user runs" (rationale). Three inventories:

- every npm dependency, direct and transitive, by section: Terminal, Built-in Tools, Relay
- every cargo dependency, direct listed separately from transitive
- the Node.js runtime bundled as a Tauri sidecar in the standalone app

Every workspace is classified from its shipping route: a product root or runtime edge if Dormouse writes its files onto a user's disk, an exclusion only if it installs no artifact. The root and exclusion arrays document those routes beside their entries; the audit derives shipping independently from the builds.

**Must disclose each npm release once, in the first section whose roots reach it**; an earlier section never enters a later section's root. **Never call the Built-in Tools optional or unshipped**: every install ships them inside `dor` (what their frame reaches: `docs/specs/security-local.md` → Local-file viewer). **Must merge a package's releases into one row per name and license**, taking author and homepage from the newest release that names them.

**External binaries are outside this graph by construction** — the user's shell, and the CLIs `dor agent-browser` and `dor playwright` forward to (`npm i -g agent-browser`, `npm i -g @playwright/cli`; dependencies of nothing here, resolved off `PATH` or an override variable). **Dormouse instead ships nothing that pulls them in silently** (rationale).

The dependency lists are regenerated and committed with every production dependency change (rationale).

**Cargo discloses build edges but not dev edges, and a git-patched crate at its fork.** `website/scripts/cargo-dependencies.test.js` pins both.

**An unresolvable dependency throws unless an optional-edge rule covers it.** `node-datachannel` publishes one prebuilt package per platform, and pnpm installs only the host's.

- **Optional, declared by an external package: skipped.** The Tauri bundle copies `standalone/sidecar/node_modules` and the VSIX stages only the platform packages `vscode-ext/package.json` declares (`docs/specs/vscode.md` → "The direct path"), so a prebuild the addon alone declares (android, musl) reaches nobody.
- **Optional, declared by a product root: described from a sibling in the same `optionalDependencies` block at the same exact version string** — published in lockstep, so the disclosure is identical on every machine. No such sibling installed throws.

**Bundled themes are disclosed outside that lockfile walk.** The themes compiled into every build (`lib/src/lib/themes/bundled.json`) come from OpenVSX extensions, not npm, so `website/scripts/generate-deps.js` appends the checked-in `lib/src/lib/themes/bundled-extensions.json` to the npm table instead. Both files are committed and can drift (rationale). `lib/src/lib/themes/bundled-extensions.test.ts` pins them, joining on the `extensionId` each disclosure record carries: a bundled theme whose extension has no record, or a record with no bundled theme left, fails. **The join is on the extension set only** — `bundled.json` carries no version or license, so nothing pins a hand-edit to those published fields.

- **FAIL IF** `node website/scripts/generate-deps.js` changes `website/src/data/dependencies-npm.json`, `website/src/data/dependencies-cargo.json`, or `website/src/data/dependencies-runtime.json` when run in a clean checkout of the audited commit after `pnpm install --frozen-lockfile` (rationale).
- **FAIL IF** `.github/workflows/ci.yml` stops running that generator under that same install precondition, or stops failing on a diff (rationale).
- **FAIL IF** the generator stops naming `dormouse-lib` as a root independently of workspace edges (rationale), names a root or exclusion by anything but its package name, or stops rejecting, before generating disclosure, an unclassified workspace or an exclusion reachable from a product root over runtime and optional edges (development edges do not count). The rejection is pinned by `website/scripts/dependency-workspaces.test.js`; the `dormouse-lib` root is not.
- **FAIL IF** the disclosure omits the graph of a workspace whose files reach a user's disk, or excludes such a workspace. A judgement item: derive the routes from `pnpm-workspace.yaml` and the builds — the VSIX (`vscode-ext/package.json`), the Tauri bundle and its sidecar (`standalone/src-tauri/tauri.conf.json`, `standalone/vite.config.ts`), `dor`'s bundle (`dor/package.json`), and the self-host install (`deploy/local/`) — not the generator's arrays, which it enforces but cannot justify (rationale).

Source of truth: `productSections` / `productDependencyFilters` / `excludedWorkspacePackages` / `optionalSiblingsAtSameVersion` in `website/scripts/generate-deps.js`; `assertWorkspaceCoverage` in `website/scripts/dependency-workspaces.js`; `mergeReleases` in `website/scripts/dependency-rows.js`; `getShippedCargoGraph` / `getCargoGitRepository` in `website/scripts/cargo-dependencies.js`.

## Bundled runtime

**The standalone app ships a Node.js runtime binary**, copied into the Tauri bundle as a sidecar by `standalone/src-tauri/build.rs`.

- **Its version is pinned exactly in the root `package.json` under `devEngines.runtime.version`**, and the build is the authority.
- **The supply-chain page reads the same pin**, so the disclosed version provably equals the runtime users receive (rationale).
- **The pin is deliberate and manual** — no automated ecosystem tracks it; workflows that do not bundle the runtime may track the same pinned major.
- Locally, pnpm honours `devEngines` (`onFail: "download"`) so scripts run under the pinned Node; CI drives `actions/setup-node` from the same field through `node-version-file: package.json` (rationale).

The Windows runtime's PE Subsystem field is patched from console (3) to GUI (2) (`docs/specs/standalone.md -> "Windows node subsystem"`; rationale).

- **FAIL IF** the root `package.json` is missing `devEngines.runtime.version`, or its value is not an exact `MAJOR.MINOR.PATCH` Node.js version — a bare major such as `24` is not acceptable. Pinned by `scripts/supply-chain-config.test.mjs`.
- **FAIL IF** `standalone/src-tauri/build.rs` no longer runs `--version` on the binary it is about to bundle and fails the build unless it matches `package.json`'s `devEngines.runtime.version`, or if the check is skipped for any configuration the release matrix builds. One deliberate skip is permitted: `verify_node_version` cannot execute a foreign-arch binary, so it warns and returns when `host != target` — acceptable only while every entry in `release.yml`'s standalone matrix builds on a runner of its own target. A cross-compiled entry, which `resolve_node_binary` admits only when `DORMOUSE_NODE_BINARY` or `NODE_BINARY` names the binary, would bundle it unverified and fails this check.
- **FAIL IF** `standalone/src-tauri/build.rs` patches the Windows runtime other than after `verify_node_version` returns, changes anything but its two-byte PE Subsystem field, or patches a starting value other than console (3).
- **FAIL IF** the `build-standalone` job in `.github/workflows/release.yml` does not install the pinned runtime via `node-version-file: package.json`, **or** the root `package.json` gains a `volta.node` or `engines.node` field — alternate version declarations are forbidden (rationale). Other jobs may pin `node-version` inline since their interpreter is never bundled. Pinned by `scripts/supply-chain-config.test.mjs`.

Source of truth: `bundle_node_runtime` / `verify_node_version` in `standalone/src-tauri/build.rs`; `getBundledRuntimeDependencies` in `website/scripts/generate-deps.js`.

## Cooldown and alerts

**Maturity gating runs in both the pnpm configuration and the Renovate configuration, except for pgstencil releases audited on their main commit, staged, and approved with 2FA.** (rationale)

- **FAIL IF** `pnpm-workspace.yaml` is missing `minimumReleaseAge: 1440`. Pinned by `scripts/supply-chain-config.test.mjs`.
- **FAIL IF** `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` contains anything except `pgstencil` and `@pgstencil/*`, or a Renovate package rule sets `minimumReleaseAge: null` for any package outside `pgstencil` and `@pgstencil/**`. Pinned by `scripts/supply-chain-config.test.mjs`.
- **FAIL IF** `.github/renovate.json` is missing `npm` or `cargo` from `enabledManagers`, limits either with `includePaths` or `ignorePaths`, or lacks a `minimumReleaseAge` package rule covering each of the `patch`, `minor`, and `major` update types for both managers (rationale). Pinned by `scripts/supply-chain-config.test.mjs`.
- **FAIL IF** `.github/renovate.json` has no `vulnerabilityAlerts` block, or that block does not set `minimumReleaseAge` **explicitly**. Renovate's built-in default for that block is `minimumReleaseAge: null`, force-applied before lookup, so *omitting* the key drops the cooldown rather than inheriting it from `packageRules`. Keeping it is deliberate (rationale). Pinned by `scripts/supply-chain-config.test.mjs`.
- **FAIL IF** `install_skills.sh` runs a package through `npx` without an exact version: outside the lockfile, both cooldowns, and Renovate, a hand bump to a release at least a day old is its only gate (rationale). `skills` never checks `skills-lock.json`'s `computedHash`; it installs each source's current default branch (`docs/specs/security.md` -> "Known gaps"). The `npx` rule is pinned by `scripts/supply-chain-config.test.mjs`.
- **FAIL IF** secret scanning or its push protection is disabled on the repository (`gh api repos/diffplug/dormouse --jq .security_and_analysis`), or Dependabot alerts are off (`GET /repos/diffplug/dormouse/vulnerability-alerts` must answer 204, not 404). Push protection is the one control that acts *before* a credential lands, blocking a push whose diff carries a recognized provider token; it applies to `dormouse-bot` too (rationale). Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** zizmor or actionlint, which `.github/workflows/ci.yml` installs outside the lockfile, is not pinned to an exact version and verified by hash (`.github/zizmor-requirements.txt`, the actionlint tarball's SHA-256); each is bumped by hand to a release past the cooldown. Pinned by `scripts/supply-chain-config.test.mjs`.
