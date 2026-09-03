# Dor Browser Surface — Rationale

> Informative evidence for [dor-browser.md](dor-browser.md), keyed by its headings; nothing here is normative.

## Canonical Params

**What moving a browser Surface's DOM would cost.** A re-parented `<iframe>` reloads, losing scroll, form contents, live scripts, and any open WebSocket. A screencast canvas that moves mid-click breaks click synthesis, whose device coordinates were computed against the old box. Parking the leaf instead of unmounting it makes minimize/reattach free rather than a reload.

## Browser Chrome

**What the scheme ladder decides.** A typed `host:port` renders in the iframe: the proxy frames remote `http://` as readily as loopback. A bare remote host carries no port to mark it a dev server, so `https://` sends it to agent-browser — the path for pages needing real HTTPS or a login.

## Pane Context Menu Connect

**Why activation moves focus at all.** A repeat activation on an already-connected port only re-navigates to the current URL; without the reveal, the click has no visible feedback.

**Why the eager pane is created before `agent-browser open` runs.** A cold daemon boot is 1–3s, and a menu that closes on a pane appearing three seconds later reads as a click that did nothing.

**Why a session-less eager pane is inert.** `maybeRecoverStalePort` returns early when params carry no `session`, so the pane spawns no CLI of its own — no `stream status` fired at a still-booting daemon, no race with the `open` behind it.

**Why the eager pane shows its own placeholder.** The idle placeholder asks for `dor ab open <url>`, telling the user to repeat the action they just took instead of naming the pane's actual state.

**Why the handover is a single params refresh.** Setting `session` is what reconciles the controller and connects it, so landing it ahead of `wsPort`/`binaryPath` — or before `agent-browser open` has returned — connects against a daemon that is not up. Handing it over even after a failed `open` lets the placeholder name what it is waiting for; the menu that would have reported the error closed long ago.

The persisted `wsPort` mirror can lag the controller's already-live port after a buffered write, so a simultaneous session change still reconciles when setting that port itself is a no-op.

## Display Modal And Render Swaps

**Why the iframe swap is eager.** The same 1–3s daemon boot as the context-menu connect, behind a modal that has already closed; and while the swap awaited `open`, a slow page held the iframe on screen for the whole load and a timed-out `open` dropped the swap silently — leaving an orphan `gui-<hex>` browser nobody could see or close.

## Agent-Browser Renderer

**Why one-session-one-surface is not an invariant.** `dor ab` forwards the user's command and then runs `stream status` before it asks the host for a surface, so a surface killed or render-swapped inside that window is gone by the time the trailing request arrives — and the session behind it is still live and needs somewhere to render.

## Agent-Browser Connection

**What parking is worth.** Lath leaves stay mounted, so a background window would otherwise retain every pane's ~20Hz decode and screenshot round trips. The ~1s debounce rides through transient visibility flips and StrictMode remounts without rebuilding the connection.

**What the two-stage split buys.** Three things at once: pointer feedback that does not wait on a screenshot child-process round trip, a resting image sharp on HiDPI, and an idle animated page that does not pay to decode the stream continuously. Either path alone gives up one of the three.

**Why no crisp capture starts inside the provisional window.** A host screenshot round trip is ~120ms against a ~20Hz stream, so *every* capture started while provisional frames are still landing is superseded before it resolves; the shots skipped would never have drawn anything.

**Why a stale-dropped capture must leave the loop dirty.** Nothing is guaranteed to pulse the loop again: a single pointer move over a static page pulses exactly once, and that one pulse is consumed by the very capture the provisional paint supersedes — leaving the pane on the blurry provisional frame until the page happens to change on its own.

**Why every non-crisp painter must bump the draw generation.** The byte-dedup compares an incoming capture against the last crisp draw. A resting page whose crisp bytes match that draw dedups to a no-op and strands the pane on the blurry provisional frame; a freshly re-attached canvas mounts blank and has the same problem.

**Why the connection is dropped at relaunch start rather than left to fail.** The host closes the browser and kills the daemon, so the old socket's close is certain. Left connected, its three reconnect failures flagged the pane "ended" about three seconds into a pop-in that a slow page could hold open for 25s, and the popped-out CDP observer's `get cdp-url` — issued the moment `poppedOut` flipped — landed in the close→reopen gap, where a daemon command spawns a competing headless daemon that the headed relaunch then reattaches to.

**Why `url` is tracked separately from `tabs`.** Measured against agent-browser 0.31.1 (2026-09): on `open`, the stream sends `tabs` (about:blank), then `url` naming the target at navigation commit, and refreshes `tabs` only when the CLI command completes — after `load`. During a slow load the tab list still named the previous page, so a pop-out issued then relaunched the page before the one being loaded.

**Whose limitation the CSS-resolution provisional frame is.** Chromium's `Page.startScreencast` captures in DIP and exposes no DPR knob, so the stream is CSS-resolution whatever the client asks for — upstream Chromium, not something agent-browser chose or could fix.

## Pop-Out

**The symptom when the daemon is not killed first.** `agent-browser --headed open` against a live headless daemon reattaches to it and exits 0, so the host logs a successful headed open and the mode never changes. The user presses Pop out, gets the pane stub with no OS window anywhere, and nothing in the logs says why.

