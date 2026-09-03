# Supply Chain Security

> Owns what Dormouse puts on a user's machine — the dependency graph, the bundled runtime, the themes — how that is disclosed, and the cooldown before a new release is adopted. Defers the disclosure page's rendering to `docs/specs/website-docs.md -> "Reference page chrome"` and the runtime's build to `docs/specs/standalone.md`.
> Read `docs/specs/security.md` first; `docs/specs/security-audit.md` says how the `FAIL IF` lines here are run.

## Disclosure

**Keep the runtime dependency surface small: add a dependency only when it is necessary**, and justify each change against its supply-chain risk.

**Every dependency Dormouse *puts on a user's machine* is listed at [dormouse.sh/supply-chain](https://dormouse.sh/supply-chain).** The test is narrower than "everything a user runs" (rationale). Three inventories:

- every npm dependency, direct and transitive
- every cargo dependency, direct listed separately from transitive
- the Node.js runtime bundled as a Tauri sidecar in the standalone app

The roots are `productDependencyFilters` in `website/scripts/generate-deps.js`. **A workspace package is a root if Dormouse writes its files onto a user's disk, whatever the route.**

| Root | Route onto the disk |
| --- | --- |
| `dormouse-standalone` | installed |
| `dormouse` | the VS Code extension, installed |
| `dormouse-sidecar` | rides inside the Tauri bundle as a `bundle.resources` tree, `node_modules` intact |
| `dor` | staged onto every terminal's `PATH` |
| `server` | built and installed by a selfhoster ([SELF_HOST.md](../../SELF_HOST.md)) — notably `web-push`, signing with a private key and making outbound requests |
| `dormouse-lib` | compiled into both hosts, yet the VS Code extension's dependency walk never arrives at it (rationale) |

**`dormouse-lib` is a root in its own right, not a workspace edge**; `server-lib-common` and `dor-lib-common` are workspace edges from those roots. **Roots are package names, not directory names**, differing once: `vscode-ext/` declares itself `dormouse`.

**Two workspace packages are deliberately not roots:**

- `canopy` — a Storybook-only rendering lab no shipped build imports.
- `website` — runs in a visitor's browser rather than being installed anywhere, which is what makes "puts on a user's machine" the operative test (rationale).

**External binaries are outside this graph by construction** — the user's shell, and the `agent-browser` CLI `dor ab` forwards to (`npm i -g agent-browser`, a dependency of nothing here, resolved off `PATH`). **Dormouse instead ships nothing that pulls them in silently** (rationale).

**Regenerate and commit the dependency lists whenever a production dependency is added, removed, or upgraded** (rationale).

**Bundled themes are disclosed outside that lockfile walk.** The themes compiled into every build (`lib/src/lib/themes/bundled.json`) come from OpenVSX extensions, not npm, so `website/scripts/generate-deps.js` appends the checked-in `lib/src/lib/themes/bundled-extensions.json` to the npm table instead. The two come from one run of `lib/scripts/bundle-themes.mjs` but both are committed and can drift, which the CI gate below cannot see (rationale). `lib/src/lib/themes/bundled-extensions.test.ts` pins them, joining on the `extensionId` each disclosure record carries: a bundled theme whose extension has no record, or a record with no bundled theme left, fails. **The join is on the extension set only** — `bundled.json` carries no version or license, so nothing pins a hand-edit to those published fields.

- **FAIL IF** `node website/scripts/generate-deps.js` changes `website/src/data/dependencies-npm.json`, `website/src/data/dependencies-cargo.json`, or `website/src/data/dependencies-runtime.json` when run against a clean working tree after `pnpm install --frozen-lockfile`. The install is a precondition: the generator walks real `node_modules` directories and throws rather than under-reporting if they are absent.
- **FAIL IF** `.github/workflows/ci.yml` stops running that generator under that same install precondition, or stops failing on a diff (rationale).
- **FAIL IF** `productDependencyFilters` in `website/scripts/generate-deps.js` omits a workspace package whose files Dormouse writes onto a user's disk — today the six above, `canopy` and `website` excluded. Derive the set from `pnpm-workspace.yaml`, not the enumeration: a package in neither the roots nor the exclusions is the failure, since regenerating cannot catch a root that was never walked. A workspace *edge* from a root counts as covered; a devDependency of the repo does not (rationale).

