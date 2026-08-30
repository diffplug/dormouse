# WebGL Text Rendering (SDF fork + canopy)

Dormouse's 3D/WebXR terminal effort needs text that stays crisp when a terminal
is rendered at arbitrary scale and orientation — a texture in a 3D scene, not a
1:1 pixel grid. This spec covers the three layers that deliver that: the
diffplug/xterm.js fork pipeline, the signed-distance-field (SDF) glyph
architecture inside the forked webgl addon, and the `canopy/` Storybook lab
that exercises and regression-tests it.

The fork's own process doc is
[FORK.md on the `sdf` branch](https://github.com/diffplug/xterm.js/blob/sdf/FORK.md);
this spec does not restate its release recipe. `addons/addon-webgl/` paths
below are in the fork repo (cloned at `~/projects/xterm.js`; the release
tarball also ships `src/`, so they are readable from `canopy/node_modules`).

**Two webgl addons, one repo.** Production terminals render through *stock*
`@xterm/addon-webgl` (`docs/specs/layout.md` → "Renderer"); only `canopy/`
consumes the SDF fork, and everything below is about the fork.

## Fork pipeline

- **Repo/branches**: `master` on diffplug/xterm.js is a pristine fast-forward
  mirror of upstream; `sdf` (the default branch) carries our changes.
  Upstreamable fixes branch off `master` and are cherry-picked into `sdf`.
- **Versioning**: published as `@diffplug/xterm-addon-webgl-sdf`, versions
  shaped `<addon-version>-sdf<coreBeta>.<iteration>` (`0.20.0-sdf301.1` = built
  from the commit of `@xterm/xterm@6.1.0-beta.301`, iteration 1). The addon
  bundles xterm core internals, so consumers pin the exact `@xterm/xterm` beta
  it was built from. Since `0.20.0-sdf301.1` the tarball declares
  `peerDependencies: { '@xterm/xterm': '^<that beta>' }` (upstream's
  `bin/publish.js` injects it; our hand-cut `npm pack` skips it, so earlier
  tarballs have none) — the authoritative record of the base, because it names
  a *full* version while the `-sdfNNN` counter restarts on each upstream
  release line (`5.6.0-beta.1..143`, then `6.1.0-beta.1..302`).
- **Distribution**: GitHub Release assets consumed as a pnpm tarball-URL
  dependency, not an npm registry — GitHub Packages requires auth even for
  public reads, release assets do not. The lockfile records a sha512 integrity
  hash; treat published assets as immutable and cut a new iteration instead.
- **Canopy's three pins move by hand, together.** Renovate cannot see tarball
  URLs, so it would drift canopy's two sibling `@xterm/*` pins off the fork
  base unnoticed; `.github/renovate.json` therefore disables `@xterm/**` scoped
  to `canopy/package.json`. Bumps are manual edits, or
  `node scripts/xterm-bump.mjs --canopy <forkVersion>`, which rewrites the
  tarball URL and both pins from the commit the fork version encodes. `lib/`
  and `standalone/` keep tracking upstream betas as one grouped `xterm` PR, so
  between fork rebases the two can sit on different `@xterm/xterm` betas — that
  divergence is expected and confined to the Storybook-only lab.
- **Upstream pins are per-commit, not per-latest.** The four `@xterm/*`
  packages ship from one repo but carry independent beta counters — an addon is
  published only when its own content changes — and each addon's
  `peerDependencies['@xterm/xterm']` names the exact core version published
  from the same commit. So "the latest of each" is routinely a set spanning two
  commits, and because `^6.1.0-beta.N` admits every later beta, nothing in npm
  or pnpm complains while addons run against core internals they were not
  compiled against. `scripts/xterm-lint.mjs` (offline, in `pnpm test`) enforces
  what this depends on: every `@xterm/*` pin is an exact version, never a
  range; every addon pin's peer range equals `^` its workspace's core pin — the
  fork tarball included, which is what makes the canopy lockstep exact rather
  than counter-deep; `lib` and `standalone` agree; and canopy's tarball URL is
  self-consistent (tag, filename and `-sdfNNN` counter agree with the core pin,
  which independently catches a release whose tag misstates the base its peer
  range declares). `scripts/xterm-bump.mjs` (`pnpm bump:xterm`) writes the
  newest set all four packages published from one commit into `lib/` and
  `standalone/`, refusing to write one the lint would reject.
- **Releases are hand-cut today** (build, `npm pack`, `gh release create` per
  FORK.md); automating this is staged in `## Future`.
- **Dev loop**: `pnpm link ~/projects/xterm.js/addons/addon-webgl` from
  `canopy/`. Caution: pnpm 11's link writes persistent residue — a `link:`
  dependency in the *root* `package.json` and an `overrides:` entry in
  `pnpm-workspace.yaml` — which silently keeps resolving the link. Revert both
  and reinstall before trusting a tarball verification.

Source of truth: `canopy/package.json` (pins), `canopy/README.md` (bump flow),
`scripts/xterm-lint.mjs` + `scripts/xterm-bump.mjs` (the pin invariants and the
tool that satisfies them), FORK.md in the fork.

## Following upstream

An `@xterm/*` bump is not a dependency chore that stops at `lib/` and
`standalone/` — it is the trigger to re-evaluate the fork. Leaving the fork on
an older base makes canopy's `UpstreamVsFork` harness compare against an
upstream we no longer ship, which is the one thing the harness exists to
prevent. Each time Renovate opens the grouped `xterm` PR:

1. **Read the upstream diff first** and decide what it is worth.
   `node scripts/xterm-bump.mjs --dry-run` names the newest coherent set (often
   an older core than Renovate proposed), prints the commit range from canopy's
   fork base to it, and lists that range's files under `addons/addon-webgl/`.
   Most betas touch none of them, so the bump is a no-op for us and the fork
   does not move; when they do, that diff is the risk assessment.
2. **Rebase and release the fork** per the `Merging upstream` section of
   FORK.md — including its warning that a conflict-free merge is not a correct
   one, because upstream regularly adds obligations to code we extended without
   anything conflicting.
3. **Bump `canopy/package.json`** with `--canopy <forkVersion>`, and update the
   version/commit triple in both places that record it (see "Canopy lab").

Land all of it in the same PR as the `@xterm/*` bump, so the tree never records
a state where lib and the fork disagree about which upstream they track.

## SDF glyph architecture

Fork-internal, and reachable only through the fork-added addon options
`sdf: boolean` (default false — upstream behavior is untouched when off) and
`sdfGlyphSize: number`, documented in the fork's
`addons/addon-webgl/typings/addon-webgl.d.ts`.

- **Eligibility**: plain text glyphs render as SDFs. The pixel-accurate raster
  path is retained for custom glyphs (box drawing/block/powerline drawn by the
  custom-glyph rasterizer), powerline-range glyphs, decorated cells
  (underline/strikethrough/overline), glyphs treated as background colors, and
  probable color emoji (`isProbablyEmoji`, which widens the shared `isEmoji`
  range table and errs toward raster — a text symbol going raster only costs
  crispness; an emoji going SDF would lose its colors).
- **Rasterization**: `SdfGlyphRasterizer` is a vendored adaptation of
  mapbox/tiny-sdf (BSD-2-Clause, attribution in its header): xterm's
  `TEXT_BASELINE` metrics, a dynamically sized scratch canvas for wide/CJK and
  combined-character strings, per-draw font weight/style. Its padding buffer is
  sized so the distance field decays to zero inside the bitmap, which
  guarantees LINEAR atlas sampling never bleeds between packed glyphs.
- **`sdfGlyphSize`**: the fixed base font size (px) glyphs are rasterized at —
  explicit, default 32, never derived from the terminal font size or
  devicePixelRatio. Lower = smaller atlas, softer detail; higher = more corner
  fidelity under magnification.
- **Color-free atlas**: the atlas has no notion of color for SDF glyphs.
  Exactly one texture entry exists per shape (chars + weight + style); each
  additional color gets a lightweight record sharing that entry with its own
  tint, registered via `AtlasPage.addGlyphAlias`. Invariant: page merge/delete
  bookkeeping mutates every registered glyph record in place exactly once — so
  color variants carry their own coordinate vectors (shared vectors would be
  transformed multiple times) and must be registered on the page (an
  unregistered record would go stale after a merge). Aliases do not count
  toward used-pixels; the canonical record owns the texels.
- **Texel format**: distance lives in the atlas alpha channel with white RGB
  (white survives canvas premultiplication exactly; the shader reads only
  alpha for SDF glyphs). Reserved: each texel holds one plain distance field —
  no packing of multiple glyphs into separate color channels — so the texel
  layout stays compatible with the MSDF item in `## Future`.
- **Shader/renderer**: the instance layout is 16 floats per cell (upstream:
  11), adding a straight-alpha tint vec4 and an SDF flag. Quads scale by the
  glyph's `renderScale` (device font px ÷ `sdfGlyphSize`), which is what lets
  a low-res atlas render crisp at any cell size. The fragment shader
  reconstructs coverage with an `fwidth`-based smoothstep at the edge
  threshold `1 - SDF_CUTOFF` (the constant is imported from the rasterizer, so
  encode and decode cannot drift). Upstream merges that touch GlyphRenderer
  vertex code need care — FORK.md calls this out.

Source of truth (fork repo): `addons/addon-webgl/src/SdfGlyphRasterizer.ts`,
`addons/addon-webgl/src/TextureAtlas.ts` (`_drawToCacheSdf`,
`_rasterizeSdfShape`, `_allocateGlyphSpace`),
`addons/addon-webgl/src/GlyphRenderer.ts`.

## Canopy lab

`canopy/` is a Storybook-only workspace package (port 6007, `pnpm dev:canopy`),
deliberately independent of `dormouse-lib`, and outside the production build —
the root `build` script covers only vscode + website, though canopy's `test`
(a `tsc` typecheck) does run under `pnpm test`. Its stories are the visual
harness for the fork:

- `ColorsAndGlyphs` / `TextureAtlas` — stock fork rendering (`sdf: false`) and
  its live glyph atlas.
- `Sdf` / `SdfTextureAtlas` — SDF rendering and its atlas (white distance
  fields, one per shape, tinted in the shader).
- `SdfVsRasterAt3x` — the VR scenario: the same base-size glyph source
  bitmap-upscaled (blurry) vs shader-rendered from an SDF atlas (crisp).
- `UpstreamVsFork` — the regression harness: identical content through
  pristine upstream `@xterm/addon-webgl`, the fork with `sdf: false`, and the
  fork with `sdf: true`, stacked. The upstream pin must be built from the same
  commit as the fork base, and because the `@xterm/*` beta counters are
  independent the two version numbers never match — so the triple (addon
  version, core version, commit) has to be written down. It lives in two
  places, the `UpstreamWebglAddon` import in `canopy/src/GlTerminal.stories.tsx`
  and `canopy/README.md`, and `--canopy` prints a reminder to update both while
  picking the matching addon itself (`npm view @xterm/addon-webgl@<ver>
  gitHead` re-derives it by hand). The harness owns its discriminating rows
  (`chevronGauntlet`) so demo-content edits cannot silently weaken it.

Story content writes PUA glyphs (powerline chevrons etc.) as `\uE0BX` escapes,
never literal characters: the literals are invisible in editors and were once
silently dropped in a file rewrite, which presented as a rendering regression.

Source of truth: `canopy/src/GlTerminal.stories.tsx`, `canopy/README.md`.

## Future

- **MSDF (multi-channel signed distance fields)** — sharper corners at extreme
  magnification than single-channel SDF, which rounds them. Generation
  requires glyph outlines rather than canvas rasterization, which means font
  file access: either a bundled default font processed at build time (e.g.
  msdf-atlas-gen) with the runtime SDF path as fallback for uncovered glyphs,
  or runtime font-byte discovery per host (Tauri/sidecar can read font files;
  browsers mostly cannot). The atlas texel layout is already reserved for this
  (one glyph per texel, RGB free — see the Reserved note above); the shader
  gains a `median(r,g,b)` branch.
- **SDF decorated cells** — underline/strikethrough/overline currently fall
  back to raster, so decorated text blurs under magnification. Composing
  decoration distance fields with the glyph field (or rendering decorations as
  analytic shapes in the shader) would close the gap.
- **Fork release automation** — a GitHub Action on the fork that builds and
  attaches the addon tarball on tag, plus a scheduled upstream-master merge PR
  into `sdf`. Releases and merges are manual today.
- **WebXR terminal-as-texture** — render the terminal into a texture
  composited in a three.js/WebXR scene, moving the SDF smoothstep into the
  scene shader so crispness holds at any distance/orientation. This is the
  canopy roadmap's next step and the reason the SDF work exists.
- **Production adoption** — only canopy consumes the fork today; adopting it
  in `lib/` / `standalone/` (behind an option) would bring SDF rendering to
  real Dormouse terminals.
- **Emoji heuristic refinement** — `isProbablyEmoji` errs toward raster by
  design; revisit its ranges if real content surfaces text-presentation
  symbols that deserve SDF crispness or colored glyphs that slip through.
