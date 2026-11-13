# WebGL Text Rendering (SDF fork + canopy)

> - Text in a 3D scene is a texture at arbitrary scale, not a 1:1 pixel grid — hence signed distance fields (SDF).
> - Production terminals render *stock* `@xterm/addon-webgl` (`docs/specs/layout.md` → "Renderer"); only `canopy/` consumes the SDF fork, `@diffplug/xterm-addon-webgl-sdf`.
> - The fork's branches, release recipe, and what diverges from upstream are [FORK.md on the `sdf` branch](https://github.com/diffplug/xterm.js/blob/sdf/FORK.md), not restated here.

## Fork pipeline

- **Versioning**: versions shaped `<addon-version>-sdf<coreBeta>.<iteration>` (`0.20.0-sdf336.0` ⇒ `@xterm/xterm@6.1.0-beta.336`, iteration 0). **Consumers must pin the exact core beta named by the tarball's peer dependency** — the addon bundles core internals (rationale); `scripts/xterm-lint.mjs` holds the `-sdfNNN` counter to it.
- **Distribution**: a pnpm tarball-URL dependency on GitHub Release assets, never an npm registry (rationale). **Never replace a published asset**; the lockfile records a sha512 integrity hash, so cut a new iteration.
- **Canopy's three pins move together** — the tarball URL, the pristine upstream addon, and core. Renovate ignores canopy's `@xterm/**` (it cannot follow the tarball URL); bump them with `node scripts/xterm-bump.mjs --canopy <forkVersion>`.
- **Every pin must be exact, every addon's core peer must be `^<workspace-core-pin>`, and each `standalone` pin must equal `lib`'s** — the `@xterm/*` packages share a repo but carry independent beta counters (rationale). `scripts/xterm-lint.mjs` owns the full check list in its header comment; `scripts/xterm-bump.mjs` (`pnpm bump:xterm`) writes the newest coherent per-commit set for `lib`, and for the subset `standalone` pins.

Source of truth: `canopy/package.json`, `canopy/README.md` (bump flow and dev loop), `scripts/xterm-lint.mjs`, `scripts/xterm-bump.mjs`.

## Following upstream

**Every `@xterm/*` bump is a trigger to re-evaluate the fork**, not one that stops at `lib/` and `standalone/`: an older fork base makes `UpstreamVsFork` compare against an upstream we no longer ship. On each grouped `xterm` Renovate PR:

1. **Read the upstream diff first.** `node scripts/xterm-bump.mjs --dry-run` names the newest coherent set (rationale) and lists the `addons/addon-webgl/` files touched since canopy's fork base.
2. **May retain canopy's older baseline after reviewing a bump that leaves the forked addon unchanged.** Otherwise, **must update the fork base and release it** per FORK.md's `Merging upstream` — **a conflict-free merge is not a correct one** (rationale).
3. **After updating the fork base, bump `canopy/package.json`** with `--canopy <forkVersion>` and update its recorded triple ("Canopy lab"), which the lint requires.

**Must land any required fork-base update with the `@xterm/*` bump in one PR.**

## SDF glyph architecture

Fork-internal, behind the fork-added options `sdf` and `sdfGlyphSize`; FORK.md and the fork's code own it.

