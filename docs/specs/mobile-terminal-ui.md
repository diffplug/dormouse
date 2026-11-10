# Mobile Terminal UI

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary. This spec uses it throughout.

The mobile terminal composition: `MobileTerminalUi` (the wrapper owning touch modes, the Type composer, the Sessions screen, and the keyboard pan) around `MobileWall` (one visible terminal Session at a time, with session switching). **Mobile exposes no split-pane layout and no multiple Workspaces.**

Three consumers compose them: the website Pocket playground (`website/src/components/PocketTerminalExperience.tsx` on `FakePtyAdapter`; `docs/specs/tutorial.md`), the Pocket app (`lib/src/remote/pocket-app/PocketWall.tsx` on `RemotePtyAdapter`; `docs/specs/pocket-app.md`), and Storybook.

## Core layout

The terminal fills the screen above one bar of buttons at the bottom: the touch modes, then Type.

**Never resize the terminal for the OS keyboard.** While the composer is open the terminal pans up until its bottom rows sit just above the keyboard, measured from `window.visualViewport`; its rows and columns, and so its PTY size, stay put (rationale).

* Pocket suppresses a terminal's kill (`showKillButton={false}`). A ring shows as the alarm inset on the header bar and on its session-list row.
* **A tap acknowledges the active Session; a drag never does.** **Select mode's router consumes a touch it owns**, so it announces one that never became a drag as `TERMINAL_TAP_EVENT`.
* **Must install `useDynamicPalette` in `MobileTerminalUi`** for gesture tokens; it never mounts the desktop `Wall`.

Source of truth: `withinTapSlop` in `lib/src/components/MobileTerminalUi.tsx`; `TERMINAL_TAP_EVENT` in `lib/src/lib/terminal-mouse-router.ts`. Pinned by `lib/src/components/mobile-acknowledge.test.tsx`.

## Touch mode selector

The touch selector controls what a pane-content touch does.

| Mode (button label) | Availability | Behavior |
| --- | --- | --- |
| Gestures | Always | Either-edge drags scroll; other pane-content touches, pen presses, and primary clicks open the radial menu. |
| Text selection (`Select`) | Always | Touch, pen, and primary drags select terminal text as on desktop; a capturing pane gets mouse override. |
| Mouse | Active TUI capturing mouse events | Touches are passed through as terminal mouse input. |

**Mouse mode falls back to Gestures when the active pane stops capturing mouse events.**

**Must recompute `paneMouseOverride` for every mounted pane from the global touch mode and that pane's own reporting state**; a switched-away pane must not retain a stale override. The consumer owns the loop.

**Must route touch and pen drags in Select mode through the shared terminal mouse-selection router** (`docs/specs/mouse-and-clipboard.md`). **Must send native-paste event text through the shared clipboard writer**, without re-reading the clipboard, a mobile clipboard manager, or multi-line review.

Event routing, by mode (rationale):

* **Gestures / Select** — pane-content `wheel` and `touchmove` are consumed, except Gestures mode's synthesized edge-scroll wheels ([Edge scrolling](#edge-scrolling)).
* **Mouse** — touch events are consumed instead, and primary touch and pen pointers synthesize left-button `mousedown` / `mousemove` / `mouseup` on the element under the pointer. `wheel` still reaches the terminal, and real mouse pointers fall through untouched.

**Never treat a portaled descendant or a control as pane content**: a press outside the host's DOM, or on a button or link inside it (`MobileWall`'s header), starts no touch mode or tap, so the control takes its own press.

**Must release a tracked Mouse-mode press on pointerup or cancel even after leaving Mouse mode.** Cancellation releases on the last target.

**Gesture mode also takes primary mouse/trackpad clicks**, which open the radial menu and **must never reach xterm or the pane** for focus, selection, or pane interaction (rationale). **Non-primary mouse buttons are ignored**, so their browser or host behavior continues.

Source of truth: `TOUCH_MODES`, `paneMouseOverride`, `isPortaledTarget`, and `isHostControlTarget` in `lib/src/components/MobileTerminalUi.tsx`; per-pane wiring in `lib/src/remote/pocket-app/PocketWall.tsx` and `website/src/components/PocketTerminalExperience.tsx`.

