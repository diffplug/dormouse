# Mobile Terminal UI — Rationale

> Informative companion to [mobile-terminal-ui.md](mobile-terminal-ui.md), keyed by that spec's headings. Nothing here is normative.

## Core layout

**Pan, not resize.** Shrinking the terminal to the space above the keyboard changes its rows, so the PTY resizes and a full-screen TUI (Claude Code, vim) redraws on every keyboard open and close; on a remote Session the laptop's view reflows too. Panning keeps the grid and only moves it, so the rows hidden are the top ones, under the composer. The pan follows `visualViewport` `resize` and `scroll`, which fire through the keyboard's animation; that motion is what the earlier fixed-height keyboard reserve avoided, and it moves the terminal rather than reflowing it. Not yet measured on a real iPhone (2026-10); if Safari fights the pan, the fallback is the resize.

## Touch mode selector

**What consuming pane-content pointer events prevents.** Left alone, xterm translates a `wheel` or `touchmove` over the pane into mouse reports for the inside program, alternate-screen arrow keys, or scrollback motion — all three fight the gesture or the selection the user is making. In Mouse mode the browser competes too, claiming the touch first for panning or text selection, so without suppression a tap or drag never reaches the TUI at all.

**Why Gesture mode also takes primary mouse clicks.** Desktop browsers, narrow desktop viewports, and Storybook have no touchscreen, and a mouse-only reviewer would otherwise see a radial menu that never opens.

## Edge scrolling

The edge gesture routes to either terminal history or a mouse-reporting TUI, neither of which is a browser scroll container. Its coast therefore approximates native scrolling rather than delegating to an overflow element. The exponential decay uses iOS's normal 0.998 rate, documented by [React Native](https://reactnative.dev/docs/scrollview#decelerationrate) (consulted 2026-09). Elapsed-time integration avoids refresh-rate-dependent travel. Recent directional samples avoid stale speed after reversals; release time includes a brief pause, while a longer hold suppresses the coast. Whole terminal lines preclude native subpixel motion and rubber-band bounce; the launch cap bounds wheel reports to a remote TUI.

## Type

**Why no live keystrokes.** A soft keyboard's autocorrect and word prediction act on the text of the field it types into. Sent key by key into an empty hidden field, as the earlier Type mode did, those keystrokes arrived without that help and with corrections replayed as deletions and retypes, which made them unreliable in practice (2026-10). A composed field keeps the keyboard's accuracy.

**Why the focus is synchronous.** Mobile browsers open the native keyboard only for a focus call made while the user gesture is still on the stack; one deferred to `requestAnimationFrame` or a timer may be refused as not user-initiated, so the tap appears to do nothing. The composer is committed with `flushSync` so its field exists to focus in the same handler, and the Password checkbox re-focuses the swapped field the same way.

**Why the paste path.** Apps that enable bracketed paste (Claude Code, zsh) also treat fast multi-character input as pasted, so text and Enter written together would leave the Enter inside the paste as a newline. Sent as a bracketed paste and then a separate Enter, the line submits; multi-line text stays one entry. A password skips it because a password prompt reads raw input.

## Keyboard focus invariant

**Why one blur is not enough.** `Wall` can restore xterm focus in a `requestAnimationFrame` after the touch, undoing a single synchronous blur a frame later. Repeating across a rAF and staggered timers covers that window.

## Pages

**Why the bar goes.** Its touch modes and Type all act on a terminal, so on a page they would be controls that do nothing, taking height from the page (decided 2026-11-01). The header stays because it is the way to Sessions and to a Tool's terminal.