The scene frame (`onSceneFrame` / `sceneFrame`, on the fork's `in-scene-sdf` branch) hands a caller each frame the renderer drew as plain data; **canopy's restated `SceneFrame` must match the fork's `IWebglSceneFrame`**, since canopy compiles against releases that predate it.

Reserved: one plain distance field per atlas texel, in the alpha channel over white RGB (rationale), never multiple glyphs packed into color channels, keeping the layout compatible with the MSDF item in `## Future`.

## Canopy lab

`canopy/` is a workspace package of Storybook stories and the WebXR demo, **kept independent of `dormouse-lib`** and outside the production build; it shares Lath through the `lath` package.

**`UpstreamVsFork`'s pristine upstream `@xterm/addon-webgl` must come from the fork base commit**, its addon/core/commit triple recorded as `addon <v> == core <v> == commit <sha>` in both `canopy/src/GlTerminal.stories.tsx` and `canopy/README.md`; `scripts/xterm-lint.mjs` holds each record to canopy's pins and the two to each other.

Source of truth: `canopy/src/GlTerminal.stories.tsx`, `canopy/README.md`.

## WebXR demo

A Vite app in `canopy/xr/` beside Storybook (`pnpm --filter canopy dev:xr`), on Meta's Immersive Web SDK (iWSDK), checked in its desktop emulator (IWER) as a Quest 3.

- **Must pin `@iwsdk/core` exactly and alias `three` to the `super-three` version that core release depends on**, in canopy alone; iWSDK needs one Three.js module instance, so `pnpm-workspace.yaml` also overrides IWER DevUI's stock `three`.
- **Never enable the iWSDK dev plugin's `ai` or `workspace` options**: its own Playwright browser and MCP server stay off, and the app is driven through `dor agent-browser`.
- Every terminal is the SDF addon (`sdf: true`) drawn as a mesh texture or into a WebXR composition layer. IWER implements no layers, so the emulator shows iWSDK's fallback mesh for each layer and proves only that both paths draw the same terminal.
- The default scene is the Lath wall: Lath's pure core (`docs/specs/tiling-engine.md`) lays terminals out in wall px, mapped onto a cylinder around the viewer, each pane an `XRCylinderLayer` or a curved mesh under a header. A sash drag streams `resize` against the drag-start tree and commits on release; a header drag hit-tests every move against the live tree, shows the drop's preview rect, and commits `move`. `?scene=compare` instead shows one terminal as a flat mesh beside an `XRQuadLayer`.
- **Must draw a mesh pane from the addon's scene frames when it has them**: background rects, glyph quads, and cursor go into the scene under its projection, with the fork's SDF smoothstep in the scene shader, so tilted and zoomed text stays crisp. Without them, or with `?inscene=0`, the pane shows the canvas texture; the compare scene's center pane is drawn this way too.
- **Never give more than 15 panes a composition layer**: Quest composites 16 layers, one of them the projection layer; the rest are curved meshes, and `?layers=N` lowers the budget.
- **Controller rays are the terminal's mouse**: a ray event on any pane is replayed as the DOM mouse event xterm.js listens for, at the hit point on its screen element, so xterm's own selection and mouse reporting apply and the demo holds no selection or protocol logic. After a press only the pressing pointer counts, since every ray hovers. A press focuses the terminal, so the desktop keyboard types into it; a local echo line editor stands in for a PTY.

Source of truth: `canopy/vite.xr.config.ts`, `canopy/xr/main.ts`, `wallScene` in `canopy/xr/wall-scene.ts`, `attachPaneInput` in `canopy/xr/input.ts`, `InSceneText` in `canopy/xr/in-scene-text.ts`.

## Future

**Scope: canopy-webxr** — the rest of the WebXR demo ("WebXR demo"), in order:

1. **Release the scene frame** — merge the fork's `in-scene-sdf` branch into `sdf`, cut a release, and bump canopy; mesh panes then draw in-scene with no canopy change.
2. **Live terminals** — a Client of a laptop Burrow: the one-time connection (`docs/specs/one-time.md`, no account or passkey) or Pocket-style pairing.

**Headset checks** for what IWER cannot show: whether a mesh pane or a layer is sharper, whether the layers' flipped draws (`canopy/xr/compare-scene.ts`, `canopy/xr/wall-scene.ts`) are upright and unmirrored on a real compositor, whether layers hide the headers and sashes drawn into the projection layer, and whether xterm still redraws during an immersive session, since it schedules frames on `window.requestAnimationFrame`, which a headset browser may pause while presenting.

**The full Quest version** is a native Meta Spatial SDK app, not WebXR, since WebXR cannot draw a cross-origin frame into the scene. Its panes are WebView panels in layer mode running `lib`; Lath runs in a controller WebView whose rects reach Kotlin through `addWebMessageListener`, which origin-allowlists the bridge where `addJavascriptInterface` reaches every frame. It needs a headset: Meta Spatial Simulator runs only 2D Android apps. First device checks: the WebView's feature flags, memory per WebView, rect-to-panel latency, and layer versus SDF sharpness. Its protocol is `docs/specs/remote-api.md` -> "7. The Window (VR)".

**Scope: sdf-next** — unordered:

- **MSDF (multi-channel signed distance fields)** — sharper corners than single-channel SDF, which rounds them at extreme magnification. Needs outlines rather than canvas rasterization, so font-file access: a build-time bundled default font (e.g. msdf-atlas-gen) with the runtime SDF path as fallback for uncovered glyphs, or per-host runtime font-byte discovery (Tauri/sidecar can read font files; browsers mostly cannot). The texel layout is already reserved for it; the shader gains a `median(r,g,b)` branch.
- **SDF decorated cells** — decorated text blurs under magnification while underline/strikethrough/overline stay on the raster path. Fix by composing decoration distance fields with the glyph field, or by drawing decorations analytically in the shader.
- **Fork release automation** — a GitHub Action on the fork that attaches the addon tarball on tag, plus a scheduled upstream-master merge PR into `sdf`.
- **Production adoption** — adopting the fork in `lib/` / `standalone/` (behind an option) would bring SDF rendering to real Dormouse terminals.
- **Emoji heuristic refinement** — revisit `isProbablyEmoji`'s ranges if real content surfaces text-presentation symbols that deserve SDF crispness, or colored glyphs that slip through.
