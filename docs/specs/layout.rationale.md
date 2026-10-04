# Layout — Rationale

> Informative companion to [layout.md](layout.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Pane header

Italics alone mark a VS Code preview tab, and a double-click on that tab keeps it; the slot mirrors both. A Preview pill beside the italic label repeated the mark and cost a pill's width in every header from compact width up, and header width is the scarcest space Dormouse has (product decision, 2026-09-28).

The keep is judged by the burst's first press, so a double-click inside a rename opened earlier still selects a word. A preview's label opens no rename because the double-click's first click would open the field under the second.

Tools carry no navigation, address, or dev-server chip (Ned, 2026-09-29): a Tool is named for what it is, and a page it serves is not somewhere to navigate from, so that chrome stays with plain browser Surfaces. Its Terminal Context button had sat beside the header, outside its palette, and showed a different background.

A serving preview's header changed size on every switch while its name was the dev-server chip (standalone, 2026-09-29): the chip names a pane only once the Window's port scan resolves the page's loopback port (600 ms of debounce, then a scan at idle), which landed after the switch's hold had ended, so the address widened to the whole `localhost:<port>/<path>` and shrank back. A name from params changes once, with the retarget, so nothing needs holding.

## Pane header responsive sizing

A viewport breakpoint says nothing about a narrow split inside a wide window: at a 1200px viewport every control stayed rendered in a 103px pane and overflowed into its neighbor (innerdogfood QC, 2026-09). Measuring the header and moving fixed controls together keeps long keys and renderer chips from pushing minimize/kill into a neighboring pane; quantizing the measurement to a tier keeps the header from re-rendering on every frame of a sash drag or tween.

Terminal border-box thresholds of 293/173 pixels preserve the former 280/160 content-box thresholds plus 13 pixels of horizontal padding. A content box can clamp to zero in a visible tiny leaf; treating that as hidden retained the full tier. Positive border-box width distinguishes that case from a hidden leaf.

The minimal boundary keeps the pane-action group and its 5-pixel right padding intact. The group is 68 pixels (a 4-pixel `ml-1`, three 20-pixel buttons, two 2-pixel gaps); the header root adds a 6-pixel gap, and an unsaved-change dot adds 12 pixels. The 98-pixel threshold originally reserved that dot even when absent. Since the dot moved into Kill (2026-09-29), those 12 pixels leave more room for the name; the boundaries stay stable across unsaved-state changes. The group sits flush below this threshold, leaving no margin against font or icon changes (measured in Storybook, 2026-09).

The browser's 94-pixel boundary is the former 72 plus the zoom button and its gap, zoom having moved into the group. Its collapsed root is `gap-0.5 px-1`, already counted, so it needs no equivalent correction. A 102-pixel variant reserved an unsaved-change dot, which only a Tool reports; it went with the Tool's own header (2026-09-29).

A serving Tool's boundaries follow the same rule over its elements (derived 2026-09-29): 13 pixels of padding, 12 for the dot where the tiny tier hides Kill (elsewhere the dot rides in Kill and the 12 go to the name), Display up to 36 (robot, 2-pixel gap, presentation glyph, then its gap), Terminal Context 26, and the group's 74 with its gap. Display yields at 161, where those leave the name no width; minimize and kill at 125, 36 narrower. Full is the terminal's 293 plus both leading controls, 355. The tiny header needs 81 pixels, inside Lath's 100-pixel minimum leaf. Without a popover the Tool reaches everything it drops through zoom, as a terminal does.

## Pane body

xterm.js paints only its own rendered surface, and integer row fitting leaves a sub-row remainder at the bottom of the pane: a host background differing from the terminal screen shows as a stripe under the last row, and an unclipped host squares off the rounded bottom corners.

## Alarm overlay

**Why a perimeter ring rather than an inset border.** An inset border at the leaf's edge covers nothing, and a ring below the header would break the one-rounded-rectangle read that is the point of the treatment.

**Why header popovers are not a factor.** Every one — pane context menu, title candidates, notification preview, rename warning — portals to `document.body` with `position: fixed`, so it renders in the root stacking context above the whole wall regardless of leaf z-indices.

## Workspaces

**Why `visibility: hidden` in one grid cell rather than `display: none`.** Every Wall retains a full layout box while hidden. Reattachment avoids a grid change when dimensions remain unchanged; a resize while hidden is fitted on activation (`lib/src/components/TerminalPane.test.tsx`).

**Why a hidden Workspace's terminals are detached rather than merely hidden.** A `visibility: hidden` screen still intersects xterm's rendering observer, retaining rendering work and a GL context. Detachment pauses rendering and releases the context; it preserves the Session and grid (2026-09).

**Why a move confirms for iframes but not for agent-browser Surfaces.** An agent-browser Surface's session lives in the host process; the target window reconnects its viewer and the page is as it was. A plain iframe is a document inside the source webview, and no API carries a document between webviews — the alternative, keeping every Workspace in its own native child webview and reparenting it, was prototyped on a vendored Tauri fork and rejected for the fork (2026-09). The confirmation is the kill's typed letter rather than a button because what is lost is as gone as a killed process, and the same gesture already means that.

**Why an inactive Wall is inert before it is hidden.** During the outgoing fade the Wall remains visible beneath its successor. `inert` removes its focusability immediately, before `visibility: hidden` takes effect.

**Why the modal hosts are gated rather than hoisted.** Each calls `useDialogKeyboardOwner`, which reads the *active* Wall's `DialogKeyboardContext`; hoisting them above `WorkspaceWindow` would leave them with no coordinator to suppress command-mode dispatch through. The cost is that a modal's React-local state resets on a switch — accepted, since every modal that matters keeps its state in a store.

## Workspace tabs

**Why the tab's TODO pill enters passthrough and the tab does not.** Clicking the pill is a focused task, going to deal with one TODO, so it lands where a click on that Surface would, with the keys there. A tab click is an arrival in a Workspace: it stays in command mode, where the user looks around and confirms with `Enter` (product decision, 2026-09). The pill first shipped as selection only, in command mode, which left an `Enter` between the click and the TODO (2026-09).

## Workspace names

**Why the name holds while git is unanswered.** Naming by directory first would flash the folder name for one round trip, then flip to `repo @ branch`, on every new directory. The hold is bounded because a mount that stays hung is durable, not slow: its `realpath` never returns, so an unbounded hold froze the name for the life of the Window and drowned out the Workspace's healthy members (found in review, 2026-09).

**Why a command finish re-asks git.** `git switch` changes the branch without moving the cwd, and there is no filesystem watcher; the prompt after it is the first boundary that can notice. An agent switching branches inside a long-running command is not seen until that command exits — accepted over watching every repository's `HEAD` (2026-09).

## Mode switching

**Why both gesture tracks stay live everywhere.** Keyboards with no right Meta key are common on Windows and Linux laptops, so the Shift track is the only available gesture there. Keeping both live on every platform avoids a platform switch inside the detector and leaves macOS users a fallback when a hand is already on Shift.

## Split cwd inheritance

**What the shared focus tail costs.** Building a layout by repeated splits means re-entering command mode between each one. Control-plane creation is exempt so a script does not fight the user's focus.

## Selection overlay

**The inflate arithmetic.** With `SELECTION_RING_INFLATE_PX` at 4, the 1px passthrough border spans [3px, 4px] from the pane edge — dead centre of the 7px gutter, on whole pixels because the gutter is odd. That is the whole reason `PANE_GUTTER_PX` is odd.

**What endless marching costs, and why it is accepted.** An infinite SVG stroke animation keeps Chrome's renderer at 60 style recalculations per second. Measured in Chrome for Testing 150 (2026-09): five focused minutes added 3.77 MB of reclaimable embedder heap and used 24.33 seconds of renderer CPU; pausing only that animation held embedder heap flat (-29 KB) and used 0.017 seconds across a three-minute control. A four-cycle burst (PR #542) avoided that, but the ring then went still about 1.6s after a click activated a Workspace, and a still ring reads as the command-mode cue having gone. Command mode is transient, and a blurred window or reduced motion pauses the ants, so the cost falls only on a focused window left sitting in command mode (2026-09).

## Ring travel

**Why the JS tween is not what DESIGN.md bans.** That rule bans CSS *transitions* on layout properties, which the compositor cannot run off the main thread; the overlay writes true interpolated values each rAF frame, inside the same pointer-events-none carve-out the Lath animator holds.

**Why the per-frame writes are imperative.** It is the React-owns-structure / frame-owns-mutations split LathHost already uses for the animator, and the ring is the thing whose smoothness the user is watching.

## Directional motion smear

**Analytic velocity.** An edge at `from + (to - from) * E(t)` moves at `|to - from| * E'(t) / durationMs`, with `E'` from `LATH_EASING.slope`; the house ease-out peaks at `E'(0) = 4.545×` its average speed, which is why the blur belongs on the opening frame, and the closed form is jitter-free by construction. Finite-differencing rendered positions was tried and failed three ways: there is no previous sample on frame one, so the smear was hidden outright for the frame covering ~31% of a 220ms travel; an EMA over it lagged ~1.7 frames; and a backward difference under-reports any decelerating curve, landing the rendered peak mid-travel at ~46% of the true value.

**Extent and intensity.** Ink conservation — dividing alpha by the widening factor — would tie peak alpha to extent, making the effect impossible to strengthen by widening. `smearFullSpeed` stays the single shape knob over a travel: low values pin nearly every move at full smear, high values make the blur track speed.

**Per-edge speeds.** The counterexample: moving between panes flush at the top but differing in height, the top edge translates purely sideways and must stay crisp while the bottom edge moves diagonally and smears hard. A centre velocity averages those into the same wrong answer for both.

**Why two layers, and why corners are separate pieces.** The ring is one closed path so the dash phase runs unbroken around the perimeter, and SVG `stroke-width` is a single scalar — so that one path cannot carry four different widths. A corner has to reach two at once, and opacity cannot vary along a stroke, so a corner can only take the mean of its two edges' (mechanism at `cornerPath`).

**Closed-form dash length.** `1.6232252401402307 × r` is the arc length of the quadratic quarter-turn the path actually draws; the quarter-*circle* value `π/2` is 3% short. `SVGGeometryElement.getTotalLength()` costs a synchronous style+layout flush per frame at a cost scaling with the whole document, and is itself only an approximation (browsers flatten curves to measure) — verified in Safari to agree with the closed form to 6e-4px on a 3253px ring. Dropping it also retired the jsdom `getTotalLength` stubs, so tests assert real dash geometry.

**The `feGaussianBlur` measurements.** WebKit CPU-rasterizes SVG filters every frame: measured in Safari 26.5 (2026-08) at 25.6ms/frame with 31 of 98 frames over 25ms during ring travel, versus a locked 16.7ms with zero dropped frames after the eight-piece smear replaced the filter.

## Inline rename

Pane headers re-render on every activity, terminal-state, and palette change. An editor that re-derived its value (or re-ran `select()`) on those renders would fight the user mid-word — one re-render between two keystrokes and the second keystroke replaces everything typed so far.

## Renderer

**Why the GL context follows the mount.** Creating a renderer for minimized terminals spends scarce context slots on content that never paints. The pinned addon deletes GPU objects and removes its canvas on disposal but does not call `WEBGL_lose_context`; explicit loss avoids waiting for garbage collection to reclaim a slot. Disposing before loss removes the old renderer’s loss listeners so they cannot affect a replacement.

**Why capture failure keeps WebGL.** Canvas capture depends on the pinned addon’s synchronous activation, and explicit loss depends on a browser extension. A missing canvas, failed probe, or unavailable extension is not a rendering failure. Keeping the addon avoids turning dependency drift into the sustained DOM-renderer cost below; disposal still frees GPU objects on unmount, with only context-slot reclamation reverting to GC. The scan continues past a canvas that refuses the probe, so the addon's 2D link canvas cannot hide its WebGL one. Containing exceptions from both release steps prevents a renderer failure from leaving a pane half-unmounted or a Session undisposed.

**DOM-renderer cost.** The DOM renderer emits one `<span>` per style run per row, so a TUI that paints every cell its own truecolor collapses to one span-with-inline-style *per cell*, rebuilt every frame. On a 99×25 pane that is ~1150 elements of style recalc plus layout per frame: measured in Safari 26.5 (2026-08), a single such pane held the whole page at ~110ms/frame (~9fps) while the rest of the app was idle. The same pane on the WebGL renderer holds a locked 60fps (16.6ms, zero frames over 25ms).

**Context budget.** The per-page live-context cap was measured at 16 in Safari 26.5, evicted oldest-first. The `onContextLoss` → dispose-the-addon → DOM-fallback path was verified live by exhausting the budget and watching the demoted panes keep painting.

**Atlas sharing.** Stock addon-webgl already caches rasterized atlas canvases by font metrics/options, DPR, texture limits, glyph mode, and foreground/background/ANSI colors; terminal columns and rows are absent from the key. Each renderer uploads its own texture copy into its own WebGL context. A reattached terminal reuses the atlas while another compatible renderer owns it; no extra Dormouse cache is needed. Sharing GPU textures would require a different rendering architecture using one context across terminals.

**Why image support loads before the renderer.** An ImageAddon registers protocol handlers and draws into canvas layers separate from the text renderer; its renderer hook removes those layers during a WebGL/DOM swap and the next image render recreates them. Loading it only at mount would lose graphics emitted while a Session was minimized — unlike the GL context, which no minimized pane needs. The limits themselves are under "Inline graphics" below.

**Verification status.** In the standalone browser-dev harness (Chromium 150, 2026-09), 24 unmount/remount cycles explicitly lost every old context, retained the same terminal buffer, selection, and grid, emitted zero terminal resize events, and reused a second mounted terminal’s atlas canvas. Inline-image storage survived the swap and its layer repainted. The lifecycle change has not been verified inside Tauri’s WKWebView; the performance measurements above are Safari 26.5.

## Inline graphics

**Why the memory ceilings are below the addon's defaults.** ImageAddon storage is per Terminal instance, while Dormouse keeps minimized Sessions and their xterm instances alive. The upstream 128 MB cache and 16,777,216-pixel ceiling can therefore multiply across every visible and minimized pane. The 8,388,608-pixel ceiling admits a 3840×2160 image while halving the addon's worst decode-buffer footprint.

**Why `storageLimit` is 34 and not 32.** The addon derives cache capacity as `storageLimit / 4 * 1e6` pixels, so the cache must be at least `pixelLimit` × 4 bytes (33.55 MB) or admitting one full-size image evicts every other image in that Session and still exceeds the budget. 34 MB is the smallest round value that clears it; the two constants move together.

**Why the per-sequence byte caps are stated rather than inherited.** 33,554,432 bytes (32 MiB) for SIXEL, IIP, and Kitty and a 4,096-colour `sixelPaletteLimit` are not raises: they are `@xterm/addon-image@0.10.0-beta.301`'s own defaults, as are `enableSizeReports`, `showPlaceholder`, and the three `*Support` flags (verified against the pinned package's `DEFAULT_OPTIONS`; only `pixelLimit` and `storageLimit` differ from it). Restating them pins one encoded-size bound to reason about, so an addon bump that lowers a default cannot silently start rejecting a 4K PNG at the sequence boundary before the pixel ceiling can judge it. Decoded memory is bounded by the pixel and storage ceilings above regardless of encoded size.

