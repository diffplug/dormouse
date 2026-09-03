# CI and Release Security — rationale

> Informative companion to [security-ci.md](security-ci.md): evidence keyed by that spec's headings. Nothing here is normative.

## GitHub Actions Policies

**Why the release audit is dispatched, not called.** `claude-code-action` rejects the `push` event that a tag-triggered `workflow_call` would inherit, and `GITHUB_EVENT_NAME` is a default variable that cannot be overridden, so a `workflow_dispatch` run is the only way to exercise the audit under a supported event. That is why the `security-audit` job in `release.yml` holds `actions: write` at all — the one write permission a non-agent-managed workflow is granted beyond release provenance.

## Automated Maintainer (tend)

**Why instruction files are a class of their own.** They are not read as data the way a diff is; Claude Code loads them as authoritative guidance, which is what makes a fork PR's copy of them a different class of input from the fork's code.

**The `0.1.18` gap, reported from this audit and now fixed.** At the previously pinned `0.1.18` the revert list was a flat, root-relative `SENSITIVE` array naming `CLAUDE.md` but no `AGENTS.md` at all — and this repo keeps its instructions in `AGENTS.md` with `CLAUDE.md` as a one-line `@AGENTS.md` pointer, so the control reverted a pointer and left the content it pointed at attacker-controlled. The fix ([max-sixty/tend#1005](https://github.com/max-sixty/tend/pull/1005), merged 2026-08-22, released in `0.1.19` on 2026-08-26) replaces that list with pathspec globs — `':(glob)**/AGENTS.md'`, `':(glob)**/CLAUDE.md'`, `':(glob)**/.claude/**'` — which `restore-sensitive-config.sh` passes to `pin_to_base`, covering every depth rather than a hand-enumerated set of root paths. This repo regenerated onto `0.1.19`, so the gap is closed here rather than merely closable.

**The local remedy if it ever regresses.** The nightly regen overwrites the *workflow*, not this repository's instruction files, so moving the instruction body into `CLAUDE.md` and dropping the pointer would close it with no upstream dependency, at the cost of the filename convention other agent harnesses read.

**What credential isolation does and does not buy.** An injected instruction can make the bot *act* within its permissions — comment, push a feature branch — but cannot read the token value out and exfiltrate it. The worst-case table is therefore about what the bot's identity can do, not about the secret escaping.

**How every other generated workflow picks its subjects.** An event payload names the PR, issue, or comment (`tend-review`, `tend-triage`, `tend-mention`, `tend-ci-fix`), or a scheduled sweep works a fixed list — recent commits, dependency PRs, last night's runs.

**Evidence that the subscription PUT has taken effect.** Asking as the bot (`gh api repos/diffplug/dormouse/subscription` → `subscribed: true`), corroborated without the bot credential through the public `GET /repos/diffplug/dormouse/subscribers` listing.

**Watching is not a permission change.** `notifications` is already in the PAT scopes, and watching reads rather than writes. What sits in the prompt instead of the trigger is the notifications skill, which says to respond on an existing thread only when the activity addresses the bot, while a new issue or PR from an external author may be triaged or reviewed outright.

**Why the inert `anthropic_api_key` input is handled by enforcement, not deletion.** The input is upstream-generated and cannot be removed locally without being overwritten by the next nightly regen. The moment anyone adds an `ANTHROPIC_API_KEY` secret for an unrelated reason, eight bot-triggered workflows would start reading it with no code change and no review.

**The org secrets that no longer need accepting.** `BUILDCACHE_USER` and `NEXUS_USER` were org-wide shares — visible to every `diffplug` repository, not grants made to this one — and were previously accepted on the grounds that they are usernames rather than the paired credentials. They have since been narrowed to `selected` visibility over the repositories that actually consume them, which excludes this one, so the acceptance no longer has to be made. Every `diffplug` org secret is now `selected`, and none lists `diffplug/dormouse`.

**Why the mutable upstream tag is accepted.** The file is generated — a hand-edited SHA is overwritten by the next nightly regen, so pinning locally is not durable — and the trust it represents is the same trust the harness already has: tend runs the agent that holds `TEND_BOT_TOKEN` either way.

**What unites the four `WINDOW` paths.** Each executes from a branch nobody reviewed — a workflow on a bot push, a `folderOpen` task on checkout, a prompt that decides what the nightly audit even looks at. `.config/tend.yaml` is in the window because its values are inputs to the generated workflows, making an edit to it a workflow change made one step earlier; keeping it out would let a config edit and a regeneration be split across two commits, the first invisible to the audit and the second reproducing byte-for-byte against it. The two enumerations have to agree because a path added to one without the other leaves a reader checking the `FAIL IF` against a paragraph that contradicts it.

**Why signed author/committer is the Renovate classifier's provenance control.** GitHub's automatically signed `createCommitOnBranch` mutation binds the author to the authenticating credential and does not permit the caller to supply the author or committer, while REST paths that permit those fields require the caller to supply the signature; requiring `web-flow` therefore rejects both a caller-supplied Renovate author and a commit signed by another identity. PR authorship is independent server-side corroboration, and the content test adds a separate bound by requiring the diff to express nothing but a new ref for an action already referenced by name.

**Why the tend-regeneration classifier refuses a commit that also edits `.config/tend.yaml`.** The config's values land verbatim in the generated YAML: such a commit would reproduce by construction, making "reproducible" contingent on the upstream generator escaping its inputs.

**Why merged commits are still reported.** Review is not proof — the social-engineering path ends in an admin merge.

**Why the lower bound stays server-set.** It is what stops the window from being attacker-movable in both directions at once; the `--since` committer-date comparison already moves one end.

**Why the secret inventory is placement-checked.** Env-scoping is what stops a workflow pushed to an excluded branch from reading a secret, so a repo-level copy of an environment secret reopens exactly what the environment gate closes. The `release-attest` environment exists only to bound the ref a provenance OIDC token can be minted from.

**Why `CHROMATIC_PROJECT_TOKEN` is listed in `secrets.allowed`.** The entry is an explicit acknowledgment that the bot can read that token.

**Why 48 hours is thinner than it reads.** `workflow-audit` runs at 07:13 UTC and the security audit at 04:21, so the steady state is ~21.5h and a single skipped run lands at ~45.5h — inside tolerance by under three hours, which is why one skipped run is a signal rather than noise.

**Why the `0.1.19` floor matters.** The revert list is upstream code: the protection this repo gets is whatever the pinned version implements, and a downgrade reopens the fork-PR instruction-injection path with no visible change to any file here except a version number.

**Why "effective, not declared" is the whole point.** A job that declares nothing textually "grants" nothing while its token carries nine write scopes. And with `default_workflow_permissions` at `write`, one regenerated workflow that omits a `permissions:` block silently reopens what every permission bullet closes — the repository setting is the only durable fix, since a YAML edit does not survive the nightly regen.

## VS Code Extension Releases

**Why the second clause is repo-wide.** Scoping it to `release.yml` would let a `VSCE_PAT` or `OVSX_PAT` reference from another workflow file pass unremarked.

## Desktop Releases

**Why argv exposure matters more here than usual.** `pnpm exec` means a dependency's lifecycle scripts share that session, so a `ps` reader is not hypothetical.

**Why one of the three is env-only and two are not.** `TAURI_SIGNING_PRIVATE_KEY` used to be passed both on argv and through the environment; `tauri signer sign` documents `--private-key` as falling back to the variable, so the argv copy was redundant exposure and was removed. The other two stay on a command line only because their tools offer nowhere else to put them.
