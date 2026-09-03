# Supply Chain Security — rationale

## Disclosure

Why the test is "puts on a user's machine" rather than "everything a user runs": `website` runs in a visitor's browser rather than being installed anywhere, and the supply-chain page says as much about its own React and react-router. Excluding it is what makes the narrower test the operative one, and it is a judgement worth re-making if the site ever ships something a visitor installs.

Why `dormouse-lib` has to be named a root rather than left as a workspace edge: `vscode-ext` declares only `node-pty` and `ws`, reaching the lib through relative imports into `../lib/src/` from fifteen files, so the extension's dependency walk never arrives at it. Only `dormouse-standalone`'s edge would — which puts the disclosure of lib's entire subtree one refactor away from silently vanishing. Naming it a root is what makes that not matter.

Why external binaries cannot be disclosed: Dormouse is a terminal, so it spawns the user's shell, and `dor ab` forwards to an `agent-browser` CLI the user installs themselves and that is resolved off `PATH`. Those are the user's software, not ours, and disclosing them is neither possible nor meaningful.

Where the snapshots come from: they are generated from the lockfiles and reviewed as part of release work. The `pnpm install --frozen-lockfile` precondition matters because a stale `node_modules` makes the regeneration check pass locally on a tree that would fail in CI.

Why CI, and not the nightly audit, gates the regenerated snapshots: until the gate existed the nightly audit was the only thing that ever ran the generator, and two production bumps (`ws`, `hono`) shipped undisclosed before it caught them. A nightly finding of a stale disclosure means it already merged; the CI gate is what keeps it from merging.

Why the two theme files can drift despite coming from one run of `lib/scripts/bundle-themes.mjs`: both are committed and the script needs network access, so an edit to one need not be accompanied by a re-run. Regenerating the disclosure then produces no diff, which is precisely the class the stale-snapshot gate cannot see — hence a separate test.

Why being a devDependency of the repo does not count as covered: a selfhoster's `pnpm install` would otherwise drag the whole toolchain into the disclosure.

## Bundled runtime

What the pin buys the disclosure: because the supply-chain page reads the same `devEngines.runtime.version`, the published runtime version cannot drift to whatever Node happened to be on the build machine's `PATH`.

Why the Windows subsystem byte is flipped: leaving the bundled `node.exe` as a console-subsystem binary lets Windows Terminal's default-terminal handoff spawn a stray terminal window behind the app.

Why the patch is safe: Node reads its stdio handles from `STARTUPINFO`, which is subsystem-agnostic, so the flipped field changes nothing about Node.js semantics.

Why the absence of `volta.node` and `engines.node` is load-bearing: adding either would silently change the bundled runtime, with no diff to the workflow to show that it had.

## Cooldown and alerts

What the `minimumReleaseAge` package rules are: the Renovate equivalent of the pnpm dependency cooldown window, applied per manager.

Why the `vulnerabilityAlerts` cooldown is kept rather than dropped for speed: it guards the opposite threat from the alert itself — a compromised release that gets yanked within a day, which a reviewer reading a dependency diff cannot detect the way the ecosystem's own yank process can. Nothing here auto-merges, and the Dependabot alert already makes the vulnerability visible the moment it is published, so what the cooldown costs is a day before the remediation PR appears, not a day before anyone knows.

Why push protection covering `dormouse-bot` is the point rather than an incidental: an injected agent pasting a token into a file is exactly the shape it stops.
