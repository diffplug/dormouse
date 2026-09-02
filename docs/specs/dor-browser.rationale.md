# Dor Browser Surface — Rationale

> Informative evidence for [dor-browser.md](dor-browser.md), keyed by its headings; nothing here is normative.

## Pane Context Menu Connect

**Why activation moves focus at all.** A repeat activation on an already-connected port only re-navigates to the current URL. Unlike focus-neutral `dor` surface creation, this reveal moves focus so the click has visible feedback.

**Why the eager pane is created before `agent-browser open` runs.** A cold daemon boot is 1–3s. A menu that closes on a pane that appears three seconds later reads as a click that did nothing, so the pane is created synchronously and the CLI work happens behind it.

**Why the eager pane shows its own placeholder.** The idle placeholder asks for `dor ab open <url>`, wrongly telling the user to repeat the action. `Connecting to browser session…` exposes the pane's actual state.

## Agent-Browser Connection

**What parking is worth.** Lath leaves stay mounted, so a background window would otherwise retain every pane's ~20Hz decode and screenshot round trips. The ~1s debounce rides through transient visibility flips and StrictMode remounts without rebuilding the connection.

**What the two-stage split buys.** Three things at once: hover and other pointer feedback that does not wait on a screenshot child-process round trip, a resting image that is sharp on HiDPI, and an idle animated page that does not pay to decode the stream continuously. Either path alone gives up one of the three.

**Why no crisp capture starts inside the provisional window.** A host screenshot round trip is ~120ms against a ~20Hz stream, so *every* capture started while provisional frames are still landing is superseded before it resolves. The loop therefore starts none and takes one settled shot at the window's end — and the deferral is free of pixels, because the shots it skips would never have drawn anything.

**Why a stale-dropped capture must leave the loop dirty.** Nothing is guaranteed to pulse the loop again: a single pointer move over a static page pulses exactly once, and that one pulse is consumed by the very capture the provisional paint supersedes. Without the dirty mark, the pane would sit on the blurry provisional frame until the page happened to change on its own.

**Whose limitation the CSS-resolution provisional frame is.** Chromium's `Page.startScreencast` captures in DIP and exposes no DPR knob, so the stream is CSS-resolution no matter what the client asks for. That is upstream Chromium, not something agent-browser chose or could fix.

## Pop-Out

**The symptom when the daemon is not killed first.** `agent-browser --headed open` against a live headless daemon reattaches to it and exits 0, so the host logs a successful headed open and the mode never changes. The user presses Pop out and gets the pane stub with no OS window anywhere, and nothing in the logs says why. That is what makes the pid-file kill and the wait-for-exit part of the sequence rather than best-effort cleanup.

**Why the stray-`about:blank` sweep is guarded.** The close/reopen pair can leave an extra blank tab beside the navigated one. Sweeping blanks unconditionally is the obvious fix and is wrong: a session whose only tab is legitimately blank would lose it, leaving the pane with nothing to show. Requiring that a real page be open first makes the sweep a no-op in exactly that case.

## Agent-Browser Host Capabilities

**Why `binaryPath` needs a gate of its own.** The subcommand allowlist covers arguments, not the executable: `streamStatus`, `open` and `popOut` supply their own args and each take a `binaryPath`, so an allowlist on subcommands never sees one. And because the value is persisted into the pane's params, an unchecked one is not a one-shot — it is arbitrary local execution in the extension host or the Tauri sidecar on every subsequent launch. Refusing by dropping rather than failing means a stale or hostile value degrades to "resolve it yourself".

**Why the screenshot path is private.** The frame is a picture of the user's authenticated browser, written by an external process under the ambient umask, so a derivable name in the shared temp directory is readable by anything else on the machine for as long as it exists. `standalone/sidecar/clipboard-ops.js` already applies the same discipline, cleanup included, to clipboard images.

## Iframe Shim

**Why the CLI's own check is not enough.** `open-window` carries a string the framed page chose, and the new-tab prompt in front of it is user consent, not a boundary — the user is agreeing to open a pane, not vetting a scheme. The same check gates `surface.iframe`, which is a wire protocol on the control socket rather than the CLI, so nothing upstream of it has already filtered.

## Iframe Focus And Rendering Notes

**Why the raw fallback is sandboxed too.** It is tempting to read "raw" as the trusted path and the proxy as the one needing containment; it is the reverse. The raw fallback is the case with *no* proxy in front of the page at all.

**What a permission in `allow` actually costs.** `dor iframe` takes any http(s) URL, not just a loopback dev server, and a desktop webview often has no per-site prompt (WKWebView with no media `WKUIDelegate`, WebView2 defaults), so the attribute grants outright what a browser would have asked about. `clipboard-read` most pointedly, since a terminal's clipboard is where secrets get pasted.

## Iframe Host Capability And CSP

**Why the `Origin` rewrite is conditional.** Rewriting vouches that a request came from the upstream's own origin. The grant port is enumerable, so rewriting a foreign origin would let any browser page launder a request; on WebSocket upgrades, which are not protected by CORS, that yields a readable socket the upstream may have refused. Forwarding the foreign origin unchanged leaves that decision with the upstream.

**Why no request header can recognize the embedder.** An iframe navigation carries no `Origin`, and `Sec-Fetch-Site` reads `cross-site` for our own webview and for a page that scanned the ephemeral range alike. That is what forces the recognizer to be a `frame-ancestors` the browser enforces, supplied by the one realm that knows its own chain.

**Why a partial chain is no chain.** A `frame-ancestors` naming a subset of the real ancestors blocks Dormouse's own frame, which is the one embed that must always work. Failing closed to "no chain" instead leaves the caller exactly what the upstream would have served it directly, so the degraded case is safe in both directions.

**Why the idle timer refreshes for an absent `Origin`.** "Own origin only" would expire a grant the user is still looking at, because a live frame's navigations and sub-resource loads carry no `Origin` at all. What a foreign `Origin` must not buy is keeping a closed pane's grant — and its live upstream binding — alive indefinitely by polling.
