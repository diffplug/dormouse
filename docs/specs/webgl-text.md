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

## Fork pipeline

- **Repo/branches**: `master` on diffplug/xterm.js is a pristine fast-forward
  mirror of upstream; `sdf` (the default branch) carries our changes.
  Upstreamable fixes branch off `master` and are cherry-picked into `sdf`.
- **Versioning**: the addon is published as `@diffplug/xterm-addon-webgl-sdf`
  with versions shaped `<addon-version>-sdf<coreBeta>.<iteration>` (e.g.
  `0.20.0-sdf288.5` = built from the commit of `@xterm/xterm@6.1.0-beta.288`,
  iteration 5). The addon bundles xterm core internals, so consumers must pin
  the exact `@xterm/xterm` beta encoded in the version — the pins in
  `canopy/package.json` move in lockstep.
- **Distribution**: GitHub Release assets consumed as a pnpm tarball-URL
  dependency. Deliberately not an npm registry: GitHub Packages requires auth
  even for public reads, and release assets need none. The lockfile records a
  sha512 integrity hash; treat published assets as immutable and cut a new
  iteration instead of replacing one. Renovate cannot see tarball URLs, so
  version bumps are manual edits of `canopy/package.json`. Because the tarball
  is invisible to it, Renovate would otherwise drift canopy's two sibling pins
  off the fork base unnoticed, so `.github/renovate.json` disables `@xterm/**`
  scoped to `canopy/package.json` — both pins move only by hand. `lib/` and
  `standalone/` keep tracking upstream betas (as one grouped `xterm` PR, since
  core and its addons peer on the exact matching beta), so the two sit on
  different `@xterm/xterm` betas between fork rebases. That divergence is
  expected and confined to the Storybook-only lab.
- **Releases are hand-cut today** (build, `npm pack`, `gh release create` per
  FORK.md); automating this is staged in `## Future`.
- **Dev loop**: `pnpm link ~/projects/xterm.js/addons/addon-webgl` from
  `canopy/`. Caution: pnpm link writes persistent residue — a `link:`
  dependency in the root `package.json` and an override in
  `pnpm-workspace.yaml` — which silently keeps resolving the link. Revert both
  and reinstall before trusting a tarball verification.

Source of truth: `canopy/package.json` (pins), `canopy/README.md` (bump flow),
FORK.md in the fork.

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