## Edge scrolling

**Must reserve a strip at both edges of the pane for scrolling in Gestures mode**, locking the drag's owner and Session at pointerdown until release or cancel. Vertical movement accumulates into whole lines; content follows the finger, with no radial-menu input or native-keyboard focus.

**Must coast after a touch or pen flick**, retaining fractional-line travel; a held or stationary press, mouse drag, or pointer cancellation launches no momentum (rationale).

**Must send wheel events through xterm when the Session captures the mouse**, clamping the reported coordinates inside its terminal screen. **Must otherwise scroll the terminal buffer directly**, never synthesize alternate-screen arrow keys. **Must stop momentum at a buffer boundary, on a new pane press, or when the document becomes hidden.** **Must stop scrolling when interaction is disabled, the touch mode changes, or the active Session changes.**

Source of truth: `EdgeScrollMotion` / `scrollMobileTerminal` in `lib/src/lib/mobile-terminal-scroll.ts`.

## Gesture mode

Touching the pane content away from either edge opens the radial menu (the rose), offset from the touch so the thumb never covers it. Drag distance from its center decides everything, in the order `RADIUS_FADE_START` < `RADIUS_HIGHLIGHT` < `RADIUS_SELECT`: root groups fade by alignment with the drag only past the first, the second previews the closest compass direction, and crossing the third (the drawn circle) selects it. **Reduced-motion users see the menu's opening animation (labels and select circle appearing) at its final state immediately.**

Source of truth: the `RADIUS_*` constants in `lib/src/lib/mobile-gesture-menu.ts`; `MobileGestureRadialMenu` in `lib/src/components/MobileGestureRadialMenu.tsx`.

### Root layout

Each diagonal group carries three options — its primary and two secondaries.

**Must confirm `⌃C` and `Paste` in an in-pane modal before running them.** **Must drop that confirmation, and close the composer and forget its draft, when the active Session changes**, so neither reaches a Session the phone did not pick. **Must open a second exploded-option menu for `Quit`** instead of sending input, under the same reset-center, highlight, and select rules as normal option selection.

Source of truth: `MOBILE_GESTURE_GROUPS` and `MOBILE_GESTURE_QUIT_GROUP` in `lib/src/lib/mobile-gesture-menu.ts`; `MOBILE_TERMINAL_KEY_SEQUENCES` in `lib/src/components/MobileTerminalUi.tsx`.

### Selection stages

- **Cardinal directions are one stage**: reaching `RADIUS_SELECT` on N, S, E, or W sends the matching arrow key immediately — **never wait for touch release**.
- **Diagonal directions are two stages**: reaching `RADIUS_SELECT` chooses the group; the compass center resets to where the drag crossed the circle, the group's options explode around it, and from there `RADIUS_HIGHLIGHT` previews and `RADIUS_SELECT` chooses and sends an option, again without waiting for release.
- **Releasing after the group selection but before choosing an option cancels the gesture.**

Source of truth: `MOBILE_GESTURE_OPTION_DIRECTIONS` in `lib/src/lib/mobile-gesture-menu.ts`.

## Type

Type opens the composer at the top of the visible screen: a text field, then a Password checkbox, Cancel, and Send.

**Mobile never sends a soft keyboard's keystrokes as they are typed**; text reaches the terminal only by Send (rationale).

* **Must focus the composer's field synchronously inside the Type tap** (rationale).
* **Send writes the text through the consumer's paste path, then Enter** (rationale).
* **A password is masked and written as input, never through the paste path.**
* Send and Cancel clear the Password checkbox. Send clears the text; any other close keeps it for the next Type, unless a password.

Source of truth: `MobileTerminalUi` and `Composer` in `lib/src/components/MobileTerminalUi.tsx`.

## Physical keyboard

**While the composer is closed, no gesture confirmation is open, and the terminal is showing, a physical keyboard types straight into the terminal.** **Must leave to the page** a key aimed at a focused field or control, a Command or Option chord, the `Ctrl (+Shift) + V` paste chord, and IME composition. A soft keyboard opens only for a focused field, so it never reaches this path.

Source of truth: `hardwareKeySequence` and `isHardwareKeyTarget` in `lib/src/components/MobileTerminalUi.tsx`.

