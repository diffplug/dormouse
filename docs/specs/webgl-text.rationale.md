# WebGL Text Rendering (SDF fork + canopy) — Rationale

> Informative companion to [webgl-text.md](webgl-text.md), keyed by that spec's
> headings. Nothing here is normative.

## Fork pipeline

**Why the peer dependency, not the `-sdfNNN` counter, records the fork base.**
Upstream restarts the beta counter on each release line (`5.6.0-beta.1..143`,
then `6.1.0-beta.1..302`), so a counter alone does not say which line it came
from; only the tarball's `peerDependencies['@xterm/xterm']` names a full
version. Fork releases carry that field as of `0.20.0-sdf301.1`, and
`scripts/xterm-lint.mjs` check 1 is what reads it. The tag and filename check is
the cheaper one: it only catches a URL whose three parts disagree.

**Why release assets rather than a registry.** GitHub Packages requires auth
even for public reads; release assets do not, so a tarball URL installs in a
clean checkout and in CI with no token.

**Why "latest of each" is routinely two commits.** The four `@xterm/*` packages
ship from one repo with independent beta counters, and each addon's peer range
is exactly `^<the core version published from the same commit>`. Because
`^6.1.0-beta.301` happily admits `6.1.0-beta.302`, npm and pnpm say nothing
about the mismatch — and the addons compile against core internals, so it is
real. Equality of the peer range against the core pin is the check;
`semver.satisfies` would not catch it.

**What the `pnpm link` residue is.** pnpm 11's link also writes a `link:`
dependency into the ROOT `package.json` and an `overrides:` entry in
`pnpm-workspace.yaml`, both of which keep resolving the link silently — so a
tarball verification run without reverting them is verifying the working tree.

## Following upstream

**Why `--dry-run` before accepting Renovate's version.** The newest coherent
per-commit set is often an *older* core than Renovate proposed, because Renovate
takes the latest of each package independently and the counters are not aligned.

**Why a conflict-free merge is not a correct one.** Upstream regularly adds
obligations to code the fork extended without anything textually conflicting, so
the merge succeeds while the extension quietly stops honoring the new contract.
FORK.md's `Merging upstream` section carries the same warning.

## SDF glyph architecture

**Why the emoji heuristic errs toward raster.** The two errors are not
symmetric: a text symbol sent to the raster path only loses crispness, while an
emoji sent to the SDF path loses its colors outright. Widening the shared
`isEmoji` range table buys the cheap failure.

**Choosing `sdfGlyphSize`.** Lower = smaller atlas, softer detail; higher = more
corner fidelity under magnification.

**The two ways an alias record goes wrong.** Because page merge/delete
bookkeeping walks every registered record and mutates it in place exactly once,
a color variant that *shared* the canonical record's coordinate vectors would
have them transformed more than once, and one that was never registered on the
page would go stale after a merge.

**Why the RGB is white.** White survives canvas premultiplication exactly, so
the distance stored in the alpha channel round-trips undistorted.

**What `renderScale` buys.** Scaling the quad by device font px ÷
`sdfGlyphSize` is what lets one low-res atlas render crisp at any cell size —
the atlas is rasterized once at the base size and never per font size.

## Canopy lab

**Why PUA glyphs are written as escapes.** The literal characters are invisible
in editors, and were once silently dropped during a file rewrite — which
surfaced as a rendering regression rather than as a diff anyone could read.
