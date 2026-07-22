# canopy

Experimental lab for 3D/WebXR terminal rendering. Not part of the production
build — just Storybook stories exercising `@diffplug/xterm-addon-webgl-sdf`,
the webgl addon from our [xterm.js fork](https://github.com/diffplug/xterm.js)
(`sdf` branch — read its `FORK.md` for branch strategy and release process).

```sh
pnpm dev:canopy   # storybook on http://localhost:6007
```

## Dependency rules

- The addon is consumed as a **GitHub-release tarball URL** (no npm registry,
  no auth). pnpm records an integrity hash in the lockfile.
- The addon bundles xterm core internals, so `@xterm/xterm` here must be the
  exact beta the fork release was built from — the release version encodes it:
  `0.20.0-sdf291.0` ⇒ built from `@xterm/xterm@6.1.0-beta.291`.
- Renovate cannot see tarball URLs, and `.github/renovate.json` disables
  `@xterm/**` for this file so it cannot drift the two pins off the fork base
  either. Bumps are manual: cut a fork release, then update the URL and both
  pins here. The trigger and the review process are in
  `docs/specs/webgl-text.md`; the fork-side recipe is in FORK.md on the `sdf`
  branch.

## Regression harness

The `UpstreamVsFork` story renders identical content through three renderers
stacked: pristine upstream `@xterm/addon-webgl`, the fork with `sdf: false`
(isolates the instance-layout/shader changes), and the fork with `sdf: true`
(isolates the SDF glyph path). The upstream pin must be the same commit as the
fork base — the addon's beta counter is offset from core's (addon
`0.20.0-beta.290` == core `6.1.0-beta.291` == commit `699f5537`); re-derive it
with `npm view @xterm/addon-webgl@<ver> gitHead` when the fork rebases.

Story content writes PUA glyphs (powerline chevrons etc.) as `\uE0BX` escapes,
never literal characters — the literals are invisible in editors and were once
silently dropped in a file rewrite, which presented as a rendering regression.

## Local dev loop against the fork

```sh
# in ~/projects/xterm.js:  npm run dev  (or build+package for a one-shot)
cd canopy && pnpm link ~/projects/xterm.js/addons/addon-webgl
```

`pnpm link` writes only into `node_modules`, so nothing accidental gets
committed; a later `pnpm install` restores the release tarball.

## Roadmap

1. ~~Consume the stock webgl addon through the fork pipeline~~ (done — the
   stories render via WebGL2 with the pixel-accurate texture atlas)
2. ~~Swap the glyph atlas to signed distance fields~~ (done — vendored
   mapbox/tiny-sdf behind the addon's `sdf` / `sdfGlyphSize` options; hybrid
   atlas keeps emoji, box/powerline custom glyphs and decorated cells on the
   raster path. `SdfVsRasterAt3x` renders a low-res SDF atlas crisp at 3x;
   `SdfTextureAtlas` shows the live distance fields. Known v1 limits:
   decorated cells fall back to raster, and single-channel SDF rounds very
   sharp corners at extreme magnification — MSDF is the upgrade path.)
3. Render terminals as textures in a WebXR scene.
