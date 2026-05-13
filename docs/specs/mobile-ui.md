# Mobile Terminal Website Prototype Spec

## 1. Overview

This document specifies the `/tether` mobile terminal prototype.

The prototype tests one core idea:

```text
Stable terminal viewport + explicit touch mode + explicit keyboard mode.
```

The app should feel like a lightweight mobile terminal playground. It does not
need remote sessions, SSH, user accounts, or production infrastructure.

The website `/tether` prototype exposes a small floating theme switcher above
the terminal. It uses the shared MouseTerm `ThemePicker`.

`/tether` uses the same fake playground terminal stack as `/playground`:
`PlaygroundShellRegistry` attaches a `TutorialShell` to every spawned pane, the
same fake commands dispatch to browser-side runners, and the first pane simply
auto-runs `ascii-splash` as its initial command.

## 2. Prototype Goals

Primary goals:

* Keep the terminal viewport stable when the native phone keyboard opens or closes.
* Let the user explicitly choose what terminal touches mean.
* Let the user explicitly choose what appears in the stable keyboard reserve area.
* Test normal mobile text entry using the native phone keyboard.
* Provide enough terminal behavior to evaluate typing, Enter, Backspace, arrows, Escape, Tab, and app interruption.
* Keep the implementation small and easy to iterate on.

Non-goals:

* Remote shell support.
* SSH support.
* WebSocket transport.
* User accounts.
* Session persistence.
* Command history storage.
* A real draft/scratchpad workflow.
* Advanced gestures.
* Production security hardening.
* Full accessibility implementation.

## 3. Core Layout

The mobile UI is split into fixed and flexible regions:

```text
┌─────────────────────────┐
│ Pane title               │ fixed/small
├─────────────────────────┤
│ Pane content             │ flexible terminal area
├─────────────────────────┤
│ Touch mode selector      │ labeled, always visible
├─────────────────────────┤
│ Keyboard mode selector   │ labeled, always visible
├─────────────────────────┤
│ Keyboard reserve area    │ stable height
│                         │
│ Shows app keyboard UI    │ when OS keyboard hidden
│ Occupied by OS keyboard  │ when OS keyboard visible
└─────────────────────────┘
```

The pane title and pane content come from the embedded `Wall` terminal pane. The
mobile wrapper owns the two selectors and the fixed-height keyboard reserve.
The selector block should use one divider between the Touch and Input rows, with
no divider above Touch and no divider below Input.

The root height must not be recalculated from `window.visualViewport` on every
keyboard resize. The reserve area is intentionally stable so the terminal region
does not bounce while the OS keyboard animates.

## 4. Touch Mode Selector

The touch selector controls what happens when the user touches the pane content
area. It is always visible between the terminal content and the keyboard mode
selector.

The selector must be self-labeling. It should use a compact left-side `Touch`
label plus segmented buttons that include both an icon and a short mode label.
Icon-only touch controls are too hard to discover in this prototype.

Touch modes:

| Mode | Button label | Icon | Availability | Behavior |
| --- | --- | --- | --- | --- |
| Gestures | `Gestures` | `HandPointingIcon` | Always available | Touch drags generate arrow keys. Drag left sends left, drag right sends right, drag up sends up, and drag down sends down. |
| Text selection | `Select` | `CursorTextIcon` | Always available | Touches are reserved for terminal text selection and copy/paste. If the TUI is capturing mouse events, MouseTerm activates mouse override for the active pane. |
| Mouse | `Mouse` | `CursorClickIcon` | Only when the active TUI is capturing mouse events | Touches are passed through as terminal mouse input. |

Default touch mode is **Gestures**.

If Mouse mode is active and the active pane stops capturing mouse events, the
selector must fall back to Gestures.

## 5. Keyboard Mode Selector

The keyboard mode selector controls what appears in the keyboard reserve area.
It is always visible and has four items:

```text
Recent | Type | Draft | Keys
```

The selector must be self-labeling. It should use a compact left-side `Input`
label plus segmented buttons that include both an icon and a short mode label.
The label describes the reserve area's
purpose without adding a longer instruction line.

Keyboard modes:

| Mode | Button label | Icon | Reserve area content |
| --- | --- | --- | --- |
| Recent | `Recent` | `ClockCounterClockwiseIcon` | The entire reserve area displays `Recent - WIP`. |
| Type | `Type` | `TextTIcon` | The reserve area focuses the hidden terminal input. Every typed key is echoed into the terminal as it happens. |
| Draft | `Draft` | `ArticleNyTimesIcon` | The entire reserve area displays `Draft - WIP`. |
| Keys | `Keys` | `KeyboardIcon` | The entire reserve area displays terminal key buttons. |

Default keyboard mode is **Type**.

Switching to Type should focus the hidden input and open the native keyboard
where browser policy allows. Switching away from Type should blur the hidden
input so the app keyboard UI is visible again.

Tapping the **Type** selector must focus the hidden input synchronously during
the tap/click handler. Do not defer this focus to `requestAnimationFrame` or a
timer, because mobile browsers may then treat it as no longer user-initiated and
refuse to open the native keyboard.

## 6. Keys Mode

Keys mode displays exactly these buttons:

```text
Esc   Tab   Space   Enter
←     ↓     ↑       →
```

Mappings:

