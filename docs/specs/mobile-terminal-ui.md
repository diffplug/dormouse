# Mobile Terminal UI

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary. This spec uses it throughout.

The mobile terminal composition: `MobileTerminalUi` (the wrapper owning touch modes, input modes, and the keyboard reserve) around `MobileWall` (one visible terminal Session at a time, with session switching). **Mobile exposes no split-pane layout and no multiple Workspaces.**

Three consumers compose them: the website Pocket playground (`website/src/components/PocketTerminalExperience.tsx` on `FakePtyAdapter`; `docs/specs/tutorial.md`), the Pocket app (`lib/src/remote/pocket-app/PocketWall.tsx` on `RemotePtyAdapter`; `docs/specs/pocket-app.md`), and Storybook.

## Core layout

Top to bottom: the `MobileWall` session header and pane content, the always-visible Touch and Input selectors, then the reserve — a fixed CSS height holding app UI while the OS keyboard is hidden and occupied by the OS keyboard otherwise.

**Never recompute height from `window.visualViewport`**: the reserve is a fixed CSS height and the root `h-screen` (when `fillViewport`) or `h-full`, so the terminal region does not bounce as the OS keyboard animates (rationale).

* Both consumers wire the session header's minimize to the Sessions reserve, not a desktop Door; Pocket suppresses kill (`showKillButton={false}`). A ring shows as the alarm inset on the header bar and on its session-list row.
* **A tap acknowledges the active Session; a drag never does.** The press is tracked before any touch mode consumes it, and **Select mode's router consumes a touch it owns**, so it announces one that never became a drag as `TERMINAL_TAP_EVENT`. Both consumers route the input bar and gesture keys through `writeUserInput` (`docs/specs/alert.md` -> Engagement).
* **Must install `useDynamicPalette` in `MobileTerminalUi`** for gesture tokens; it never mounts the desktop `Wall`.
* `MobileTerminalUi` provides `TouchUiContext` = true, so shared selection UI omits physical-keyboard shortcut hints (`docs/specs/mouse-and-clipboard.md`).

Source of truth: `withinTapSlop` in `lib/src/components/MobileTerminalUi.tsx`; `TERMINAL_TAP_EVENT` in `lib/src/lib/terminal-mouse-router.ts`. Pinned by `lib/src/components/mobile-acknowledge.test.tsx`.

## Touch mode selector

The touch selector controls what a pane-content touch does. **Always visible**, and **must be self-labeling** — each mode carries both an icon and a short label (rationale).

| Mode (button label) | Availability | Behavior |
| --- | --- | --- |
| Gestures | Always | Either-edge drags scroll; other pane-content touches, pen presses, and primary clicks open the radial menu. |
| Text selection (`Select`) | Always | Touch, pen, and primary drags select terminal text as on desktop; a capturing pane gets mouse override. |
| Mouse | Active TUI capturing mouse events | Touches are passed through as terminal mouse input. |

Default **Gestures**. **Mouse mode falls back to Gestures when the active pane stops capturing mouse events.**

**Must recompute `paneMouseOverride` for every mounted pane from the global touch mode and that pane's own reporting state**; a switched-away pane must not retain a stale override. The consumer owns the loop.

Select mode **must route touch and pen drags through the shared terminal mouse-selection router**, never a mobile-only one, so every selection and copy behavior matches desktop (`docs/specs/mouse-and-clipboard.md`). **Paste rides the native browser/OS flow** — no mobile clipboard manager, no multi-line paste review.

Event routing, by mode (rationale):

* **Gestures / Select** — pane-content `wheel` and `touchmove` are consumed, except Gestures mode's synthesized edge-scroll wheels ([Edge scrolling](#edge-scrolling)).
* **Mouse** — touch events are consumed instead, and primary touch and pen pointers synthesize left-button `mousedown` / `mousemove` / `mouseup` on the element under the pointer. `wheel` still reaches the terminal, and real mouse pointers fall through untouched.

**Never treat a portaled descendant as pane content**: a press outside the host's DOM starts no touch mode, tap, or keyboard dismissal.

**Must release a tracked Mouse-mode press on pointerup or cancel even after leaving Mouse mode.** Cancellation releases on the last target.

**Gesture mode also takes primary mouse/trackpad clicks**, which open the radial menu and **must never reach xterm or the pane** for focus, selection, or pane interaction (rationale). **Non-primary mouse buttons are ignored**, so their browser or host behavior continues.

Source of truth: `TOUCH_MODES`, `paneMouseOverride`, and `isPortaledTarget` in `lib/src/components/MobileTerminalUi.tsx`; per-pane wiring in `lib/src/remote/pocket-app/PocketWall.tsx` and `website/src/components/PocketTerminalExperience.tsx`.

## Edge scrolling

**Must reserve a strip at both edges of the pane for scrolling in Gestures mode**, locking the drag's owner and Session at pointerdown until release or cancel. Vertical movement accumulates into whole lines; content follows the finger, with no radial-menu input or native-keyboard focus.

**Must coast after a touch or pen flick**, retaining fractional-line travel; a held or stationary press, mouse drag, or pointer cancellation launches no momentum (rationale).

**Must send wheel events through xterm when the Session captures the mouse**, clamping the reported coordinates inside its terminal screen. **Must otherwise scroll the terminal buffer directly**, never synthesize alternate-screen arrow keys. **Must stop momentum at a buffer boundary or missing terminal, on a new pane press, when the document becomes hidden, or on unmount.** **Must stop scrolling when interaction is disabled, the touch mode changes, or the active Session changes.**

