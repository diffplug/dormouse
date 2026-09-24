# Dor Browser Surface — Rationale

> Informative evidence for [dor-browser.md](dor-browser.md), keyed by its headings; nothing here is normative.

## Canonical Params

**What moving a browser Surface's DOM would cost.** A re-parented `<iframe>` reloads, losing scroll, form contents, live scripts, and any open WebSocket. A screencast canvas that moves mid-click breaks click synthesis, whose device coordinates were computed against the old box. Parking the leaf instead of unmounting it makes minimize/reattach free rather than a reload.

## Browser Chrome

**Why the robot is independent of presentation.** Agent visibility is the
important capability boundary: an in-pane screencast and an iframe share the
same human geometry, while only the screencast is available to an agent. A
separate presentation glyph then distinguishes pane-sized, fixed, and popped-out
views without weakening that first signal.

**What the scheme ladder decides.** A typed `host:port` chooses `http://`, which the iframe proxy supports for remote and loopback targets alike. A bare remote host chooses `https://`; entering it in an iframe reports the unsupported scheme and requires an explicit render swap to agent-browser.

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

**What the two-stage split buys.** Three things at once: input feedback that does not wait on a screenshot child-process round trip, a resting image sharp on HiDPI, and an idle animated page that does not pay to decode the stream continuously. Either path alone gives up one of the three.

**Why keys open the window too.** A keystroke's echo is the most latency-sensitive paint there is; outside the window it waited a whole crisp capture — ~120ms, plus up to ~180ms of loop pacing in a burst — while a hover repainted from the stream in ~50ms. On HiDPI the typed text is CSS-resolution until 250ms after the last key, then sharpens, as hover already did.

**Why no crisp capture starts inside the provisional window.** A host screenshot round trip is ~120ms against a ~20Hz stream, so *every* capture started while provisional frames are still landing is superseded before it resolves; the shots skipped would never have drawn anything.

**Why an overdue capture paints the stream and is never re-issued.** `open` holds the daemon's queue until the page loads, up to 25s (see [Pop-Out](#pop-out)), and the URL bar, `dor ab open` and every relaunch run it. A capture issued meanwhile waits behind it, so the canvas stayed on the previous page for the whole load while the stream was already showing the new one. An 8s watchdog then freed the slot and spawned another `screenshot` into the same queue — about three blocked CLI processes by 25s — and on VS Code the first reply's unlink could delete the second capture's file. VS Code's adapter gave up on a reply after 10s and the webview re-asked the same way, posting the full JPEG to both requests once it came; every adapter now waits 30s, and the host still joins concurrent captures, since surfaces can share a session. When each overdue paint counted against the held capture, it was discarded on arrival and re-taken — an extra full capture on every slow navigation, the crisp frame a round trip late. Its wait's pulses still owe one follow-up: a capture queued behind `open` is taken at the end of its round trip, but one slow in itself may have been taken before the page's last change. The overdue round trip timed the page load, not a capture, so the loop clamps it before it enters the pacing average; otherwise the next slow load would wait ~16s to count as overdue.

**Why a stale-dropped capture must leave the loop dirty.** A provisional frame can supersede the host capture or its pending bitmap decode. Nothing is guaranteed to pulse the loop again: a single pointer move over a static page pulses exactly once, and that one pulse is consumed by the very capture the provisional paint supersedes — leaving the pane on the blurry provisional frame until the page happens to change on its own.

**Why every non-crisp painter must bump the draw generation.** The byte-dedup compares an incoming capture against the last crisp draw. A resting page whose crisp bytes match that draw dedups to a no-op and strands the pane on the blurry provisional frame; a freshly re-attached canvas mounts blank and has the same problem.

**Why the connection is dropped at relaunch start rather than left to fail.** The host closes the browser and kills the daemon, so the old socket's close is certain. Left connected, its three reconnect failures flagged the pane "ended" about three seconds into a pop-in that a slow page could hold open for 25s, and the popped-out CDP observer's `get cdp-url` — issued the moment `poppedOut` flipped — landed in the close→reopen gap, where a daemon command spawns a competing headless daemon that the headed relaunch then reattaches to.

