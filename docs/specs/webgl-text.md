# WebGL Text Rendering (SDF fork + canopy)

> Text in a 3D scene is a texture at arbitrary scale, not a 1:1 pixel grid —
> hence signed distance fields (SDF).
>
> **Two webgl addons, one repo.** Production terminals render *stock*
> `@xterm/addon-webgl` (`docs/specs/layout.md` → "Renderer"); only `canopy/`
> consumes the SDF fork, which is what everything below describes.
>
> Release recipe:
> [FORK.md on the `sdf` branch](https://github.com/diffplug/xterm.js/blob/sdf/FORK.md),
> not restated here. `addons/addon-webgl/` paths are fork-repo paths — clone at
> `~/projects/xterm.js`, or read them from the release tarball's `src/` under
> `canopy/node_modules`.

## Fork pipeline

- **Repo/branches**: `master` is a pristine fast-forward mirror of upstream,
  `sdf` (the default) carries our changes; upstreamable fixes branch off
  `master` and cherry-pick into `sdf`.
- **Versioning**: `@diffplug/xterm-addon-webgl-sdf`, versions shaped
  `<addon-version>-sdf<coreBeta>.<iteration>` (`0.20.0-sdf301.1` ⇒
  `@xterm/xterm@6.1.0-beta.301`, iteration 1). **Consumers must pin the exact
  core beta named by the tarball's peer dependency**, not the `-sdfNNN`
  counter — the addon bundles core internals (rationale).
- **Distribution**: a pnpm tarball-URL dependency on GitHub Release assets,
  never an npm registry (rationale). **Never replace a published asset**; the
  lockfile records a sha512 integrity hash, so cut a new iteration.
- **Canopy's three pins move together.** Renovate ignores canopy's `@xterm/**`
  (it cannot follow the tarball URL); bump them with
  `node scripts/xterm-bump.mjs --canopy <forkVersion>`. `lib/` and `standalone/`
  may track a newer upstream beta between fork rebases.
- **Every pin must be exact, and every addon's core peer must equal its
  workspace's core pin** — the four `@xterm/*` packages share a repo but carry
  independent beta counters (rationale). `scripts/xterm-lint.mjs` also requires
  `lib` ≡ `standalone` and checks the canopy tarball's tag, filename, counter
  and peer as one set; `scripts/xterm-bump.mjs` (`pnpm bump:xterm`) writes the
  newest coherent per-commit set for `lib` and `standalone`.
- **Releases are hand-cut today** per FORK.md; automating this is staged in
  `## Future`.
- **Dev loop**: `pnpm link ~/projects/xterm.js/addons/addon-webgl` from
  `canopy/`. **Revert its root `package.json` / `pnpm-workspace.yaml` residue
  and reinstall before verifying a tarball** (rationale).

Source of truth: `canopy/package.json`, `canopy/README.md` (bump flow),
`scripts/xterm-lint.mjs`, `scripts/xterm-bump.mjs`, FORK.md in the fork.

## Following upstream

**Every `@xterm/*` bump is a trigger to re-evaluate the fork**, not one that
stops at `lib/` and `standalone/`: an older fork base makes `UpstreamVsFork`
compare against an upstream we no longer ship. On each grouped `xterm` Renovate
PR:

1. **Read the upstream diff first.** `node scripts/xterm-bump.mjs --dry-run`
   names the newest coherent set (rationale) and lists the
   `addons/addon-webgl/` files touched since canopy's fork base. Most betas
   touch none and the fork does not move; when they do, that diff is the risk
   assessment.
2. **Rebase and release the fork** per FORK.md's `Merging upstream` —
   **a conflict-free merge is not a correct one** (rationale).
3. **Bump `canopy/package.json`** with `--canopy <forkVersion>` and update the
   recorded triple (see "Canopy lab").

**Land all of it in one PR** with the `@xterm/*` bump, so the tree never
records lib and the fork on different upstreams.

## SDF glyph architecture

Fork-internal, behind the fork-added options `sdf: boolean` (default false;
upstream behavior untouched when off) and `sdfGlyphSize: number`.

- **Eligibility**: plain text renders as SDFs; the pixel-accurate raster path
  is kept for custom glyphs (box drawing/block/powerline), powerline-range
  glyphs, decorated cells (underline/strikethrough/overline), glyphs treated as
  background colors, and probable color emoji. **`isProbablyEmoji` widens the
  shared `isEmoji` range table and must err toward raster** (rationale).
- **Rasterization**: `SdfGlyphRasterizer` vendors mapbox/tiny-sdf
  (BSD-2-Clause, attribution in its header), adapted to xterm's `TEXT_BASELINE`
  metrics, to wide/CJK and combined-character strings, and to per-draw font
  weight/style. **Its padding buffer must let the distance field
  decay to zero inside the bitmap**, so LINEAR atlas sampling never bleeds
  between packed glyphs.
- **`sdfGlyphSize`**: the fixed base font size (px) glyphs are rasterized at —
  explicit, default 32, **never derived from the terminal font size or
  devicePixelRatio** (rationale).
- **Color-free atlas**: exactly one texture entry per shape (chars + weight +
  style); each additional color is a lightweight record sharing that entry with
  its own tint, via `AtlasPage.addGlyphAlias`. **A color variant must carry its
  own coordinate vectors and be registered on the page** — page merge/delete
  bookkeeping mutates every registered record in place exactly once (rationale).
  **Aliases do not count toward used-pixels**; the canonical record owns the
  texels.
- **Texel format**: distance in the atlas alpha channel with white RGB
  (rationale); the SDF shader path reads only alpha. Reserved: one plain
  distance field per texel, never multiple glyphs packed into color channels,
  keeping the layout compatible with the MSDF item in `## Future`.
- **Shader/renderer**: 16 floats per cell (upstream: 11), adding a
  straight-alpha tint vec4 and an SDF flag. Quads scale by the glyph's
  `renderScale` (device font px ÷ `sdfGlyphSize`) (rationale). The fragment
  shader reconstructs coverage with an `fwidth`-based smoothstep at the edge
  threshold `1 - SDF_CUTOFF`, **imported from the rasterizer** so encode and
  decode cannot drift. **Upstream merges that touch GlyphRenderer vertex code
  need care** (FORK.md).

Source of truth (fork repo): `SdfGlyphRasterizer` in
`addons/addon-webgl/src/SdfGlyphRasterizer.ts`; `_drawToCacheSdf`,
`_rasterizeSdfShape`, `_allocateGlyphSpace`, `addGlyphAlias` in
`addons/addon-webgl/src/TextureAtlas.ts`; `GlyphRenderer` in
`addons/addon-webgl/src/GlyphRenderer.ts`;
`addons/addon-webgl/typings/addon-webgl.d.ts`.

## Canopy lab

`canopy/` is a Storybook-only workspace package (port 6007, `pnpm dev:canopy`),
**kept independent of `dormouse-lib`** and outside the production build, though
its `test` (a `tsc` typecheck) runs under `pnpm test`. Stories:

| Story | Renders |
| --- | --- |
| `ColorsAndGlyphs` / `TextureAtlas` | stock fork (`sdf: false`), and its glyph atlas |
| `Sdf` / `SdfTextureAtlas` | SDF rendering, and its atlas |
| `SdfVsRasterAt3x` | the VR scenario: one base-size glyph bitmap-upscaled (blurry) vs SDF-rendered (crisp) |
| `UpstreamVsFork` | regression harness: identical content through pristine upstream `@xterm/addon-webgl`, fork `sdf: false`, fork `sdf: true`, stacked |

**`UpstreamVsFork`'s upstream addon must come from the fork base commit**, its
addon/core/commit triple recorded in both `canopy/src/GlTerminal.stories.tsx`
and `canopy/README.md`. The harness owns its discriminating `chevronGauntlet`
rows.

**Never write PUA glyphs as literals; use `\uE0BX` escapes** — the literals
vanish silently in a rewrite (rationale).

Source of truth: `canopy/src/GlTerminal.stories.tsx`, `canopy/README.md`.

## Future

- **MSDF (multi-channel signed distance fields)** — sharper corners than
  single-channel SDF, which rounds them at extreme magnification. Needs outlines
  rather than canvas rasterization, so font-file access: a build-time bundled
  default font (e.g. msdf-atlas-gen) with the runtime SDF path as fallback for
  uncovered glyphs, or per-host runtime font-byte discovery (Tauri/sidecar can
  read font files; browsers mostly cannot). The texel layout is already
  reserved for it; the shader gains a `median(r,g,b)` branch.
- **SDF decorated cells** — decorated text blurs under magnification while
  underline/strikethrough/overline stay on the raster path. Fix by composing
  decoration distance fields with the glyph field, or by drawing decorations
  analytically in the shader.
- **Fork release automation** — a GitHub Action on the fork that attaches the
  addon tarball on tag, plus a scheduled upstream-master merge PR into `sdf`.
- **WebXR terminal-as-texture** — the terminal rendered into a texture in a
  three.js/WebXR scene, with the SDF smoothstep moved into the scene shader so
  crispness holds at any distance. The canopy roadmap's next step, and why the
  SDF work exists.
- **Production adoption** — adopting the fork in `lib/` / `standalone/` (behind
  an option) would bring SDF rendering to real Dormouse terminals.
- **Emoji heuristic refinement** — revisit `isProbablyEmoji`'s ranges if real
  content surfaces text-presentation symbols that deserve SDF crispness, or
  colored glyphs that slip through.
