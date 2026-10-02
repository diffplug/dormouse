# Mobile Terminal UI

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary. This spec uses it throughout.

The mobile terminal composition: `MobileTerminalUi` (the wrapper owning touch
modes, input modes, and the keyboard reserve) around `MobileWall` (one visible
terminal Session at a time, with session switching). **Mobile exposes no
split-pane layout and no multiple Workspaces.**

Three consumers compose them: the website Pocket playground
(`website/src/components/PocketTerminalExperience.tsx` on `FakePtyAdapter`;
`docs/specs/tutorial.md`), the Pocket app
(`lib/src/remote/pocket-app/PocketWall.tsx` on `RemotePtyAdapter`;
`docs/specs/pocket-app.md`), and Storybook.

## Core layout

| Region, top to bottom | Owner / sizing |
| --- | --- |
| Session header | `MobileWall`, fixed height |
| Pane content | `MobileWall`, flexible |
| Touch selector | Always visible |
| Input selector | Always visible |
| Reserve | Fixed CSS height; app UI when the OS keyboard is hidden, occupied by the OS keyboard otherwise |

Chrome rules:

* One divider, between the Touch and Input rows — none above Touch, none below
  Input.
* The Touch row and its selector tray sit on `terminal-bg`; the Input row and
  the reserve area on `header-inactive-bg` / `header-inactive-fg` (rationale).
* The mobile session header is a flush bar — **never** the desktop title corner
  radius. Order: title, secondary detail, TODO pill, minimize, kill (suppressed
  by `showKillButton={false}`, as Pocket does). Both consumers wire minimize to
  the Sessions reserve, not a desktop Door. A ring shows as the alarm inset on
  the bar and on its session-list row. **A tap acknowledges the active
  Session; a drag never does.** `MobileTerminalUi` tracks each press in its
  capture phase, before any touch mode consumes it, and acknowledges a release
  that never strayed past `RADIUS_FADE_START`. **Select mode's router consumes
  a touch it owns**, so it announces one that never became a drag as
  `TERMINAL_TAP_EVENT`. Both consumers route the input bar and gesture keys
  through `writeUserInput` (`docs/specs/alert.md` -> Engagement).
* **Must install `useDynamicPalette` in `MobileTerminalUi`** for gesture tokens;
  it never mounts the desktop `Wall`. `docs/specs/theme.md` owns publication
  and the CSS baselines available before the effect runs.
* `MobileTerminalUi` provides `TouchUiContext` = true, so shared selection UI
  omits physical-keyboard shortcut hints (`docs/specs/mouse-and-clipboard.md`).

**Never recompute height from `window.visualViewport`**: the reserve is a fixed
CSS height and the root `h-screen` (when `fillViewport`) or `h-full`, so the
terminal region does not bounce as the OS keyboard animates (rationale).

Source of truth: `withinTapSlop` in `lib/src/components/MobileTerminalUi.tsx`;
`TERMINAL_TAP_EVENT` in `lib/src/lib/terminal-mouse-router.ts`. Pinned by
`lib/src/components/mobile-acknowledge.test.tsx`.

## Touch mode selector

The touch selector controls what a pane-content touch does. **Always visible**,
and **must be self-labeling** — segmented buttons carrying both an icon and a
short mode label (rationale).

| Mode (button label) | Availability | Behavior |
| --- | --- | --- |
| Gestures | Always | Either-edge drags scroll; other pane-content touches, pen presses, and primary clicks open the radial menu. |
| Text selection (`Select`) | Always | Touch, pen, and primary drags select terminal text as on desktop; a capturing pane gets mouse override. |
| Mouse | Active TUI capturing mouse events | Touches are passed through as terminal mouse input. |

Default **Gestures**. **Mouse mode falls back to Gestures when the active pane
stops capturing mouse events.**

**Must recompute `paneMouseOverride` for every mounted pane from the global
touch mode and that pane's own reporting state**; a switched-away pane must
not retain a stale override. The consumer owns the loop.

