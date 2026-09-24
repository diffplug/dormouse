# Dor Browser Surface — Rationale

> Informative evidence for [dor-browser.md](dor-browser.md), keyed by its headings; nothing here is normative.

## Canonical Params

**What moving a browser Surface's DOM would cost.** A re-parented `<iframe>` reloads, losing scroll, form contents, live scripts, and any open WebSocket. A screencast canvas that moves mid-click breaks click synthesis, whose device coordinates were computed against the old box. Parking the leaf instead of unmounting it makes minimize/reattach free rather than a reload.

**Why no stream port is a param.** It is ephemeral, and a persisted one was always wrong after a restart (static reading, 2026-09): the Playwright port is the host's own in-process viewer server, so every restored Playwright pane failed three connects (immediate, +2 s, +4 s) and read "ended" after ~6 s; an agent-browser one after a reboot named nothing, and the stale-port recovery that followed asked `stream status`, which starts a daemon at `about:blank` — the pane showed a blank page while its header still named the real one. The recovery machinery that existed only for stale ports (`maybeRecoverStalePort`, two generation counters, a "this port opened live" marker) went with it. Kept as an unpersisted param, `wsPort` still needed seven scrubs across four files, and the params diff could not see the same port handed over twice (review, 2026-09).

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

**Why the eager pane shows its own placeholder.** The idle placeholder asks for `dor agent-browser open <url>`, telling the user to repeat the action they just took instead of naming the pane's actual state.

**Why a reuse is one intent.** Revealing the target and then asking for its mode and its URL separately sent `open <url>` in the same tick as a pop-out began its close/reopen, deterministically: the navigation raced the relaunch, which had already captured the old URL.

## Display Modal And Render Swaps

**Why the iframe swap is eager.** The same 1–3s daemon boot as the context-menu connect, behind a modal that has already closed; and while the swap awaited `open`, a slow page held the iframe on screen for the whole load and a timed-out `open` dropped the swap silently — leaving an orphan `gui-<hex>` browser nobody could see or close.

**Why the Surface's controller launches, not the Wall.** The launch-and-bind existed four times — Tool swap, iframe/cross-provider swap, context-menu port, Tool serving — each with its own "still wanted?" predicate and failure rule, racing the controller it handed a session to. Because the launch lived in a Wall closure rather than on the Surface, a session-less pane that was persisted, or whose webview reloaded mid-launch, restored session-less forever, and Tool serving still blocked on the page load (static reading, 2026-09).

**Why a failed swap's restore reopens the previous session.** A fresh `gui-<hex>` session kept a `key` badge that `dor agent-browser --key` no longer resolved to, and the next command opened a second pane.

**Why the host owns sync-to-pane.** The webview judged it: once a frame confirmed the size it issued, any report of another size disengaged sync. Its reports came from frames and from `status`, and Playwright's `status` comes from a 750 ms poll that measures with an asynchronous `page.evaluate`. A poll begun before a write published the size from before it after a frame had confirmed the new one, and the pane flipped to Fixed on its own; Playwright panes did so often during resizes (reported 2026-09-24). Reproduced against playwright-cli 0.1.21 (Chromium 154, 2026-09-24): an evaluate begun 50 ms before a `setViewportSize` landed answered the old 950×650 about 240 ms after it. One begun after the write resolved never did (0 of 100; the write took 2 ms at p50, 5 ms at p95), so a measurement tagged with its start is authoritative. The webview has no view of when a write begins or lands; the host issues the writes and relays every report.

**Why agent-browser's frames, and Playwright's measurements.** agent-browser 0.31.1's frames matched `set viewport 900 600 2` exactly, about 30 ms after the command returned (2026-09-24). Its headless `status` followed too, so it is not always 1280×720; only a headed window's `status` names the daemon's configured viewport (see [Viewer Socket](#viewer-socket)). Playwright's screencast metadata is no measure of the viewport. Under `setViewportSize` it reported the height 87 px short (900×513 for 900×600). After a tab switch it stayed at 1280×633, even through a repaint, while the page measured 950×650 (playwright-cli 0.1.21, 2026-09-24). Frames are CSS-resolution, so neither provider shows the ratio.

