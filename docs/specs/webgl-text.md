# WebGL Text Rendering (SDF fork + canopy)

> - Text in a 3D scene is a texture at arbitrary scale, not a 1:1 pixel grid — hence signed distance fields (SDF).
> - Production terminals render *stock* `@xterm/addon-webgl` (`docs/specs/layout.md` → "Renderer"); only `canopy/` consumes the SDF fork, `@diffplug/xterm-addon-webgl-sdf`.
> - The fork's branches, release recipe, and what diverges from upstream are [FORK.md on the `sdf` branch](https://github.com/diffplug/xterm.js/blob/sdf/FORK.md), not restated here.

## Fork pipeline

- **Versioning**: versions shaped `<addon-version>-sdf<coreBeta>.<iteration>` (`0.20.0-sdf304.0` ⇒ `@xterm/xterm@6.1.0-beta.304`, iteration 0). **Consumers must pin the exact core beta named by the tarball's peer dependency** — the addon bundles core internals (rationale); `scripts/xterm-lint.mjs` holds the `-sdfNNN` counter to it.
- **Distribution**: a pnpm tarball-URL dependency on GitHub Release assets, never an npm registry (rationale). **Never replace a published asset**; the lockfile records a sha512 integrity hash, so cut a new iteration.
- **Canopy's three pins move together** — the tarball URL, the pristine upstream addon, and core. Renovate ignores canopy's `@xterm/**` (it cannot follow the tarball URL); bump them with `node scripts/xterm-bump.mjs --canopy <forkVersion>`.
- **Every pin must be exact, every addon's core peer must be `^<workspace-core-pin>`, and `lib` and `standalone` must pin the same set** — the `@xterm/*` packages share a repo but carry independent beta counters (rationale). `scripts/xterm-lint.mjs` owns the full check list in its header comment; `scripts/xterm-bump.mjs` (`pnpm bump:xterm`) writes the newest coherent per-commit set for `lib` and `standalone`.

Source of truth: `canopy/package.json`, `canopy/README.md` (bump flow and dev loop), `scripts/xterm-lint.mjs`, `scripts/xterm-bump.mjs`.

## Following upstream

**Every `@xterm/*` bump is a trigger to re-evaluate the fork**, not one that stops at `lib/` and `standalone/`: an older fork base makes `UpstreamVsFork` compare against an upstream we no longer ship. On each grouped `xterm` Renovate PR:

1. **Read the upstream diff first.** `node scripts/xterm-bump.mjs --dry-run` names the newest coherent set (rationale) and lists the `addons/addon-webgl/` files touched since canopy's fork base.
2. **May retain canopy's older baseline after reviewing a bump that leaves the forked addon unchanged.** Otherwise, **must update the fork base and release it** per FORK.md's `Merging upstream` — **a conflict-free merge is not a correct one** (rationale).
3. **After updating the fork base, bump `canopy/package.json`** with `--canopy <forkVersion>` and update its recorded triple ("Canopy lab"), which the lint requires.

**Must land any required fork-base update with the `@xterm/*` bump in one PR.**

## SDF glyph architecture

Fork-internal, behind the fork-added options `sdf` and `sdfGlyphSize`; FORK.md and the fork's code own it.

Reserved: one plain distance field per atlas texel, in the alpha channel over white RGB (rationale), never multiple glyphs packed into color channels, keeping the layout compatible with the MSDF item in `## Future`.

## Canopy lab

`canopy/` is a Storybook-only workspace package (`pnpm dev:canopy`), **kept independent of `dormouse-lib`** and outside the production build, though its `test` (a `tsc` typecheck) runs under `pnpm test`.

**`UpstreamVsFork` renders identical content through pristine upstream `@xterm/addon-webgl`, the fork with `sdf: false`, and the fork with `sdf: true`; its upstream addon must come from the fork base commit**, its addon/core/commit triple recorded as `addon <v> == core <v> == commit <sha>` in both `canopy/src/GlTerminal.stories.tsx` and `canopy/README.md` — `scripts/xterm-lint.mjs` check 4 holds each against canopy's pins, and the two commits against each other.

Source of truth: `canopy/src/GlTerminal.stories.tsx`, `canopy/README.md`.

## Future

**Scope: sdf-next** — unordered:

- **MSDF (multi-channel signed distance fields)** — sharper corners than single-channel SDF, which rounds them at extreme magnification. Needs outlines rather than canvas rasterization, so font-file access: a build-time bundled default font (e.g. msdf-atlas-gen) with the runtime SDF path as fallback for uncovered glyphs, or per-host runtime font-byte discovery (Tauri/sidecar can read font files; browsers mostly cannot). The texel layout is already reserved for it; the shader gains a `median(r,g,b)` branch.
- **SDF decorated cells** — decorated text blurs under magnification while underline/strikethrough/overline stay on the raster path. Fix by composing decoration distance fields with the glyph field, or by drawing decorations analytically in the shader.
- **Fork release automation** — a GitHub Action on the fork that attaches the addon tarball on tag, plus a scheduled upstream-master merge PR into `sdf`.
- **WebXR terminal-as-texture** — the terminal rendered into a texture in a three.js/WebXR scene, with the SDF smoothstep moved into the scene shader so crispness holds at any distance. The canopy roadmap's next step, and why the SDF work exists.
- **Production adoption** — adopting the fork in `lib/` / `standalone/` (behind an option) would bring SDF rendering to real Dormouse terminals.
- **Emoji heuristic refinement** — revisit `isProbablyEmoji`'s ranges if real content surfaces text-presentation symbols that deserve SDF crispness, or colored glyphs that slip through.