**Why the host does not wait for `open`.** Measured against agent-browser 0.31.1 (2026-09): `open <url>` blocks until the page's `load` event, up to the CLI's 25s default action timeout, then exits 1 with "Operation timed out" — with the daemon up, the tab on the URL, and `stream status` answering. Every other daemon command queues behind it: a `stream status` issued mid-`open` returned after 22s. Meanwhile the daemon writes `<session>.pid` and `<session>.stream` within ~100ms of launch, and the stream serves status, tabs and frames from then on. Awaiting `open` therefore made a slow page cost the whole load before the pane showed anything, and turned the timeout into a "failed" relaunch — one whose headed window was never tracked for shutdown, because tracking followed a zero exit.

**Why the stale state files need the replaced pid.** SIGTERM leaves the dead daemon's `.pid` and `.stream` files in place for the new daemon to overwrite. A port read from the stale file is probed against nothing — unless some other process has since taken it — so the launch also waits for a pid other than the one it killed before it trusts the stream file.

**Why nothing may query the daemon during the close/reopen gap.** With the old daemon dead and the new one not yet up, a `stream status` or tab query spawns a *competing* daemon at `about:blank` — agent-browser's CLI starts one on demand — and the relaunch then races two daemons for the same session.

A post-open blank-tab sweep can become such a query when a later relaunch starts before the earlier page finishes loading, so the host invalidates the earlier sweep as soon as the later close begins.

**Why the stray-`about:blank` sweep is guarded.** The close/reopen pair can leave an extra blank tab beside the navigated one. Sweeping blanks unconditionally is the obvious fix and is wrong: a session whose only tab is legitimately blank would lose it, leaving the pane with nothing to show.

## Agent-Browser Host Capabilities

**Why standalone passes a screenshot path, not bytes.** The sidecar stdio is a JSON-lines pipe shared with PTY traffic; a base64 frame on it would bloat every capture and interleave with terminal output.

**Why `binaryPath` needs a gate of its own.** The subcommand allowlist covers arguments, not the executable: `streamStatus`, `open` and `popOut` supply their own args and each take a `binaryPath`, so an allowlist on subcommands never sees one. And the value is persisted into the pane's params, so an unchecked one is not a one-shot — it is arbitrary local execution in the extension host or the Tauri sidecar on every subsequent launch. Dropping rather than failing degrades a stale or hostile value to "resolve it yourself".

**Why the screenshot path is private.** The frame is a picture of the user's authenticated browser, written by an external process under the ambient umask, so a derivable name in the shared temp directory is readable by anything else on the machine for as long as it exists. Precedent: `standalone/sidecar/clipboard-ops.js` applies the same discipline, cleanup included, to clipboard images.

## Iframe Renderer

**Why a site's framing refusal is overridden.** The framing headers exist to stop a third party from framing a site to deceive its user; here the embed is the user's own `dor iframe` — the same trust boundary the agent-browser renderer already sits on.

**Why CSP is dropped whole rather than per-directive.** The injected shim is an inline script, so a surviving `script-src` blocks it as surely as `frame-ancestors` blocks the frame; salvaging the remaining directives would leave a frame that looks instrumented and silently is not.

**Why a grant gets its own origin instead of a path token.** A dedicated origin keeps root-relative resources and client-side routers working with no body URL rewriting; a path token would have to survive every link, redirect and `fetch` the page makes.

## Iframe Shim

**Why the CLI's own check is not enough.** `open-window` carries a string the framed page chose, and the new-tab prompt in front of it is user consent, not a boundary — the user is agreeing to open a pane, not vetting a scheme. The same check gates `surface.iframe`, a wire protocol on the control socket rather than the CLI, so nothing upstream of it has already filtered.

## Iframe Focus And Rendering Notes

**Why the raw fallback is sandboxed too.** Reading "raw" as the trusted path and the proxy as the one needing containment is backwards: the raw fallback is the case with *no* proxy in front of the page at all.

**What a permission in `allow` actually costs.** `dor iframe` takes any http(s) URL, not just a loopback dev server, and a desktop webview often has no per-site prompt (WKWebView with no media `WKUIDelegate`, WebView2 defaults), so the attribute grants outright what a browser would have asked about — `clipboard-read` most pointedly, since a terminal's clipboard is where secrets get pasted.

## Iframe Host Capability And CSP

**Why the `Origin` rewrite is conditional.** Rewriting vouches that a request came from the upstream's own origin. The grant port is enumerable, so rewriting a foreign origin would let any browser page launder a request; on WebSocket upgrades, which are not protected by CORS, that yields a readable socket the upstream may have refused. Forwarding it unchanged leaves that decision with the upstream.

**What dropping the framing controls outright would grant.** That same enumerable port is no secret, so any page that scanned the ephemeral range gets two things the upstream refused it: a document that answered `DENY` framed anyway, and — through the shim — that document's live URL and anchor hrefs read back.

**Why no request header can recognize the embedder.** An iframe navigation carries no `Origin`, and `Sec-Fetch-Site` reads `cross-site` for our own webview and for a scanning page alike — leaving only a `frame-ancestors` the browser enforces, supplied by the one realm that knows its own chain.

**Why the whole ancestor chain travels, not just the parent.** `frame-ancestors` is checked against every ancestor, and VS Code nests the extension's document two frames deep inside the workbench, so a chain built from the parent alone would not match.

**Why a partial chain is no chain.** A `frame-ancestors` naming a subset of the real ancestors blocks Dormouse's own frame, the one embed that must always work. Failing closed to "no chain" instead leaves the caller exactly what the upstream would have served it directly.

**Why the idle timer refreshes for an absent `Origin`.** "Own origin only" would expire a grant the user is still looking at, because a live frame's navigations and sub-resource loads carry no `Origin` at all. What a foreign `Origin` must not buy is keeping a closed pane's grant — and its live upstream binding — alive indefinitely by polling.