**Why the addon loads eagerly rather than on the first image.** `ImageAddon.activate` answers DA1 with `62;4;9;22` (the `4` advertising SIXEL), registers XTSMGRAPHICS, and turns on the `CSI 14/16/18 t` size reports. A program probes those, decides, and only then sends pixels, so a Session that waited for image bytes would already have told it there is no graphics support and the bytes would never arrive. Keying activation on the probes instead is correct but buys little: `CSI c` is the ordinary "is this a real terminal" query most TUIs send at startup. What a Session actually pays eagerly is the handler registrations plus one sixel WASM instance — the module is compiled once per page, the sixel canvas starts empty, and the base64/QOI decoder memory and image storage are allocated on first use — so `cfg.terminal.inlineImages` is an on/off lever rather than a deferral.

**Why there is no page-global image budget.** `storageLimit` is per Terminal and Sessions outlive unmount, so the configured ceiling multiplies by pane count on paper. Measured, it does not: ImageAddon retains an image only while its tiles are live in the buffer, and deletes it when they are overwritten or scroll out of scrollback. A 600x300 pane showing a 1-megapixel image held 0.7 MB — the rendered area, not the source — and a 200x50-cell pane packed with forty such images held 3.1 MB, because each one overwrote its predecessor's tiles. Scrolling the image past a 1,000-line scrollback dropped the pane to 0 MB. So retained image memory tracks what is on screen and in scrollback, at a few MB per pane, and a registry-level LRU would be re-solving what buffer liveness already does. The 34 MB ceiling is a backstop, not a working set. (Measured in Chrome 152, 2026-09; the addon's accounting counts source pixels, so `storageUsage` is an upper bound on the real cost.)

