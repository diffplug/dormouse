# WebGL Text Rendering (SDF fork + canopy)

Dormouse's 3D/WebXR terminal effort needs text that stays crisp when a terminal
is rendered at arbitrary scale and orientation — a texture in a 3D scene, not a
1:1 pixel grid. This spec covers the three layers that deliver that: the
diffplug/xterm.js fork pipeline, the signed-distance-field (SDF) glyph
architecture inside the forked webgl addon, and the `canopy/` Storybook lab
that exercises and regression-tests it.

The fork's own process doc is
[FORK.md on the `sdf` branch](https://github.com/diffplug/xterm.js/blob/sdf/FORK.md);
this spec does not restate its release recipe. File pointers under
`addons/addon-webgl/` refer to the fork repo (cloned at `~/projects/xterm.js`),
not this repo.

**Two webgl addons, one repo.** Production terminals render through *stock*
`@xterm/addon-webgl` (`docs/specs/layout.md` → "Renderer"); only `canopy/`
consumes the SDF fork. Everything below is about the fork. "Does Dormouse use
WebGL?" is answered by layout.md, not here.

## Fork pipeline

- **Repo/branches**: `master` on diffplug/xterm.js is a pristine fast-forward
  mirror of upstream; `sdf` (the default branch) carries our changes.
  Upstreamable fixes branch off `master` and are cherry-picked into `sdf`.
- **Versioning**: the addon is published as `@diffplug/xterm-addon-webgl-sdf`
  with versions shaped `<addon-version>-sdf<coreBeta>.<iteration>` (e.g.
  `0.20.0-sdf301.1` = built from the commit of `@xterm/xterm@6.1.0-beta.301`,
  iteration 1). The addon bundles xterm core internals, so consumers must pin
  the exact `@xterm/xterm` beta it was built from — the pins in
  `canopy/package.json` move in lockstep. Since `0.20.0-sdf301.1` the tarball
  also declares `peerDependencies: { '@xterm/xterm': '^<that beta>' }`, which is
  what the lint checks: upstream's `bin/publish.js` injects that field at publish
  time and our hand-cut `npm pack` release does not run it, so earlier fork
  tarballs shipped without any peer range. It is also the only record of the
  base as a *full* version — the `-sdfNNN` counter repeats across upstream
  release lines (`5.6.0-beta.1..143`, then `6.1.0-beta.1..302`).
- **Distribution**: GitHub Release assets consumed as a pnpm tarball-URL
  dependency. Deliberately not an npm registry: GitHub Packages requires auth
  even for public reads, and release assets need none. The lockfile records a
  sha512 integrity hash; treat published assets as immutable and cut a new
  iteration instead of replacing one. Renovate cannot see tarball URLs, so
  version bumps are manual edits of `canopy/package.json`. Because the tarball
  is invisible to it, Renovate would otherwise drift canopy's two sibling pins
  off the fork base unnoticed, so `.github/renovate.json` disables `@xterm/**`
  scoped to `canopy/package.json` — both pins move only by hand (or via
  `node scripts/xterm-bump.mjs --canopy <forkVersion>`, which rewrites the URL
  and both pins from the commit the fork version encodes). `lib/` and
  `standalone/` keep tracking upstream betas as one grouped `xterm` PR, so
  between fork rebases the two can sit on different `@xterm/xterm` betas. That
  divergence is expected and confined to the Storybook-only lab.
- **Upstream pins are per-commit, not per-latest.** The four `@xterm/*`
  packages ship from one repo but carry independent beta counters — an addon is
  published only when its own content changes — and each addon's
  `peerDependencies['@xterm/xterm']` names the exact core version published
  from the same commit. So "the latest of each" is routinely a set spanning two
  commits, and because `^6.1.0-beta.N` admits every later beta, nothing in npm
  or pnpm complains while addons run against core internals they were not
  compiled against. `scripts/xterm-lint.mjs` (offline, in `pnpm test`) enforces
  three things this depends on: every addon pin's peer range equals `^` its
  workspace's core pin — the SDF fork tarball included, which is what makes the
  canopy lockstep exact rather than counter-deep — `lib` and `standalone` agree,
  and canopy's tarball URL is self-consistent (tag, filename and `-sdfNNN`
  counter agree with the core pin, which independently catches a release whose
  tag misstates the base its peer range declares). `scripts/xterm-bump.mjs`
  (`pnpm bump:xterm`) derives the newest set that all four packages published
  from one commit and writes it.
