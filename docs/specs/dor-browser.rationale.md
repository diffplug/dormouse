# Dor Browser Surface — Rationale

> Informative companion to [dor-browser.md](dor-browser.md): the evidence, derivations, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Pane Context Menu Connect

**Why activation moves focus at all.** Every other `dor` surface creation is focus-neutral, so the reveal is the one exception in the family and looks inconsistent until you try a repeat activation on an already-connected port: the session merely re-navigates to the URL it is already on, so nothing on screen changes. The focus transfer is the only feedback that the click did anything.

**Why the eager pane is created before `agent-browser open` runs.** A cold daemon boot is 1–3s. A menu that closes on a pane that appears three seconds later reads as a click that did nothing, so the pane is created synchronously and the CLI work happens behind it.

**Why the eager pane shows its own placeholder.** The idle agent-browser panel's placeholder is the `run dor ab open <url>` line — correct for a pane nobody has connected, and exactly wrong here, since it asks the user to redo by hand the click they just made. `Connecting to browser session…` is the same pane admitting it is mid-boot.

## Agent-Browser Connection

**What parking is worth.** A Lath leaf is always mounted — there is no active-tab or off-screen gating anywhere below it — so a backgrounded window would otherwise hold every browser pane's ~20Hz stream decode plus a screenshot round trip per pulse, for pixels nobody can see. The ~1s debounce exists because the two cheapest ways to become invisible (a quick visibility flip, a React StrictMode remount) are both transient, and tearing down a connection for either one costs more than waiting them out.

**What the two-stage split buys.** Three things at once: hover and other pointer feedback that does not wait on a screenshot child-process round trip, a resting image that is sharp on HiDPI, and an idle animated page that does not pay to decode the stream continuously. Either path alone gives up one of the three.

**Why no crisp capture starts inside the provisional window.** A host screenshot round trip is ~120ms against a ~20Hz stream, so *every* capture started while provisional frames are still landing is superseded before it resolves. The loop therefore starts none and takes one settled shot at the window's end — and the deferral is free of pixels, because the shots it skips would never have drawn anything.

**Why a stale-dropped capture must leave the loop dirty.** Nothing is guaranteed to pulse the loop again: a single pointer move over a static page pulses exactly once, and that one pulse is consumed by the very capture the provisional paint supersedes. Without the dirty mark, the pane would sit on the blurry provisional frame until the page happened to change on its own.

**Whose limitation the CSS-resolution provisional frame is.** Chromium's `Page.startScreencast` captures in DIP and exposes no DPR knob, so the stream is CSS-resolution no matter what the client asks for. That is upstream Chromium, not something agent-browser chose or could fix.

## Pop-Out

**The symptom when the daemon is not killed first.** `agent-browser --headed open` against a live headless daemon reattaches to it and exits 0, so the host logs a successful headed open and the mode never changes. The user presses Pop out and gets the pane stub with no OS window anywhere, and nothing in the logs says why. That is what makes the pid-file kill and the wait-for-exit part of the sequence rather than best-effort cleanup.

**Why the stray-`about:blank` sweep is guarded.** The close/reopen pair can leave an extra blank tab beside the navigated one. Sweeping blanks unconditionally is the obvious fix and is wrong: a session whose only tab is legitimately blank would lose it, leaving the pane with nothing to show. Requiring that a real page be open first makes the sweep a no-op in exactly that case.