**Why `url` is tracked separately from `tabs`.** Measured against agent-browser 0.31.1 (2026-09): on `open`, the stream sends `tabs` (about:blank), then `url` naming the target at navigation commit, and refreshes `tabs` only when the CLI command completes — after `load`. During a slow load the tab list still named the previous page, so a pop-out issued then relaunched the page before the one being loaded.

**Whose limitation the CSS-resolution provisional frame is.** Chromium's `Page.startScreencast` captures in DIP and exposes no DPR knob, so the stream is CSS-resolution whatever the client asks for — upstream Chromium, not something agent-browser chose or could fix.

## Pop-Out

**The symptom when the daemon is not killed first.** `agent-browser --headed open` against a live headless daemon reattaches to it and exits 0, so the host logs a successful headed open and the mode never changes. The user presses Pop out, gets the pane stub with no OS window anywhere, and nothing in the logs says why.

**Why the host does not wait for `open`.** Measured against agent-browser 0.31.1 (2026-09): `open <url>` blocks until the page's `load` event, up to the CLI's 25s default action timeout, then exits 1 with "Operation timed out" — with the daemon up, the tab on the URL, and `stream status` answering. Every other daemon command queues behind it: a `stream status` issued mid-`open` returned after 22s. Meanwhile the daemon writes `<session>.pid` and `<session>.stream` within ~100ms of launch, and the stream serves status, tabs and frames from then on. Awaiting `open` therefore made a slow page cost the whole load before the pane showed anything, and turned the timeout into a "failed" relaunch — one whose headed window was never tracked for shutdown, because tracking followed a zero exit.

**Why the stale state files need the replaced pid.** SIGTERM leaves the dead daemon's `.pid` and `.stream` files in place for the new daemon to overwrite. A port read from the stale file is probed against nothing — unless some other process has since taken it — so the launch also waits for a pid other than the one it killed before it trusts the stream file.

**Why nothing may query the daemon during the close/reopen gap.** With the old daemon dead and the new one not yet up, a `stream status` or tab query spawns a *competing* daemon at `about:blank` — agent-browser's CLI starts one on demand — and the relaunch then races two daemons for the same session.

A post-open blank-tab sweep can become such a query when a later relaunch, explicit Surface close, or host shutdown starts before the earlier page finishes loading, so the host invalidates the sweep before any close can release that pending launch.

**Why the stray-`about:blank` sweep is guarded.** The close/reopen pair can leave an extra blank tab beside the navigated one. Sweeping blanks unconditionally is the obvious fix and is wrong: a session whose only tab is legitimately blank would lose it, leaving the pane with nothing to show.

## Agent-Browser Host Capabilities

**Why standalone passes a screenshot path, not bytes.** The sidecar stdio is a JSON-lines pipe shared with PTY traffic; a base64 frame on it would bloat every capture and interleave with terminal output.

**Why the verb alone is no boundary.** agent-browser honors launch options after the verb: `agent-browser --session x open about:blank --executable-path /nonexistent` fails with `Failed to launch Chrome at "/nonexistent"` (checked against 0.31.1, 2026-09-23). A verb-only allowlist therefore let an allowed `open`, `back` or `tab` carry `--executable-path`, `--args`, `--extension`, `--init-script`, `--profile`, `--state` or `--proxy` past the `binaryPath` gate; it also passed `close --all` (every session), `tab new <url>`, and `screenshot <path>`, which writes an image over any file the user can write. A session name becomes `<socket dir>/<session>.pid`, whose pid a relaunch SIGTERMs, so a `/` in it reaches outside that directory. The two hosts first parsed the same argv separately and drifted within a day: agent-browser took any URL scheme and any DPR, Playwright http(s) and DPR ≤ 10 — so one parser serves both.