| Button | Sequence |
| --- | --- |
| Esc | `\x1B` |
| Tab | `\x09` |
| Space | ` ` |
| Enter | `\r` |
| ← | `\x1B[D` |
| ↓ | `\x1B[B` |
| ↑ | `\x1B[A` |
| → | `\x1B[C` |

Tapping a key sends exactly one action. Long-press repeat is not required for v0.

## 7. Type Mode Input

Use a hidden or visually minimal input configured for terminal-style typing:

```html
<textarea
  autocapitalize="off"
  autocomplete="off"
  autocorrect="off"
  spellcheck="false"
  inputmode="text"
  enterkeyhint="enter"
></textarea>
```

Required behavior:

* Normal characters are sent to the active terminal immediately.
* Enter sends terminal Enter.
* Backspace works.
* Physical `Ctrl+C` sends `\x03`.
* Autocorrect and autocapitalization are disabled where possible.
* Input supports mobile keyboard behavior and IME composition.
* The app does not depend only on `keydown` for text input.

## 8. Terminal Playground Behavior

A fake shell is acceptable for v0.

Minimum useful behavior:

* Echo typed characters.
* Maintain a command line buffer.
* Enter submits the current command.
* Backspace edits the current command.
* Arrow keys produce visible behavior.
* Escape and Tab produce visible behavior.
* When a fake full-screen app such as `ascii-splash`, `splash`, `changelog`, or
  `tut` is running, `Ctrl+C` sends `\x03` to that app; if the app exits, the
  terminal returns to the fake shell prompt instead of restarting the app.
* New panes created from the wall get the same fake shell behavior and prompt as
  regular `/playground` panes.

Example commands:

```text
help
clear
echo hello
ascii-splash
changelog
tut
```

The shell only needs enough behavior to test the mobile controls.

## 9. Keyboard Reserve

The keyboard reserve area has a stable height. It should not be recomputed from
`visualViewport` while the native keyboard animates.

When the OS keyboard is hidden, the reserve area shows the selected app keyboard
UI (`Recent - WIP`, Type focus target, `Draft - WIP`, or Keys buttons).

When the OS keyboard is visible, the OS keyboard may cover or occupy that same
physical area. This is preferred over resizing the whole app around the keyboard.

## 10. Touch Interactions

Required interactions:

* Tap keyboard mode selector items.
* Tap touch mode selector items.
* Tap Type reserve area to focus typing.
* Type through the native keyboard.
* Tap key buttons in Keys mode.
* Drag in Gestures mode to send arrow keys.
* Use Text selection mode for terminal selection and copy/paste.
* Use Mouse mode for terminal mouse input when a TUI requests mouse reporting.

Pane-content touches must never open the native keyboard. The pane content area
may focus the terminal internally for key routing or mouse handling, but the
mobile wrapper must configure text inputs created by the terminal surface as
non-keyboard targets (`inputmode="none"`, readonly, not tab-reachable) and
immediately blur them when the touch starts there. Since `Wall` may defer xterm
focus to `requestAnimationFrame`, the wrapper must also repeat that blur shortly
after the touch. The only mobile UI surfaces that should open the native
keyboard are the Type selector and the Type reserve area.

Not required for v0:

* Long-press key repeat.
* Multi-touch gestures.
* Trackpad mode.
* A full command history UI.
* A real draft editor.

## 11. Copy And Paste

Keep copy and paste minimal.

Prototype behavior:

* Text selection mode should allow the existing terminal selection and copy/paste flows to work.
* Let users paste through the native browser/OS paste flow where possible.
* No custom mobile clipboard manager is required.
* No multi-line paste review is required.

## 12. Recommended v0 Scope

Build exactly this:

* One terminal playground screen.
* Floating theme switcher using the shared MouseTerm theme picker.
* Touch mode selector:

```text
Touch  Gestures | Select | Mouse
```

* Keyboard mode selector:

```text
Input  Recent | Type | Draft | Keys
```

* Stable keyboard reserve area.
* Recent reserve content: `Recent - WIP`.
* Draft reserve content: `Draft - WIP`.
* Type mode native mobile keyboard input.
* Keys buttons:

```text
Esc   Tab   Space   Enter
←     ↓     ↑       →
```

* Simple local playground terminal behavior.

## 13. Prototype Success Criteria

The prototype should answer these questions:

1. Does the terminal viewport feel stable when the mobile keyboard opens and closes?
2. Is the touch mode selector understandable and reachable?
3. Are gesture arrows usable enough for command history and cursor movement?
4. Is text selection discoverable and reliable on mobile?
5. Is Mouse mode useful when a TUI captures mouse events?
6. Does native keyboard Type mode feel acceptable for terminal text entry?
7. Does the stable keyboard reserve feel better than resizing the whole UI?
8. Is the UI too cramped in portrait orientation?

## 14. Future Work

Potential later additions:

* Real recent commands.
* Draft scratchpad.
* Dual-pane copy/paste.
* Pinned snippets.
* Ctrl+C, Ctrl+D, and Ctrl+Z app-key buttons.
* Alt and modifier behavior.
* Home, End, PgUp, PgDn.
* Long-press key repeat.
* Remote backend PTY.
* SSH sessions.
* User accounts.
* Session persistence.
* Multi-session support.
* Production security model.

## 15. Product Principle

The v0 prototype should stay focused:

```text
Touch modes make pane touches explicit.
Keyboard modes make the reserve area explicit.
Everything else waits.
```