Select mode **must route touch and pen drags through the shared terminal
mouse-selection router**, never a mobile-only one, so every selection and copy
behavior matches desktop (`docs/specs/mouse-and-clipboard.md`). **Paste rides
the native browser/OS flow** — no mobile clipboard manager, no multi-line paste
review.

Event routing, by mode:

* **Gestures / Select** — `wheel` and `touchmove` in the pane content are
  consumed in the capture phase, except Gestures mode’s synthesized edge-scroll wheels ([Edge scrolling](#edge-scrolling); rationale).
* **Mouse** — `touchstart` / `touchmove` / `touchend` / `touchcancel` are
  consumed instead, and primary touch and pen pointers synthesize left-button
  mouse events on the element under the pointer (pointerdown / pointermove /
  pointerup-or-cancel → `mousedown` / `mousemove` / `mouseup`). `wheel` is left
  alone so it still reaches the terminal, and real mouse pointers fall through
  untouched. (rationale)

**Never treat a portaled descendant as pane content**: a press outside the
host's DOM starts no touch mode, tap, or keyboard dismissal.

**Must release a tracked Mouse-mode press on pointerup or cancel even after
leaving Mouse mode.** Cancellation releases on the last target.

Gesture mode also consumes primary mouse/trackpad clicks (rationale): the click
starts radial gesture handling, `preventDefault()`s, stops propagation, captures
the pointer, and **must never reach xterm or the pane** for focus, selection,
or pane interaction. **Non-primary mouse buttons
are ignored**, so their browser or host behavior continues.

Source of truth: `TOUCH_MODES`, `paneMouseOverride`, and `isPortaledTarget` in
`lib/src/components/MobileTerminalUi.tsx`; per-pane wiring in
`lib/src/remote/pocket-app/PocketWall.tsx` and
`website/src/components/PocketTerminalExperience.tsx`.

## Edge scrolling

**Must reserve the outermost 48 CSS pixels on both sides of the pane for scrolling in Gestures
mode**, locking the drag's owner and Session at pointerdown until release or
cancel. **Must accumulate vertical movement at 18 CSS pixels per line**; content
follows the finger, with no radial-menu input or native-keyboard focus.

**Must coast after a touch or pen flick**, retaining fractional-line travel;
a held or stationary press, mouse drag, or pointer cancellation launches no
momentum. The recent-direction velocity estimate, pause cutoff, launch cap,
and elapsed-time decay live at `EdgeScrollMotion` (rationale).

**Must send wheel events through xterm when the Session captures the mouse**,
clamping the reported coordinates inside its terminal screen. **Must otherwise
scroll the terminal buffer directly**, never synthesize alternate-screen arrow
keys. **Must stop momentum at a buffer boundary or missing terminal, on a new
pane press, when the document becomes hidden, or on unmount.** **Must stop
scrolling when interaction is disabled, the touch mode changes, or the active
Session changes.**

Source of truth: `EDGE_SCROLL_WIDTH_PX`, `EDGE_SCROLL_LINE_PX`, and
`EdgeScrollMotion` / `scrollMobileTerminal` in `lib/src/lib/mobile-terminal-scroll.ts`;
`MobileTerminalUi` in `lib/src/components/MobileTerminalUi.tsx`.
Tests: `lib/src/components/MobileTerminalUi.test.tsx`;
`lib/src/lib/mobile-terminal-scroll.test.ts`.

## Gesture mode

Touching the pane content away from either edge opens a radial menu offset from the touch origin, in
the opposite diagonal from the user's thumb (rationale). **The offset is clamped
inside the pane**; on an axis shorter than twice the clamp margin the rose
centers on that axis instead.

**Draw only the offset guide line inside the visible compass rose** — never one
under the user's thumb. It is solid and fully opaque; the offset rose center
renders a small fully opaque circle.

The radii order `RADIUS_FADE_START` < `RADIUS_HIGHLIGHT` < `RADIUS_SELECT` <
`RADIUS_LAYOUT`.

| Variable | Behavior |
| --- | --- |
| `RADIUS_LAYOUT` | Circular radius for exploded option anchors around the offset rose origin, using normalized compass vectors. Root labels use packed square-keypad geometry instead ([Root layout](#root-layout)); the quit submenu uses its own tighter `QUIT_RADIUS`. |
| `RADIUS_SELECT` | Visible circle around the offset rose origin; the mirrored drag reaching it selects the closest compass direction. |
| `RADIUS_FADE_START` | No directional root-group fading before this drag distance. |
| `RADIUS_HIGHLIGHT` | No circle drawn; the drag reaching it highlights the closest compass direction without selecting it. |

Gesture menu items reuse the pane-header palette: idle takes inactive header
bg/fg, highlighted or selected takes active header bg/fg plus an inset
`color-focus-ring` ring. **Never indicate gesture selection state with a
layout-affecting border.** Inactive chips get a quiet shadow only; heavier
elevation is reserved for active chips. The select circle and its eight compass
ticks render at full opacity, thickening the tick on the highlighted or selected
direction.

On touch-down, root labels fade in with a subtle scale-in and the select circle
grows from zero to `RADIUS_SELECT` — a state reveal, never a loop.
**Reduced-motion users get the final state immediately.**

**While a root group is still being chosen, all root groups stay fully opaque
until the drag exceeds `RADIUS_FADE_START`**; past it each fades by its
alignment with the drag vector, reaching full per-direction opacity at
`RADIUS_SELECT` — brightest toward the drag, zero opposite.

Source of truth: `displayOriginAwayFromThumb` and the `RADIUS_*` constants above
in `lib/src/lib/mobile-gesture-menu.ts`; `rootGroupOpacity()` and `QUIT_RADIUS`
in `lib/src/components/MobileGestureRadialMenu.tsx`.

### Root layout

**Must pack root labels as a square keypad** (rationale). Cardinal chips share
one gap from the select circle; **each diagonal group renders three separate
labels, never one combined pill**, with its primary nearest the circle and its
secondaries stacked outward. Corner anchors and spacing live at
`rootOptionLayout`; the key inventory lives at `MOBILE_GESTURE_GROUPS`.

**Must confirm `⌃C` and `Paste` in an in-pane modal before running them.**
**Must open a second exploded-option menu for `Quit`** instead of
sending input, under the same reset-center, highlight, select, and
expand-and-fade completion rules as normal option selection.

Root labels use compact key glyphs: `⌃` for Ctrl, `⬆︎` for Shift, and
`▲`/`▼`/`◀`/`▶` for arrow keys. Enter and Backspace stay spelled out.

Source of truth: `GAP_CARDINAL_RING`, `GAP_CLUSTER`, and `rootOptionLayout()` in
`lib/src/components/MobileGestureRadialMenu.tsx`;
`MOBILE_TERMINAL_KEY_SEQUENCES` in `lib/src/components/MobileTerminalUi.tsx`;
`MOBILE_GESTURE_GROUPS` and `MOBILE_GESTURE_QUIT_GROUP` in
`lib/src/lib/mobile-gesture-menu.ts`.

### Selection stages

Cardinal directions are a one-stage gesture:

1. Touch down to open the menu.
2. Drag to `RADIUS_HIGHLIGHT` to preview the closest compass point.
3. Drag to `RADIUS_SELECT` on N, S, E, or W to send the matching arrow key
   immediately — **never wait for touch release**.
4. The menu remains for a short completion animation: removed labels fade out;
   the selected label expands and fades out before the overlay clears.

Diagonal directions are a two-stage gesture: steps 1–2 as above, then

3. Drag to `RADIUS_SELECT` to choose that diagonal group.
4. The other seven groups fade out.
5. The compass center resets to the point where the drag intersected the
   `RADIUS_SELECT` circle.
6. The group's three labels **tween** from root to exploded positions around the
   reset center — the center option back along the exact opposite compass
   direction, the secondaries ±45° off it. **They must not fade out and be
   replaced by newly spawned labels.**
7. From the reset center, `RADIUS_HIGHLIGHT` previews an option and
   `RADIUS_SELECT` chooses and sends it — again without waiting for release,
   again followed by the completion animation.

**Releasing after the group selection but before choosing an exploded option
cancels the gesture.**

Overshoot handling: **the option origin ratchets *outward* along the opening
direction while the drag keeps pushing that way**, and **the compass stays
visually collapsed while that push is brisk, latching expanded once the drag
settles** (`OPTION_EXPAND_RELEASE`). (rationale)

Source of truth: `advanceOptionOrigin` / `MOBILE_GESTURE_OPTION_DIRECTIONS` in
`lib/src/lib/mobile-gesture-menu.ts` — the ratchet, and exploded-option
directions per group.

## Input mode selector

The input mode selector controls what appears in the reserve area. **Always
visible**, four items (`Sessions | Recent | Type | Draft`), self-labeling on the
same rule as the touch selector.

| Mode | Reserve area content |
| --- | --- |
| Sessions | Session rows with active, alert, and TODO state; selecting one makes it the single visible terminal. |
| Recent | Recent reserve copy, filling the reserve. |
| Type | Type reserve copy, as a button focusing the hidden terminal input — the way back from a dismissed keyboard. Typed keys echo into the terminal as they happen. |
| Draft | Draft reserve copy, filling the reserve. |

Default input mode is **Type**. Recent and Draft are placeholder-only today and
say so in the reserve ([Future](#future)).

**Must focus the hidden input synchronously inside the Type selector's tap/click
handler** (rationale). A follow-up effect retries via rAF and staggered timers
as best effort. **Switching away from Type blurs the
hidden input**, including consumer-controlled switches.

Source of truth: `KEYBOARD_MODES` and `RESERVE_COPY` in
`lib/src/components/MobileTerminalUi.tsx`.

## Type mode input

Typing goes through a visually hidden `<textarea>` configured for terminal-style
input: `autocapitalize`, `autocomplete`, and `autocorrect` off, `spellcheck`
false, `inputmode="text"`, `enterkeyhint="enter"`.

* Normal characters go to the active terminal immediately; Enter sends terminal
  Enter, Backspace works, and physical `Ctrl+C` sends `\x03`.
* **Must buffer composed text until `compositionend` and leave composing
  keydowns to the IME**, including its editing and confirmation keys.
* **Must handle software-keyboard Enter and Backspace through `beforeinput`
  when no `keydown` occurs**, including deletion from the empty hidden input.

Source of truth: `MobileTerminalUi` in `lib/src/components/MobileTerminalUi.tsx`;
`isComposingKey` in `lib/src/lib/dom.ts`.
Tests: `lib/src/components/MobileTerminalUi.test.tsx`.

## Keyboard focus invariant

**Pane-content touches must never open the native keyboard.** The pane content
area may focus the terminal internally for key routing or mouse handling, but
the wrapper marks every text input the terminal surface creates as a
non-keyboard target (`inputmode="none"`, readonly, not tab-reachable — kept true
for later-mounted inputs by a `MutationObserver`) and blurs it when the touch
starts there. **That blur repeats across a rAF and staggered timers, and the
pending retries are cancelled on unmount** (rationale). **The only mobile UI
surfaces that may open the native keyboard are the Type selector and the Type
reserve area.**

**Must cancel pending focus retries when pane interaction dismisses the keyboard,
and pending blur retries when Type explicitly focuses it.**

Source of truth: the non-keyboard-target and blur plumbing is in
`lib/src/components/MobileTerminalUi.tsx`, the session composition in
`lib/src/components/MobileWall.tsx`; pinned by
`lib/src/components/MobileTerminalUi.test.tsx`,
`lib/src/components/MobileWall.test.tsx`, and
`lib/src/lib/mobile-gesture-menu.test.ts`.

## Future

Potential later additions:

* Real recent commands and a Draft scratchpad (both reserves are placeholder
  copy today).
* Dual-pane copy/paste.
* Pinned snippets.
* Ctrl+D and Ctrl+Z app-key buttons.
* Alt and modifier behavior.
* Long-press key repeat.
* Multi-touch gestures.
* Trackpad mode.
* Multi-session support (more than one visible session).