- **Releases are hand-cut today** (build, `npm pack`, `gh release create` per
  FORK.md); automating this is staged in `## Future`.
- **Dev loop**: `pnpm link ~/projects/xterm.js/addons/addon-webgl` from
  `canopy/`. Caution: pnpm link writes persistent residue — a `link:`
  dependency in the root `package.json` and an override in
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

1. **Read the upstream diff first** and decide what it is worth. Start with
   `node scripts/xterm-bump.mjs --dry-run`: it names the newest coherent set
   (which is often an older core than Renovate proposed), prints the commit
   range from canopy's fork base to it, and lists the files in that range under
   `addons/addon-webgl/`. Most betas touch none of them, in which case the bump
   is a no-op for us and the fork does not move; when they do, that diff is the
   improvements-and-risks assessment.
2. **Rebase and release the fork** per the `Merging upstream` section of
   FORK.md — including its warning that a conflict-free merge is not a correct
   one, because upstream regularly adds obligations to code we extended without
   anything conflicting.
3. **Bump `canopy/package.json`** — `node scripts/xterm-bump.mjs --canopy
   <forkVersion>` moves the tarball URL and both pins together — and update the
   version-correspondence comment at the `UpstreamWebglAddon` import in
   `canopy/src/GlTerminal.stories.tsx`.

Land all of it in the same PR as the `@xterm/*` bump, so the tree never records
a state where lib and the fork disagree about which upstream they track.

## SDF glyph architecture

All behavior below is gated behind the fork-added addon options
`sdf: boolean` (default false — upstream behavior is untouched when off) and
`sdfGlyphSize: number`, documented in the fork's
`addons/addon-webgl/typings/addon-webgl.d.ts`.

- **Eligibility**: plain text glyphs render as SDFs. The pixel-accurate raster
  path is retained for custom glyphs (box drawing/block/powerline drawn by the
  custom-glyph rasterizer), powerline-range glyphs, decorated cells
  (underline/strikethrough/overline), glyphs treated as background colors, and
  probable color emoji (`isProbablyEmoji`, which delegates to the shared
  `isEmoji` range table and errs toward raster — a text symbol going raster
  only costs crispness; an emoji going SDF would lose its colors).
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
not part of the production build, and deliberately independent of
`dormouse-lib`. Its stories are the visual harness for the fork:

- `ColorsAndGlyphs` / `TextureAtlas` — stock fork rendering (`sdf: false`) and
  its live glyph atlas.
- `Sdf` / `SdfTextureAtlas` — SDF rendering and its atlas (white distance
  fields, one per shape, tinted in the shader).
- `SdfVsRasterAt3x` — the VR scenario: the same base-size glyph source
  bitmap-upscaled (blurry) vs shader-rendered from an SDF atlas (crisp).
- `UpstreamVsFork` — the regression harness: identical content through
  pristine upstream `@xterm/addon-webgl`, the fork with `sdf: false`, and the
  fork with `sdf: true`, stacked. The upstream pin is built from the same
  commit as the fork base; the version/commit correspondence is documented
  once, at the `UpstreamWebglAddon` import in
  `canopy/src/GlTerminal.stories.tsx` (the addon's beta counter is offset from
  core's — re-derive with `npm view @xterm/addon-webgl@<ver> gitHead` when the
  fork rebases). The harness owns its discriminating rows (`chevronGauntlet`)
  so demo-content edits cannot silently weaken it.

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