**Why `binaryPath` needs a gate of its own.** The argv check covers arguments, not the executable: `streamStatus`, `open` and `popOut` supply their own args and each take a `binaryPath`, so a check on `command`'s argv never sees one. And the value is persisted into the pane's params, so an unchecked one is not a one-shot — it is arbitrary local execution in the extension host or the Tauri sidecar on every subsequent launch. Dropping rather than failing degrades a stale or hostile value to "resolve it yourself".

**Why the screenshot path is private.** The frame is a picture of the user's authenticated browser, written by an external process under the ambient umask, so a derivable name in the shared temp directory is readable by anything else on the machine for as long as it exists. Precedent: `standalone/sidecar/clipboard-ops.js` applies the same discipline, cleanup included, to clipboard images.

## Playwright Renderer

**Why a failed launch waits for its `open`.** `open` runs unawaited while the host polls for the endpoint. A `close` issued before the CLI has registered the session closes nothing, and the `open` then brings up a Chromium window nothing tracks. Before the launch had a deadline, its worst case (close, 30 s of polling, an 8 s connect, close) ran past the webview's 40 s wait, so a slow pop-out could finish after the webview had restored the previous renderer (review of #773, 2026-09).

**Why a paste is text, not keys.** agent-browser's stream takes only key and mouse events, so its paste replays a key down and up per character. Sent to the Playwright host, whose input queue closes the viewer (1008) at 256 queued messages, any paste over about 128 characters arriving as one burst truncated and dropped the pane into a 2 s reconnect (static reading, 2026-09). The 8192-character chunk keeps a message under the 64 KiB socket cap even when every character JSON-escapes to six bytes.

## Iframe Renderer

**Why a site's framing refusal is overridden.** The framing headers exist to stop a third party from framing a site to deceive its user; here the embed is the user's own `dor iframe` — the same trust boundary the agent-browser renderer already sits on.

**Why CSP is dropped whole rather than per-directive.** The injected shim is an inline script, so a surviving `script-src` blocks it as surely as `frame-ancestors` blocks the frame; salvaging the remaining directives would leave a frame that looks instrumented and silently is not.

The built-in local-file viewer supplies its own content boundary and permits the inline shim, so removing its CSP would expand active documents' resource access. Its response opts into preservation without new renderer or host-bridge state. The proxy adds an independent ancestor policy: CSP policies intersect, so no directive parser or partial reconstruction can accidentally weaken the upstream. An opt-in upstream with stricter framing or script restrictions keeps those restrictions even if the shim cannot run.

**Why a UTF-16 body is recognized by its BOM too.** The browser's BOM sniff wins over any header, so a `text/html` body with no charset but `FF FE` is UTF-16; its latin1 scan finds no markers (every character is followed by a NUL), and the fallback spliced the shim in ahead of the BOM, turning the page to mojibake. A UTF-8 BOM ahead of the fallback position had the same fate.

**Why the HTML path keeps the body's own encoding.** Each was reproduced against the proxy (2026-09-23): relabelling every HTML response `charset=utf-8` overrode both the upstream header and any `<meta charset>`, so a Shift_JIS or windows-1252 page mis-decoded; an upstream that compresses without being asked had the shim prepended to its gzip bytes with `content-encoding: gzip` kept, and the frame failed with `ERR_CONTENT_DECODING_FAILED`; and a valid document with neither `</head>` nor `<body>` got the shim before `<!doctype html>`, switching it to quirks mode. Deleting `Accept-Encoding` on every request sent a remote upstream's scripts and styles uncompressed, typically 3-5x the bytes.

**Why a grant gets its own origin instead of a path token.** A dedicated origin keeps root-relative resources and client-side routers working with no body URL rewriting; a path token would have to survive every link, redirect and `fetch` the page makes.

## Iframe Shim

**Why the uninstrumented check waits for a first report.** The proxy instruments `text/html` only, and the parent cannot read a cross-origin frame's content type. A frame judged from its first load flagged every working non-HTML page — `dor iframe …/health.json`, and every image or PDF the file-viewer Tool frames directly. Waiting for one report means the frame has shown it carries the shim, so a later silent load is a real change; a link from an instrumented page to a PDF still flags, which the banner's wording ("not HTML, …") admits.