## Bundled runtime

**The standalone app ships a Node.js runtime binary**, copied into the Tauri bundle as a sidecar by `standalone/src-tauri/build.rs`.

- **Its version is pinned exactly in the root `package.json` under `devEngines.runtime.version`**, and the build is the authority.
- **The supply-chain page reads the same pin**, so the disclosed version provably equals the runtime users receive (rationale).
- **The pin is deliberate and manual** — no automated ecosystem tracks it; workflows that do not bundle the runtime may track the same pinned major.
- Locally, pnpm honours `devEngines` (`onFail: "download"`) so scripts run under the pinned Node; CI drives `actions/setup-node` from the same field, and `node-version-file: package.json` resolves by precedence: `volta.node`, then `devEngines.runtime`, then `engines.node`.

**On Windows the build then flips one byte of the bundled `node.exe`** — the PE Optional Header's `Subsystem` field, `IMAGE_SUBSYSTEM_WINDOWS_CUI` (3) to `IMAGE_SUBSYSTEM_WINDOWS_GUI` (2) (`docs/specs/standalone.md -> "Windows node subsystem"`). **The version check runs before the byte flip**, the patch leaves Node.js semantics unchanged, and the bundled `node.exe` differs from the upstream archive at exactly that 2-byte field (rationale).

- **FAIL IF** the root `package.json` is missing `devEngines.runtime.version`, or its value is not an exact `MAJOR.MINOR.PATCH` Node.js version — a bare major such as `24` is not acceptable.
- **FAIL IF** `standalone/src-tauri/build.rs` no longer runs `--version` on the binary it is about to bundle and fails the build unless it matches `package.json`'s `devEngines.runtime.version`, or if the check is skipped for any configuration the release matrix builds. One deliberate skip is permitted: `verify_node_version` cannot execute a foreign-arch binary, so it warns and returns when `host != target` — acceptable only while every entry in `release.yml`'s standalone matrix is host-native; a cross-compiled entry ships an unverified runtime and fails this check.
- **FAIL IF** the `build-standalone` job in `.github/workflows/release.yml` does not install the pinned runtime via `node-version-file: package.json`, **or** the root `package.json` gains a `volta.node` or `engines.node` field — `setup-node` reads this pin only while the higher-precedence fields above are absent (rationale). Other jobs may pin `node-version` inline since their interpreter is never bundled.

## Cooldown and alerts

**Maturity gating runs in both the pnpm configuration and the Renovate configuration.**

- **FAIL IF** `pnpm-workspace.yaml` is missing `minimumReleaseAge: 1440`.
- **FAIL IF** `.github/renovate.json` is missing `npm` or `cargo` from `enabledManagers` (npm covers `/`; cargo covers `/standalone/src-tauri`), or is missing `minimumReleaseAge` package rules for those managers (rationale).
- **FAIL IF** `.github/renovate.json` has no `vulnerabilityAlerts` block, or that block does not set `minimumReleaseAge` **explicitly**. Renovate's built-in default for that block is `minimumReleaseAge: null`, force-applied before lookup, so *omitting* the key drops the cooldown rather than inheriting it from `packageRules`. Keeping it is deliberate (rationale).
- **FAIL IF** secret scanning or its push protection is disabled on the repository (`gh api repos/diffplug/dormouse --jq .security_and_analysis`), or Dependabot alerts are off (`GET /repos/diffplug/dormouse/vulnerability-alerts` must answer 204, not 404). Push protection is the one control that acts *before* a credential lands, blocking a push whose diff carries a recognized provider token; it applies to `dormouse-bot` too (rationale).
