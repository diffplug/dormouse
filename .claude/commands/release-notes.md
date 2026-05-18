---
name: release-notes
description: Draft release notes, recommend and apply a version bump, and update CHANGELOG.md for the next mouseterm release by analyzing all merge commits and squash-merged PRs since the last release tag. Used as step 2 of the release checklist in docs/specs/deploy.md.
user-invocable: true
---

You are drafting release notes, recommending and applying a version bump, and updating CHANGELOG.md for the next mouseterm release.

## 1. Gather context

Run these commands and read their output:

```bash
git describe --tags --abbrev=0
git log $(git describe --tags --abbrev=0)..HEAD --merges --first-parent --pretty=format:'%H %s'
git log $(git describe --tags --abbrev=0)..HEAD --first-parent --pretty=format:'%H %s'
```

The second command catches true merge commits; the third catches squash-merged PRs that don't appear as merges. Deduplicate by SHA. If a commit subject contains no PR number (e.g. `(#123)` or `Merge pull request #123`), treat it as a direct push and still include it (link to the commit instead of a PR).

For each PR/commit in the range:
- Read the diff with `git show <sha>` to understand what actually changed — do not rely solely on the commit message
- Note whether it touches `standalone/`, `vscode-ext/`, `lib/`, or shared infrastructure

Also read the current version from `standalone/src-tauri/tauri.conf.json` so you can propose the next one.

## 2. Decide the version bump

mouseterm uses **breaking.added.bugfix** semantics (semver-shaped, but named for what each segment means here):

- **breaking** (major) — bump if any change breaks behavior users rely on, removes a feature, or changes a VSCode extension contribution point in an incompatible way
- **added** (minor) — bump if any change adds a new user-facing feature, with no breaking changes
- **bugfix** (patch) — bump only if all changes are bug fixes, docs, internal refactors, or dependency bumps

Pick the highest-severity bump that any single change requires.

## 3. Run the version bump

Run `./scripts/bump-version.sh X.Y.Z` with the recommended version before editing the changelog. Show the script's output so the user can review the diff stat.

## 4. Edit `CHANGELOG.md`

Edit `CHANGELOG.md` directly — insert a new section above the most recent existing release, in this exact shape:

```markdown
## [X.Y.Z] - YYYY-MM-DD

_Recommended bump: **<breaking|added|bugfix>** — <one-sentence justification naming the change that drives it>._

### Added
- Summary that affects both artifacts (no leading emoji) ...
- 🔌 VS Code-only summary ...
- 🖥️ Standalone-only user-facing summary ([#123](https://github.com/diffplug/dormouse/pull/123)).

### Changed
- ...

### Fixed
- ...
```

Rules for the entries:
- One line per PR, written in user-facing terms (not "refactored X" — say what the user sees)
- Lead each entry with the artifact emoji from the header at the top of `CHANGELOG.md`: 🖥️ for standalone-only, 🔌 for VS Code plugin-only, no emoji for changes that ship in both. Decide based on whether the user-visible behavior actually surfaces in each artifact — a PR that touches `lib/` is *both* only if both artifacts consume that code path; otherwise it's whichever one ships it.
- Within each of Added / Changed / Fixed, sort entries by artifact: items that affect both (no emoji) first, then VS Code-only (🔌), then standalone-only (🖥️).
- Link the PR using `https://github.com/diffplug/dormouse/pull/<N>`. For direct-push commits with no PR, link the commit instead: `https://github.com/diffplug/dormouse/commit/<sha>`
- Omit any of Added / Changed / Fixed if it would be empty
- Use today's date (`YYYY-MM-DD`) and the recommended `X.Y.Z`

Do not ask the user to paste it themselves — make the edit. The earlier flat-bullet entries (0.8.0 and below) are legacy; do not reformat them.

## 5. Finish

Do not run `website/scripts/generate-changelog.js` as part of the release-notes command. `website/src/data/changelog.json` is a gitignored generated artifact, and the website `prebuild`, `predev`, and `pretest` lifecycle scripts regenerate it from `CHANGELOG.md`.

Then remind the user of the next step:

> Review the diff, then `git commit -am 'Release vX.Y.Z'` and `git tag vX.Y.Z`.