**Why 250 ms.** A frame already in flight when a write lands still shows the old size. The next one follows within a frame or two: 20 Hz, with Playwright's acks paced at 50 ms.

**Why a page shown anew is written, not judged.** A tab Playwright opens comes up at its context's viewport (1280×720 beside a synced 900×600 page, 2026-09-24), and the pane's own tab strip can select one, so the webview's heuristic read either as another writer. agent-browser gives a new tab the viewport's size (at ratio 1).

**Why the pane's laid-out size.** A Workspace presentation scales the Wall's subtree while it moves. `getBoundingClientRect` read mid-scale, as a harness reload does, synced a Playwright page to 681×589 in a 689×596 pane (0.988, 2026-09-24). No resize followed to correct it.

## Automated Browser

**Why one-session-one-surface is not an invariant.** `dor` forwards the user's command before it asks the host for a surface, so a surface killed or render-swapped inside that window is gone by the time the trailing request arrives — and the session behind it is still live and needs somewhere to render.

**Why a bare Wall mints its own key scope.** Every VS Code webview is a bare Wall, and each named `--key default` `dormouse.1.default`: two webviews' default browsers were one browser behind two Surfaces, and killing either closed it under the other. Playwright had avoided it with random session names and a reservation; one deterministic scheme with a scope unique per bare Wall covers both, and needs no migration because a key finds its Surface's stored session first (review of the browser stack, 2026-09).

## Managed identity