**Why the CLI's own check is not enough.** `open-window` carries a string the framed page chose, and the new-tab prompt in front of it is user consent, not a boundary — the user is agreeing to open a pane, not vetting a scheme. The same check gates `surface.iframe`, a wire protocol on the control socket rather than the CLI, so nothing upstream of it has already filtered.

**Why the panel checks again.** Every writer of `params.url` ends at the panel, and on a host with no proxy the raw fallback hands that string straight to `<iframe src>` under a sandbox that keeps `allow-same-origin`. Enumerating the writers is the fragile half: the header's URL editor was one the guarded callers did not cover, because `normalizeNavUrl` deliberately keeps a typed `javascript:` or `data:` scheme so the address bar can carry one. React blanks a `javascript:` `src` prop and nothing else, so `data:text/html,…` framed verbatim (reproduced in `IframePanel.test.tsx`, 2026-09) — a framework mitigation the code never claimed, for one scheme out of the set.

**Why each shim hop has two explicit targets.** An injected document cannot tell whether its parent is the app or another document on the grant's proxy origin. It posts to both known origins; the browser delivers only the matching one. A same-origin parent reconstructs and relays only the three pane-level shapes upward; location is document-level, so only the outer document reports it. No wildcard or foreign origin enters the path.

## Iframe Focus And Rendering Notes

**Why the raw fallback is sandboxed too.** Reading "raw" as the trusted path and the proxy as the one needing containment is backwards: the raw fallback is the case with *no* proxy in front of the page at all.

**What a permission in `allow` actually costs.** `dor iframe` takes any http(s) URL, not just a loopback dev server, and a desktop webview often has no per-site prompt (WKWebView with no media `WKUIDelegate`, WebView2 defaults), so the attribute grants outright what a browser would have asked about — `clipboard-read` most pointedly, since a terminal's clipboard is where secrets get pasted.

## Iframe Host Capability And CSP

**Why the `Origin` rewrite is conditional.** Rewriting vouches that a request came from the upstream's own origin. The grant port is enumerable, so rewriting a foreign origin would let any browser page launder a request; on WebSocket upgrades, which are not protected by CORS, that yields a readable socket the upstream may have refused. Forwarding it unchanged leaves that decision with the upstream.

**What dropping the framing controls outright would grant.** That same enumerable port is no secret, so any page that scanned the ephemeral range gets two things the upstream refused it: a document that answered `DENY` framed anyway, and — through the shim — that document's live URL and anchor hrefs read back.

**Why no request header can recognize the embedder.** An iframe navigation carries no `Origin`, and `Sec-Fetch-Site` reads `cross-site` for our own webview and for a scanning page alike — leaving only a `frame-ancestors` the browser enforces, supplied by the one realm that knows its own chain.

**Why the whole ancestor chain travels, not just the parent.** `frame-ancestors` is checked against every ancestor, and VS Code nests the extension's document two frames deep inside the workbench, so a chain built from the parent alone would not match.

**Why a partial chain is no chain.** A `frame-ancestors` naming a subset of the real ancestors blocks Dormouse's own frame, the one embed that must always work. Failing closed to "no chain" instead leaves the caller exactly what the upstream would have served it directly.

**Why the policy also admits `'self'`.** Storybook and similar apps render same-origin documents in nested frames, so an app-only ancestor list blocks their inner document. Each proxy origin belongs to one grant and one fixed upstream; documents already executing there share same-origin authority. Admitting `'self'` deliberately lets a proxy document frame another document from that grant, including after a top-level navigation, but no foreign ancestor matches and no grant can frame another grant.

**Why the idle timer refreshes for an absent `Origin`.** "Own origin only" would expire a grant the user is still looking at, because a live frame's navigations and sub-resource loads carry no `Origin` at all. What a foreign `Origin` must not buy is keeping a closed pane's grant — and its live upstream binding — alive indefinitely by polling.