**Why the WebAssembly grant is every host's problem, not the VS Code webview's.** The decoder is instantiated from `ImageAddon.activate()`, so it compiles when a Session is created rather than when an image arrives: a host whose policy omits the grant fails at boot with SIXEL silently dead thereafter, while IIP and Kitty — which decode through the browser's own image pipeline — keep working, so the gap does not present as "images are broken". All three shipped hosts load the addon from the same `createXtermHost`, which is why one omission would be a per-host bug rather than a shared one.

## Animations

Terminal entrance motion starts at a collapsed edge. Throttling still exposes several intermediate sizes to xterm and the PTY, even when reattachment ends at the original grid. Waiting for painted settlement avoids unnecessary buffer reflows, selection loss, and TUI redraws. A timer alone cannot distinguish a paused sash preview or delayed animation frame from final geometry.

## Kill (two-phase fade + tween reclaim)

**Why the selected-pane check is re-read live.** Navigate away from a dying selected pane and the tail must not yank selection back onto a survivor; navigate onto a dying pane and the tail must adopt a survivor rather than leave selection dangling on a removed leaf. A flag captured when the kill started answers only the first case.

## Auto-spawn refill

**Why the refill may fire re-entrantly.** The killed pane's fade already sequenced the removal; a delay on top would show an empty Wall for a frame between the two commits.