**Why a key numbers past sessions held elsewhere.** A key's session is `dormouse.<scope>.<name>`, and the key lookup searches only the answering Wall. A pane bound to that session which left for another Workspace keeps it, so the same command here bound a second pane to the same browser, and closing either closed the other's (review of #777, 2026-09). Playwright keys had minted a fresh UUID each, so this was new there; agent-browser keys always worked this way.

## Browser Connection

**What parking is worth.** Lath leaves stay mounted, so a background window would otherwise retain every pane's ~20Hz stream and its crisp captures. The ~1s debounce rides through transient visibility flips and StrictMode remounts without rebuilding the connection.

**Why the canvas keeps its crisp size.** Provisional frames (CSS pixels) and crisp ones (device pixels) alternate on every hover, and sizing the canvas to each reallocated its backing store — about 14.7 MB at 2560×1440 — and changed the intrinsic size of a `max-w-full max-h-full` canvas, forcing layout, on every switch (static reading, 2026-09). Pointer mapping is unaffected: it scales by the device width over the canvas width, whatever the canvas's size.

**Why a paste is text, not keys.** agent-browser's stream takes only key and mouse events, so a paste once went from the webview as a key down and up per character. Sent to the Playwright host, whose input queue closes the viewer (1008) at 256 queued messages, any paste over about 128 characters arriving as one burst truncated and dropped the pane into a 2 s reconnect (static reading, 2026-09). The host now expands a paste into key pairs only where the daemon takes them, and the 8192-character chunk keeps a message under the 64 KiB socket cap even when every character JSON-escapes to six bytes.

**Why the connection is dropped at relaunch start rather than left to fail.** The host closes the browser and kills the daemon, so the old socket's close is certain. Left connected, its three reconnect failures flagged the pane "ended" about three seconds into a pop-in that a slow page could hold open for 25s. When the popped-out URL observer still ran in the webview, its `get cdp-url` — issued the moment `poppedOut` flipped — landed in the close→reopen gap, where a daemon command spawns a competing headless daemon that the headed relaunch then reattaches to; flipping headedness before leaving `live` started it there too. Now it would open a headed viewer socket onto the browser being closed.

**Why one daemon gate, not a check per call site.** The rule against daemon commands in the relaunch gap was a `relaunching` flag each caller had to check, and most did not (static reading, 2026-09): the header's back/forward/reload/URL edit, the Display modal's device and custom viewport, tab clicks, sync-to-pane (reached by a resize once a pop-in had already flipped `poppedOut`), and Cmd-A/C/X all reached the daemon mid-relaunch. The lifecycle behind it was a dozen flags whose invariants lived in five predicates. Once captures and the popped-out URL observer moved into the host, and the host itself refused operations mid-relaunch (see [Browser Host](#browser-host)), the gate was left ordering the Surface's own intents.

**Why an unpark streams from its parked port first, and attaches with no page.** Asking the host first cost every unpark an attach round trip (a pid and stream-file read plus a port probe) before the first frame, for a daemon that almost never moves while hidden (review, 2026-09). When it did move, or went away: a daemon gone while the pane was hidden is the same failure as one gone while visible, which the pane shows as ended; relaunching it on unpark would hide that failure and undo a `dor agent-browser close` made meanwhile. A restore has no such history, so it reopens the page.

**Why a dropped headless stream ends.** While a drop only flagged the connection lost, the phase stayed `live` and the gate open, so a URL-bar navigation ran `open`, which started a daemon on a port the controller never learned; the placeholder read "ended" off three separate signals (review, 2026-09). Attach never spawns, so leaving `live` loses nothing a navigation or `dor` handover cannot reach again.

**Why a launch opens the pending page itself.** A navigation out of `ended` relaunched a gone daemon at that page through `attach`, then ran `open` for it again on `live`: the page reloaded right after its first load, dropping any state it had set up and repeating a non-idempotent GET (review of #775, 2026-09). The controller cannot tell a relaunch from a found daemon on its own, since both answer a port, so `attach` says which. A launch carrying the previous page instead loaded that page first and then navigated away from it.

**Why the launch-failure policy is a param.** Its four creators each awaited an in-memory waiter with its own liveness check, so a pane persisted mid-launch — or whose webview reloaded — then failed, showed "ended" instead of its creator's fallback (review, 2026-09).

**Why a new `url` mid-launch is a navigation.** Tool serving stopped awaiting the launch, so an announcement landing mid-launch wrote a new `url` with the session still unbound; nothing rebound, the launch went live on the old page, and serving had already recorded the announcement, so the pane was never re-framed (review of #775, 2026-09).

**Why an unpark catches up only once its socket opens.** The unpark entered `live` at once, so sync-to-pane and a pending navigation ran before the parked port was proven. With the daemon gone while hidden (`dor agent-browser close`, a crash) and the pane resized meanwhile, as restoring a Door does, `set viewport` started a fresh `about:blank` daemon through the CLI, and the failed stream's attach then streamed it instead of ending (review of #775, 2026-09). The host now refuses that command outright; waiting still keeps the resize and the page owed, rather than refused and lost, until the unpark finds its browser or ends.

## Viewer Socket

**Why the host owns the socket.** Three stream topologies grew beside each other (static reading, 2026-09): standalone dialed the daemon's stream directly, VS Code went through a TCP relay with its own grant table because the daemon rejects `vscode-webview://` origins, and Playwright had its own guarded server. Every crisp capture crossed the host boundary twice — webview → Rust `browser_screenshot` → sidecar stdio → a spawned `screenshot` into a file → Rust reads it → raw IPC back, with the VS Code message channel and the dev harness each carrying a copy — and the webview decoded base64 for every stream frame it painted. It also issued the daemon commands (captures, `stream status`, `get cdp-url`, tab selects) that raced relaunches.

**What the host relay costs.** Measured on this machine with Node 24.18 (2026-09-24), the host viewing a synthetic daemon that sends a ~133 KB base64 frame and a tab list every 50 ms, with the webview's side of each socket in the same process (so an upper bound): a static page cost 1.3% of a core for one pane, 3.4% for four and 4.7% for eight, sending nothing; an animated one, every frame forwarded as binary (~1.9 MB/s per pane), 2.9%, 7.9% and 11.1%. Event-loop delay stayed at the 10 ms sampling floor (p99 12.5-12.7 ms, max ≤ 19.5 ms), so PTY traffic on the same loop is not held up and no worker thread is needed. Classifying, parsing and decoding one changed frame costs ~80 µs of it (15 µs to string, 44 µs `JSON.parse`, 10 µs base64), so decoding every changed frame, sent or not, is not worth deferring.

**Why the heartbeat is compared raw, in the host.** agent-browser's daemon re-sent its current frame and tab list about 20 times a second (~39 of 39 dropped per 2 s on a static page, counted in the debug harness). The webview found each duplicate by running djb2 over the whole string on its main thread: 208 µs per ~133 KB frame in V8, against 2.7 µs for a raw string compare and 2.4 µs for `Buffer.equals` (Node 24.18, 2026-09-24) — about 4 ms of main-thread time per pane per second for nothing, plus a JSON parse and signature of every tab list.

**What the two-stage split buys.** Three things at once: input feedback that does not wait on a screenshot child-process round trip, a resting image sharp on HiDPI, and an idle animated page that does not pay to decode the stream continuously. Either path alone gives up one of the three.

**Why keys open the window too.** A keystroke's echo is the most latency-sensitive paint there is; outside the window it waited a whole crisp capture — ~120ms, plus up to ~180ms of loop pacing in a burst — while a hover repainted from the stream in ~50ms. On HiDPI the typed text is CSS-resolution until 250ms after the last key, then sharpens, as hover already did. Input reaches the host over the socket, and editing chords through its `edit` operation, so the host opens the window for both.

**Why no crisp capture starts inside the provisional window.** A host screenshot round trip is ~120ms against a ~20Hz stream, so *every* capture started while provisional frames are still landing is superseded before it resolves; the shots skipped would never have drawn anything.

**Why an overdue capture paints the stream and is never re-issued.** `open` holds the daemon's queue until the page loads, up to 25s (see [Pop-Out](#pop-out)), and the URL bar, `dor agent-browser open` and every relaunch run it. A capture issued meanwhile waits behind it, so the canvas stayed on the previous page for the whole load while the stream was already showing the new one. An 8s watchdog then freed the slot and spawned another `screenshot` into the same queue — about three blocked CLI processes by 25s — and on VS Code the first reply's unlink could delete the second capture's file. VS Code's adapter gave up on a reply after 10s and the webview re-asked the same way, posting the full JPEG to both requests once it came. The host now bounds a capture at 30s and joins concurrent ones, since surfaces can share a session. When each overdue paint counted against the held capture, it was discarded on arrival and re-taken — an extra full capture on every slow navigation, the crisp frame a round trip late. Its wait's pulses still owe one follow-up: a capture queued behind `open` is taken at the end of its round trip, but one slow in itself may have been taken before the page's last change. The overdue round trip timed the page load, not a capture, so the loop clamps it before it enters the pacing average; otherwise the next slow load would wait ~16s to count as overdue.

**Why a superseded capture is owed again.** Nothing is guaranteed to pulse the loop again: a single pointer move over a static page pulses exactly once, and that one pulse is consumed by the very capture the provisional paint supersedes — leaving the pane on the blurry provisional frame until the page happens to change on its own. With both paints on one ordered socket, and the webview decoding in arrival order, a capture can no longer be superseded during its decode, which the webview once had to guard against too.

**Why a byte-identical capture is resent after a provisional frame or a repaint.** Dropping a capture identical to the last crisp one saves an encode, a send and a decode on a resting page — but only while that capture is what the canvas shows. After a provisional paint the canvas holds the blurry frame, and a freshly re-attached canvas is blank; skipping the identical capture then stranded the pane there.

**Why `url` is a commit edge, apart from `tabs`.** Measured against agent-browser 0.31.1 (2026-09): on `open`, the stream sends `tabs` (about:blank), then `url` naming the target at navigation commit, and refreshes `tabs` only when the CLI command completes — after `load`. During a slow load the tab list still named the previous page, so a pop-out issued then relaunched the page before the one being loaded.

**Whose limitation the CSS-resolution provisional frame is.** Chromium's `Page.startScreencast` captures in DIP and exposes no DPR knob, so the stream is CSS-resolution whatever the client asks for — upstream Chromium, not something agent-browser chose or could fix.

**Why a headed window's page is followed over CDP.** The daemon's stream lists the headed window's tabs, but refreshes them only when a CLI command completes, so a navigation made in the window itself never reached the header. The webview once followed it by holding a browser-level CDP socket from `get cdp-url`, which granted it `Runtime.evaluate` in any target and `file://` navigation (review of the browser stack, 2026-09); the same observer now runs in the host.

**Why a browser that goes is reported, not left to reconnects.** A socket whose browser had gone reconnected three times — immediately, +2 s, +4 s — before a headless pane read "ended" or a closed headed window reverted to the pane, and a Playwright browser's viewers learned of a disconnect only that way (static reading, 2026-09).

**Why a headed browser with no page has gone.** Measured against agent-browser 0.31.1 on macOS (2026-09-24): closing every page of a headed window over CDP (`Target.closeTarget`), as its close button does, left Chrome running with no window, and the daemon's stream sent nothing — no `status`, no `tabs`, no close — for the 12 s watched, so the pane sat on its "separate window" stub. Quitting the browser (`Browser.close`) instead sends `status { connected: false }` and `tabs: []` at once, the path that already reverted. The page count is the only sign of the first; the grace keeps a tab closed and then replaced from reading as it. A Playwright browser outlives its pages the same way, and its `disconnected` fires only on exit.

**Why a headed window's viewport is measured on its page.** The stream's `status` names the viewport the daemon was configured with, not the window's: it said 1280×720 while a fresh headed window's page measured 1200×736 at DPR 2, and resizing the window to 900×700 and then 1100×800 changed the page's `innerWidth`/`innerHeight` with no new `status` (0.31.1, 2026-09-24). A background tab kept its old size through a resize (1200×736 beside the shown page's 1000×557), so only the page shown is measured. The ratio follows the display the window is on, which no resize reports, so it is polled.

**Why the CDP endpoint is asked of a daemon once.** In a browser whose window has closed, the next CLI verb — even `stream status` or `get cdp-url` — silently opened a new `about:blank` window (0.31.1, 2026-09-24). An observer that asked again on reconnecting would bring back the window it was about to report gone.

## Pop-Out

**The symptom when the daemon is not killed first.** `agent-browser --headed open` against a live headless daemon reattaches to it and exits 0, so the host logs a successful headed open and the mode never changes. The user presses Pop out, gets the pane stub with no OS window anywhere, and nothing in the logs says why.

**Why only the pop-in's `close` may reach a windowless browser.** Any other verb reopens a blank window (see [Viewer Socket](#viewer-socket)). `close` does not: in the windowless state it closed Chrome at once, creating no page, and the daemon exited after it (0.31.1, 2026-09-24), so the relaunch's own stop is the teardown. Checked end to end in the browser-dev harness the same day: closing a popped-out window's pages over CDP brought the pane back about a second later, headless at the window's last viewport and ratio (1000×557 at 2; 1100×657 at 1.5 through Pop back in), with no Chrome window left running; closing every page of a Playwright pop-out did the same (1050×633 at 2).

**Why the host does not wait for `open`.** Measured against agent-browser 0.31.1 (2026-09): `open <url>` blocks until the page's `load` event, up to the CLI's 25s default action timeout, then exits 1 with "Operation timed out" — with the daemon up, the tab on the URL, and `stream status` answering. Every other daemon command queues behind it: a `stream status` issued mid-`open` returned after 22s. Meanwhile the daemon writes `<session>.pid` and `<session>.stream` within ~100ms of launch, and the stream serves status, tabs and frames from then on. Awaiting `open` therefore made a slow page cost the whole load before the pane showed anything, and turned the timeout into a "failed" relaunch — one whose headed window was never tracked for shutdown, because tracking followed a zero exit.

**Why the stale state files need the replaced pid.** SIGTERM leaves the dead daemon's `.pid` and `.stream` files in place for the new daemon to overwrite. A port read from the stale file is probed against nothing — unless some other process has since taken it — so the launch also waits for a pid other than the one it killed before it trusts the stream file.

**Why nothing may query the daemon during the close/reopen gap.** With the old daemon dead and the new one not yet up, a `stream status` or tab query spawns a *competing* daemon at `about:blank` — agent-browser's CLI starts one on demand — and the relaunch then races two daemons for the same session.

A post-open blank-tab sweep can become such a query when a later relaunch, explicit Surface close, or host shutdown starts before the earlier page finishes loading, so the host invalidates the sweep before any close can release that pending launch.

## Browser Host

**Why no frame rides a request's transport.** The standalone sidecar's stdio is a JSON-lines pipe shared with PTY traffic, where a base64 frame would bloat every capture and hold up terminal output behind it; captures once detoured through a temp file Rust read back instead, and VS Code posted 100-700 KB typed arrays through the webview message channel. The viewer socket carries them in the host's own loop, off both.

**Why the verb alone is no boundary.** agent-browser honors launch options after the verb: `agent-browser --session x open about:blank --executable-path /nonexistent` fails with `Failed to launch Chrome at "/nonexistent"` (checked against 0.31.1, 2026-09-23). A verb-only allowlist therefore let an allowed `open`, `back` or `tab` carry `--executable-path`, `--args`, `--extension`, `--init-script`, `--profile`, `--state` or `--proxy` past the `binaryPath` gate; it also passed `close --all` (every session), `tab new <url>`, and `screenshot <path>`, which writes an image over any file the user can write. A session name becomes `<socket dir>/<session>.pid`, whose pid a relaunch SIGTERMs, so a `/` in it reaches outside that directory. The two hosts first parsed the same argv separately and drifted within a day: agent-browser took any URL scheme and any DPR, Playwright http(s) and DPR ≤ 10 — so one parser serves both.

**Why `binaryPath` needs a gate of its own.** The request validation covers arguments, not the executable: every operation takes a `binaryPath`, and the argv checks never saw one. And the value is persisted into the pane's params, so an unchecked one is not a one-shot — it is arbitrary local execution in the extension host or the Tauri sidecar on every subsequent launch. Dropping rather than failing degrades a stale or hostile value to "resolve it yourself".

**Why the stray-`about:blank` sweep is guarded.** The close/reopen pair can leave an extra blank tab beside the navigated one, and Playwright's startup leaves one beside a fresh page. Sweeping blanks unconditionally is the obvious fix and is wrong: a session whose only tab is legitimately blank would lose it, leaving the pane with nothing to show. The sweep closes the last tab first because Playwright names tabs by index.

**Why the sweep counts new-tab pages as blank.** Every Chrome agent-browser launches, headed or headless, carries a `chrome://newtab/` page beside the page it opens (0.31.1 with Chrome for Testing 150, 2026-09-24). In a pop-out it was a second "New Tab" tab in the window, and the window observer reported its URL last, so the popped-out header read "newtab".

**Why a failed launch waits for its `open`.** `open` runs unawaited while the host polls for the browser. A `close` issued before the CLI has registered the session closes nothing, and the `open` then brings up a Chromium window nothing tracks. Before the launch had a deadline, its worst case (close, 30 s of polling, an 8 s connect, close) ran past the webview's 40 s wait, so a slow pop-out could finish after the webview had restored the previous renderer (review of #773, 2026-09).

**Why a close runs after the launch in flight and supersedes one queued.** A failed swap's restore reopens the previous provider's session, whose `close` was issued at swap time; a fast failure (no Playwright installed) lands before that close does, so a reopen racing it was closed under the restored pane. A Tool re-run relaunching the `tool.<leafId>` session its last run closed meets the same race. So does a Surface closed while its own launch, relaunch or relaunching attach into the session was in flight: that work closed the session when it landed, after the next launch into the name had opened it, and a close issued before the launch had bound the session registered nothing to wait on. The Tool serving loop that awaited each open never overlapped two launches; its replacement does (review of #775, 2026-09). The webview first also recorded each Surface's work in flight, to close the session again when it landed; the host, which already serialized a browser's launches and closes, now runs a close after the work already running, so a close is sent at once and never repeated. A launch still queued when a close of its browser arrives was sent by a Surface closed meanwhile (a Tool swapped away and back twice): run after that close it would reopen the session nobody shows. The host sees arrival order, which VS Code's message channel keeps but standalone's Tauri commands, run on a worker pool, can swap for two requests sent within the same instant (static reading, 2026-09). So the ordering takes both layers: a named launch waits in the webview for the answer to every close of its session it sent, which no transport can reorder, and the host orders a close after the work in flight and supersedes what is queued. The reverse swap — a Surface's own launch or relaunch reaching the host after its close — would find the close already done and bring a browser up for nobody, a headless one outliving even shutdown; so the close names those requests and the host refuses them when they arrive. Closing only after the work answered, as the webview once did, covers it too, but holds every such close up to 40 s and loses it to a webview reload.

**Why the host keeps operations out of the relaunch gap.** The controller's gate held back only its own Surface's requests, and only while it knew a relaunch was running: a second Surface on the session — a Workspace transfer's destination, the transient double binding — or a request its transport delivered late still reached the daemon mid-relaunch. The host serializes every launch and close, so it is the one place that sees each gap whole (review of the browser stack, 2026-09).

**Why an agent-browser operation needs a live pid file.** A 0.31.1 daemon removes its `.pid`, `.sock` and `.stream` files when it exits cleanly and leaves `<session>.config`: `~/.agent-browser` held 140 `.config` files beside the one live daemon's `.pid` (2026-09-24). So a missing pid file is a gone daemon — or one in a socket directory the host does not share — and any verb run for it starts a daemon at `about:blank`, as `set viewport` did when an unparked pane was resized over a daemon gone while hidden.

**Why one lifecycle for both providers.** The two hosts carried the same policies twice — headed tracking, relaunch generations, the blank-tab sweep, capture joins, the editing scripts — and the copies drifted: an empty copy clobbered the clipboard in one, the capture directory lacked its `chmod` in the other, and only Playwright serialized its closes with its relaunches, so the webview kept its own record of closes in flight for agent-browser (review of the browser stack, 2026-09).

**Why the capture directory is private.** The frame is a picture of the user's authenticated browser, written by an external process under the ambient umask, so a derivable name in the shared temp directory is readable by anything else on the machine for as long as it exists. Precedent: `standalone/sidecar/clipboard-ops.js` applies the same discipline, cleanup included, to clipboard images.

**Why a named launch into a live browser navigates.** A Tool re-announcing — its dev server moved — sends a named launch into the session it already has. Relaunching it stopped the daemon (`close`, then SIGTERM and SIGKILL), so an agent driving that Tool lost its tabs, page state and CDP clients on every move, and a `dor agent-browser` command in flight failed or started a daemon mid-relaunch (review of #777, 2026-09). Only a change of mode needs a new browser.

**Why every capture writes a fresh file, deleted however it ends.** A capture file reused per browser was answered before its reader read it, so a second capture of that browser in the gap — a second pane, or the Display modal beside the loop — rewrote it under the read: a torn or empty frame. A name rotated on close without deleting its file left the user's last page on disk until shutdown (review of #777, 2026-09). The host now reads each frame into memory itself, so nothing waits on disk for a reader; a capture that failed or was killed at 30 s can still have written its file, so the delete does not depend on the read.

**Why every call in a browser's queue is bounded.** A close ran inside the browser's lifecycle queue with no time limit, and agent-browser's `close` queues behind an `open` stalled on a slow page: a hung daemon held the close forever, every later attach, relaunch and pop of that session waited behind it, each webview request gave up at 40 s, and shutdown never settled (review of #777, 2026-09). A launch already bounded its stop by its deadline.

## agent-browser

**Why a pid needs proof before a signal.** A relaunch reads the daemon's pid from `<session>.pid`, which nothing removes: after a reboot, or once that daemon died, the number can belong to any process, and SIGTERM then SIGKILL would reach it (review of #777, 2026-09). A file older than the boot is stale for certain; a live pid beside a stream port that accepts is the daemon as far as its state files can tell.

**Why the sweep closes pages over CDP, not through `tab list`.** `tab list` names only the tabs agent-browser tracks, never the `chrome://newtab/` page a launch leaves, and no verb closes one it does not name. A tracked tab closed over CDP leaves `tab list` too, and later commands still run (0.31.1, 2026-09-24), so one path closes both.

**Why `dor agent-browser` reads the stream port itself.** The host's `attach` reads only the state files, which an older agent-browser does not write and a caller's own `AGENT_BROWSER_SOCKET_DIR` keeps where the host does not look; with either, `dor agent-browser open` opened no pane (review of #777, 2026-09). The command has just made the daemon, so asking it starts none.

## Playwright

**Why one viewport writer.** Chrome keeps one device-metrics override per CDP session. Against playwright-cli 0.1.21 (Chromium 154, 2026-09-24):
- the latest call applies at once;
- a navigation re-applies the later-attached session's override, the host's;
- clearing the host's override leaves the page with no emulation (1280×633) until the next navigation re-applies Playwright's;
- the CLI's `screenshot` re-applies Playwright's own emulation.

The old double write, `setViewportSize` then a host override carrying the ratio, therefore lost its ratio to every agent `screenshot`. It also undid an agent's `resize` on the next navigation: 800×600@1 became 1000×700@2 again. An override alone was replaced outright by `screenshot` (900×600@2 to 1280×720@1). `setViewportSize` alone survived same-site, cross-site and CLI navigation, reload, a tab switch, `screenshot` and `snapshot`, and an agent's `resize` replaced it and stayed. A device's touch and user-agent overrides from the host's session reset cleanly (`userAgent: ''` restores Playwright's own).

**What one writer costs.** Playwright has no API to change a context's ratio after launch, and the CLI reads it only from a config file, which as `--config` would displace the project's own. So a Playwright page renders at 1, and its crisp capture is CSS-resolution. A `clip.scale` capture renders at 2× but left the page at 900×513 afterward.

**Why an identical frame is dropped.** Under Playwright's emulation alone, each `Page.captureScreenshot` over the host's session made Chrome send the last screencast frame again: 20 captures, 20 frames, 1 distinct. With the host's override in place it sent 1. Forwarded, each re-sent frame pulsed the next capture, so a static page captured about 20 times a second and sent nothing (browser-dev harness, 2026-09-24). A page Dormouse never sized looped the same way before.

**Why screencast acks are paced.** Chrome sends the next screencast frame only once the last is acknowledged, and the host acknowledged each on receipt, so the rate was bounded only by how fast Chrome could encode — each frame then JSON-parsed, re-stringified and base64-decoded again in the webview (static reading, 2026-09). Acknowledging no sooner than 50 ms after the last caps it at the ~20 Hz agent-browser's daemon streams at.

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