## Sessions screen

Tapping the Session title in the `MobileWall` header asks the consumer to show the Sessions screen over the whole composition; the terminal stays mounted beneath at its size. Choosing a row shows that Session. A consumer's `settings` (`MobileSettings`: theme, and font size over a sample) open from the screen's Settings button. **A consumer's `sessionsHeader` heads the screen, not the wall**: the wall keeps one header row, so what a connection is and how to leave it live here. **Must offer the Sessions screen with no Session too**, since no header is there to tap.

* **The font size applies to every terminal in the page, live ones refit**, so a remote Session's PTY resizes with it; **must hand it back to the theme when the composition unmounts**.
* **Must save Settings choices only when the consumer persists them**; the one-time page does not (`docs/specs/one-time.md` -> "Phone page").

Source of truth: `SessionsScreen` in `lib/src/components/MobileTerminalUi.tsx`; `MobileSettings` in `lib/src/components/MobileSettings.tsx`; `useMobileFontSize` in `lib/src/lib/mobile-font-size.ts`; `setTerminalFontSize` in `lib/src/lib/terminal-lifecycle.ts`.

## Browser

A Session whose `kind` is `browser` shows a browser alone, and a `tool` shows its browser over its terminal, which stays mounted beneath at its size. What shows it is the consumer's, an iframe today, with a status from `MobileBrowserPane`. `browserDisplay` names how, in the desktop's glyphs (`docs/specs/dor-browser.md` -> "Display Modal And Render Swaps").

* **A Tool must open on its browser.**
* **Must put a Tool's Browser and Terminal mode buttons at the header's far left**, in that order, the desktop's glyphs marking the mode showing; a browser alone shows its glyph, with nothing to switch to.
* **Must keep the header while a browser shows, and drop the bottom bar and the composer**: touches and keys are the browser's, so no gesture, touch mode, or physical key reaches the terminal (rationale).
* **Must not mount a terminal for a `browser`.**
* **Must offer a close in a `tool` or `browser` header, in either mode, through `onBrowserClose`**, even where the consumer hides the terminal's kill; what closing does is the consumer's.
* **`MobileCloseDialog` asks what the desktop asks, in its words**, the confirmation's letter tapped rather than typed, away from the header's close so a double-tap cannot answer it.
* **The browser layer ends at the bottom safe area**, which a framed document cannot read for itself.
* **A session that cannot carry a page says why, and how to get one**: the direct path's wait and a relayed session's note are `MobileBrowserPane`'s, the note naming a VPN on both devices and a reconnect, since a session tries the direct path once (`docs/specs/remote-api.md` -> "Frames").

Source of truth: `MobileWall` in `lib/src/components/MobileWall.tsx`; `MobileBrowserPane` in `lib/src/components/MobileBrowserPane.tsx`; `browserShown` in `lib/src/components/MobileTerminalUi.tsx`.

## Keyboard focus invariant

**Pane-content touches must never open the native keyboard.** The pane content area may focus the terminal internally for key routing or mouse handling, but every text input the terminal surface creates — later-mounted ones included — is a non-keyboard target, blurred when the touch starts there; **that blur repeats across the window in which `Wall` can restore focus** (rationale). **The only mobile UI surface that may open the native keyboard is the composer.**

Source of truth: `MobileTerminalUi` in `lib/src/components/MobileTerminalUi.tsx` and `MobileWall` in `lib/src/components/MobileWall.tsx`; pinned by `lib/src/components/MobileTerminalUi.test.tsx`.

## Future

**Scope: mobile-browser-streams** — agent-browser and Playwright on a phone (`docs/specs/remote-api.md` -> Future, "Browser surfaces"): a screencast as `MobileBrowserPane`'s `view`, its touches sent as input, and the Browser button opening a display choice once a Surface has more than one to offer.

**Scope: mobile-backlog** — unprioritized:

* Recent commands in the composer.
* Dual-pane copy/paste.
* Pinned snippets.
* Ctrl+D and Ctrl+Z app-key buttons.
* Alt and modifier behavior.
* Long-press key repeat.
* Multi-touch gestures.
* Trackpad mode.
* Multi-session support (more than one visible session).