Source of truth: `EDGE_SCROLL_WIDTH_PX`, `EDGE_SCROLL_LINE_PX`, and `EdgeScrollMotion` / `scrollMobileTerminal` in `lib/src/lib/mobile-terminal-scroll.ts`.

## Gesture mode

Touching the pane content away from either edge opens a radial menu offset from the touch origin, in the opposite diagonal from the user's thumb (rationale). **The offset is clamped inside the pane**; on an axis shorter than twice the clamp margin the rose centers on that axis instead. **Never draw the guide line under the user's thumb** — only inside the visible, offset rose.

Drag distance from the rose center decides everything, in the order `RADIUS_FADE_START` < `RADIUS_HIGHLIGHT` < `RADIUS_SELECT`: root groups fade by alignment with the drag only past the first, the second previews the closest compass direction, and crossing the third (the drawn circle) selects it. **Reduced-motion users see the menu's opening animation (labels and select circle appearing) at its final state immediately.**

Source of truth: `displayOriginAwayFromThumb` and the `RADIUS_*` constants in `lib/src/lib/mobile-gesture-menu.ts`; `MobileGestureRadialMenu` in `lib/src/components/MobileGestureRadialMenu.tsx`.

### Root layout

Root labels pack as a square keypad around the select circle (rationale); each diagonal group carries three options — its primary and two secondaries.

**Must confirm `⌃C` and `Paste` in an in-pane modal before running them.** **Must open a second exploded-option menu for `Quit`** instead of sending input, under the same reset-center, highlight, and select rules as normal option selection.

Source of truth: `MOBILE_GESTURE_GROUPS` and `MOBILE_GESTURE_QUIT_GROUP` in `lib/src/lib/mobile-gesture-menu.ts`; `MOBILE_TERMINAL_KEY_SEQUENCES` in `lib/src/components/MobileTerminalUi.tsx`.

### Selection stages

- **Cardinal directions are one stage**: reaching `RADIUS_SELECT` on N, S, E, or W sends the matching arrow key immediately — **never wait for touch release**.
- **Diagonal directions are two stages**: reaching `RADIUS_SELECT` chooses the group; the compass center resets to where the drag crossed the circle, the group's options explode around it (the primary back along the opposite compass direction, the secondaries ±45° off it), and from there `RADIUS_HIGHLIGHT` previews and `RADIUS_SELECT` chooses and sends an option, again without waiting for release.
- **Releasing after the group selection but before choosing an option cancels the gesture.**

Overshoot handling: **the option origin ratchets *outward* along the opening direction while the drag keeps pushing that way**, and **the compass stays visually collapsed while that push is brisk, latching expanded once the drag settles** (`OPTION_EXPAND_RELEASE`). (rationale)

Source of truth: `advanceOptionOrigin` / `MOBILE_GESTURE_OPTION_DIRECTIONS` in `lib/src/lib/mobile-gesture-menu.ts`.

## Input mode selector

The input mode selector controls what appears in the reserve area. **Always visible**, four items, self-labeling on the same rule as the touch selector.

| Mode | Reserve area content |
| --- | --- |
| Sessions | Session rows with active, alert, and TODO state, under group labels when they name more than one group; selecting one makes it the single visible terminal. |
| Recent | Placeholder ([Future](#future)). |
| Type | A button focusing the hidden terminal input — the way back from a dismissed keyboard. Typed keys echo into the terminal as they happen. |
| Draft | Placeholder ([Future](#future)). |

Default input mode is **Type**.

**Must focus the hidden input synchronously inside the Type selector's tap/click handler** (rationale); a follow-up effect retries as best effort. **Switching away from Type blurs the hidden input**, including consumer-controlled switches.

Source of truth: `KEYBOARD_MODES` in `lib/src/components/MobileTerminalUi.tsx`.

## Type mode input

Typing goes through a visually hidden `<textarea>` configured for terminal-style input.

* Normal characters go to the active terminal immediately; Enter sends terminal Enter, Backspace works, and physical `Ctrl+C` sends `\x03`.
* **Must buffer composed text until `compositionend` and leave composing keydowns to the IME**, including its editing and confirmation keys.
* **Must handle software-keyboard Enter and Backspace through `beforeinput` when no `keydown` occurs**, including deletion from the empty hidden input.

Source of truth: `MobileTerminalUi` in `lib/src/components/MobileTerminalUi.tsx`; `isComposingKey` in `lib/src/lib/dom.ts`.

## Keyboard focus invariant

**Pane-content touches must never open the native keyboard.** The pane content area may focus the terminal internally for key routing or mouse handling, but every text input the terminal surface creates — later-mounted ones included — is a non-keyboard target, blurred when the touch starts there; **that blur repeats across the window in which `Wall` can restore focus, and pending retries are cancelled on unmount** (rationale). **The only mobile UI surfaces that may open the native keyboard are the Type selector and the Type reserve area.**

**Must cancel pending focus retries when pane interaction dismisses the keyboard, and pending blur retries when Type explicitly focuses it.**

Source of truth: `MobileTerminalUi` in `lib/src/components/MobileTerminalUi.tsx` and `MobileWall` in `lib/src/components/MobileWall.tsx`; pinned by `lib/src/components/MobileTerminalUi.test.tsx` and `lib/src/components/MobileWall.test.tsx`.

## Future

Potential later additions:

* Real recent commands and a Draft scratchpad (both reserves are placeholder copy today).
* Dual-pane copy/paste.
* Pinned snippets.
* Ctrl+D and Ctrl+Z app-key buttons.
* Alt and modifier behavior.
* Long-press key repeat.
* Multi-touch gestures.
* Trackpad mode.
* Multi-session support (more than one visible session).
