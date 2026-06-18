# Dor Iframe Surface

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary,
> `docs/specs/dor-cli.md` for the shared `dor` CLI, surface handle model, and
> host control plumbing this surface builds on, and
> `docs/specs/dor-agent-browser.md` for the sibling browser surface.

`dor iframe <url>` opens an absolute `http(s)` URL in a high-fidelity `<iframe>`
surface for human inspection. The iframe renders the page's **own DOM** directly
— zero-lag and pixel-perfect — but in a **separate browsing context** that the
browser, not Dormouse, drives.

The surface no longer points the `<iframe>` at the target directly. It fronts the
target with a **host-owned transparent proxy**: Dormouse serves the bytes, so it
controls them. That converts the iframe from a blind embedder into
Dormouse-served content, which is the one capability the raw iframe lacked — and
from it the surface gains a keyboard side-channel for its global leader chord, an
accurate focus model, and real error pages.

> Status: **works for loopback dev servers** in hosts that can run the shared
> Node proxy (VS Code extension host and standalone/Tauri sidecar). Arbitrary
> web browsing is still better served by the **agent-browser** surface (`dor ab`,
> see [dor-agent-browser.md](dor-agent-browser.md)): the iframe surface proxies
> `http://` upstreams (loopback dev servers are overwhelmingly plain http),
> defers `https://`, and routes a remote that refuses framing to an error page
> pointing at `dor ab`.

## The CLI → surface

`dor iframe <url>` (`dor/src/commands/iframe.ts`) sends a control request;
`parseIframeUrl` constrains inputs to absolute `http://`/`https://` (Dormouse does
not infer schemes). Placement follows the shared content-surface rule
(`lib/src/components/Wall.tsx` → `createContentSurface`): an untouched terminal
caller is replaced in place, anything else gets a split next to the caller.

It opens a **`browser` surface with `renderMode: 'iframe'`** — a full
browser-chrome tab (URL bar, back/forward, dev-server chip, render chip),
identical chrome to `dor ab`, differing only in the rendered content (see
"Render Backends: Two Axes" below). It is not a lesser "iframe-only" surface.

`IframePanel.tsx` then asks the host to front the target with its proxy
(`getPlatform().createIframeProxyUrl`) and frames the returned loopback URL. If
the host has no proxy it falls back to a raw `<iframe src={url}>`; if the target
isn't proxyable (e.g. an `https://` URL) it shows an actionable message instead.

## The Transparent Proxy (Instrumented Iframe)

This is the **substrate** the surface is built on. Instead of pointing the
`<iframe>` at the target, Dormouse points it at a loopback proxy
(`lib/src/host/iframe-proxy.ts`) that fetches the target and serves it back. The
moment Dormouse serves the bytes, two things become possible that the raw iframe
cannot do:

1. **Inject a keyboard side-channel** so Dormouse's global leader chord keeps
   working inside the frame (the technique VS Code uses for its own webviews).
2. **See the upstream result**, so a refused-to-be-framed page or a dead server
   becomes a clear error page instead of a blank pane.
3. **Report the frame's current location**, so Dormouse's browser chrome stays
   aligned with same-frame iframe navigation.

### The one load-bearing fact

Same-origin policy blocks the **parent from reaching into the child**
(`iframe.contentDocument` throws cross-origin). It does **not** block the **child
from posting to the parent** — `window.parent.postMessage()` is cross-origin-safe
by design. Dormouse can never reach *in*, but a script *we put in the served HTML*
can always call out. The only capability we need is control over the served
bytes, which the proxy gives us. This is exactly how VS Code instruments its
plugin webviews — serve HTML from an origin you own, inject a bootstrap — not a
new technique, the proven one.

### Target policy: loopback instruments, remote diagnoses

| Target | Proxy behavior |
| --- | --- |
| **Loopback** (`localhost`/`127.0.0.1`/`[::1]`) http | Full instrument: strip `X-Frame-Options`, drop the page CSP, inject the shim, serve. The user spawned it; framing is the intent. |
| **Remote** http, frameable | Best-effort render with the injected shim (flagged that `dor ab` is the better tool for arbitrary browsing). A CSP `frame-ancestors *` is considered frameable; scoped sources such as `https://*.example.com` are restrictive. |
| **Remote** http, refuses framing | **Never force-framed.** Serve a Dormouse error page with a one-click hint to `dor ab open <url>`. |
| **Unreachable** (conn refused, DNS, non-2xx) | Serve a Dormouse error page ("is the dev server running?"). |
| **`https://`** | Deferred. The panel reports `scheme` and points at `dor ab`. |

We do **not** force-frame a site that refuses embedding: rewriting authenticated
cross-origin pages is an auth/cookie/ToS dead end, and that's what the
agent-browser surface is for. v1 proxies `http://` upstreams plus WebSocket
upgrades; `https://` is deferred.

### Proxy mechanism

Modeled on the agent-browser **stream relay**
(`vscode-ext/src/agent-browser-host.ts`) — already a loopback-only, single-purpose
forwarder. The difference: this proxy speaks **HTTP** (it parses and rewrites
responses) and passes through **WebSocket upgrades** (dev-server HMR,
openvscode-server's connection).

Source of truth: `lib/src/host/iframe-proxy.ts` owns the shared HTTP/WebSocket
server, while `lib/src/host/iframe-proxy-rewrite.ts` owns the dependency-free
policy, HTML instrumentation, framing checks, and served error pages.

- **Per-grant dedicated loopback server.** Each grant gets its own ephemeral
  `http.Server` bound to `127.0.0.1:0`, fronting exactly **one** fixed upstream.
  The grant's *origin* is the grant. Two consequences, and they are deliberate
  departures from the original "single shared port + `…/<token>/<path>`" sketch:
  - Root-relative sub-resources (`/assets/x.js`) and absolute paths resolve and
    proxy **transparently with zero body rewriting** — a shared origin can't do
    this without rewriting (the old Open Decision #2).
  - **No token in the URL.** A path-prefix token would land in
    `location.pathname`, and a client-side router (a React-Router/Remix dev
    server) would match no route and render its own 404. A server bound to a
    single upstream is inherently not an open forwarder, so the token bought
    nothing here that the dedicated server doesn't already provide.

  Grants use a sliding idle TTL with a lazy sweep (a live iframe refreshes on
  every request; an idle grant's server is closed), plus a hard cap.
- **Response rewriting.** For `text/html` from a frameable upstream: strip
  `X-Frame-Options`, drop the page CSP (response header **and** any
  `<meta http-equiv>`), inject the shim before `</head>`. `Host`/`Origin`/`Referer`
  are rewritten to the upstream so origin-aware servers (`Vary: Origin`, CSRF
  checks) see a same-origin request, and a `Location` redirect back to the
  upstream origin is rewritten to the proxy origin so it doesn't bounce the frame
  off-proxy. Non-HTML passes through (framing/hop-by-hop headers still stripped).
  The initial framed proxy URL preserves the target's path, query, and fragment;
  the fragment remains browser-only and is not sent on upstream HTTP requests.
  HTML injection streams: the proxy buffers only until `</head>`, `<body>`, or a
  bounded prefix cap, instruments that prefix, then pipes the rest of the
  upstream response through without waiting for the full document.
- **WebSocket passthrough.** Upgrades are forwarded as a raw byte pipe once the
  upgrade head is rewritten (`Host`/`Origin` → upstream), exactly like the stream
  relay.
- **Anti-framebust.** The `<iframe>` uses a `sandbox` without
  `allow-top-navigation`, so a tool's `if (top !== self) top.location = …` cannot
  navigate the Wall away.

### The iframe shim message channel (resolves #1 and proxied click adoption)

A fixed, Dormouse-owned script — like agent-browser's `EDIT_SCRIPTS`, never
user-supplied, so it is not an eval vector — injected inline before `</head>`.
It posts only Dormouse-owned control messages to the parent:

- `leader`: the reserved leader chord (dual-tap ⌘ / ⇧, the same detection as
  `handle-dual-tap.ts`).
- `pointerdown`: genuine user pointerdown inside the cross-origin frame, so the
  panel can adopt the click as pane selection + passthrough entry.
- `location`: the proxied frame URL after `pushState`/`replaceState`,
  `popstate`, `hashchange`, page show/load, and before same-frame anchor
  navigation. `IframePanel` maps that proxy-origin URL back to the upstream URL
  before updating iframe chrome and Back/Forward history. It does **not** write
  pane params or re-resolve the iframe source; in-frame client-side navigation
  must not become a full page reload.

Every other keystroke and pointer event flows to the tool untouched. The
embedded tool (a code editor, a VS-Code-web workbench) keeps full keyboard
interactivity; Dormouse keeps its one global chord and a click-adoption signal.

The Wall already owns a capturing `window` keydown listener
(`use-wall-keyboard.ts`); it gains a `message` listener that validates
`event.origin` against the live proxy grants (`lib/src/lib/iframe-proxy-registry.ts`)
and feeds the forwarded chord into the same dispatch the in-document dual-tap
would (`exitTerminalMode`) — no synthesized `KeyboardEvent` round-trip. The
iframe panel separately listens for the same validated proxy origin and treats a
`pointerdown` message as `onClickPanel(api.id)` and a `location` message as a
browser-history update for iframe chrome.

### Accurate focus model (resolves #2 and #3)

- **#2** — focusing one of our iframes fires `blur` on the parent `window` even
  though the app isn't backgrounded; the focused element is just an `<iframe>`
  *inside* our document, so `document.hasFocus()` stays **true**.
  `use-window-focused.ts` and Wall's blur handler read it instead of blindly going
  inactive, so headers/attention stay live when an iframe takes focus.
- **#3** — `IframePanel` registers a focus handle (`registerSurfaceFocusHandle` in
  `terminal-lifecycle.ts`) so `focusSession` focuses the frame element like any
  other surface. Because clicking *into* a cross-origin frame doesn't bubble a
  `mousedown` to the pane, proxied frames adopt the shim's validated
  `pointerdown` message as entering the pane. The raw fallback has no shim, so it
  preserves the older focus heuristic: window `blur` while our iframe is
  `document.activeElement` and the app still has focus. Both paths keep
  mode/selection consistent when the frame owns focus.

### Real error signals (resolves #4)

With the proxy, **Dormouse is the server**, so it diagnoses lazily and serves a
precise error *page* from the proxy origin (which frames fine): a refused remote →
"`<host>` refuses to be embedded; `dor ab open <url>`"; a dead upstream → "nothing
responding at `localhost:8080` — is the dev server running?". `createIframeProxyUrl`
itself returns `{ ok: false, reason }` only for the synchronous cases (chiefly an
unproxyable `scheme`); reachability and frame-refusal are surfaced as served
pages. These served error pages include the same fixed leader shim as proxied
HTML, so the keyboard escape path still works after the user clicks inside an
error state.

### Cursor alignment (the out-of-process-frame offset)

A cross-origin iframe is an **out-of-process frame**; Chromium maps pointer events
to it relative to its nearest compositing/containing ancestor. Dockview's root
(`.dv-dockview`) sets `contain: layout`, so without intervention clicks land offset
by the pane's distance from that root (hundreds of px for a split pane).
`IframePanel` gives the iframe's **immediate container** its own identity layer
(`transform: translateZ(0)`), co-located with the frame, so it becomes the nearest
reference and the offset collapses to ~0. It's an identity transform, so
`getBoundingClientRect` (overlay measurement) is unaffected. Same-origin surfaces
(xterm, the agent-browser canvas) are immune — they recompute from
`getBoundingClientRect`, which a cross-origin frame can't.

### Host capability and CSP

A new optional `PlatformAdapter` method mirroring `getAgentBrowserStreamUrl`
(`lib/src/lib/platform/types.ts`), so hosts degrade gracefully:

```ts
createIframeProxyUrl?(targetUrl: string): Promise<
  | { ok: true; url: string }
  | { ok: false; reason: 'frame-refused' | 'unreachable' | 'scheme'; detail?: string }
>;
```

VS Code implements it in the extension host (`vscode-ext/src/iframe-proxy-host.ts`),
routed via `message-router.ts` / `message-types.ts` and the `vscode-adapter.ts`
request/response pair. Standalone implements the same adapter method through
`standalone/src/tauri-adapter.ts` → `iframe_create_proxy_url` in
`standalone/src-tauri/src/lib.rs` → the sidecar's `iframe:createProxyUrl` command,
which loads the bundled shared proxy. **The proxy is needed on every host** —
even where a Tauri webview could frame `http://127.0.0.1` directly for origin
reasons, injection still requires controlling the bytes. Hosts with no process
to run one (the web host) omit the method and the panel falls back to a raw,
uninstrumented `<iframe>`.

With the proxy, the VS Code webview CSP (`vscode-ext/src/webview-html.ts`) narrows
from the old broad `frame-src http: https:` to the loopback proxy origin only:

```
frame-src http://127.0.0.1:* http://localhost:*
```

### Security model

The same fences as the stream relay: loopback-only bind both sides; a per-surface
grant served by a dedicated **single-upstream** server (no open forwarder); the
injected shim is fixed and Dormouse-owned (no user script ever reaches the page);
header-stripping never force-frames a third-party site (a refusing remote is
diverted to an error page, not stripped). For CSP, only a standalone
`frame-ancestors *` is permissive; wildcard host patterns remain restrictive.
**SSRF:** the proxy fetches a user-supplied URL, so it refuses link-local /
cloud-metadata ranges
(`169.254.0.0/16`, `fe80::/10`) and trusts other ranges — the trust boundary is the
user's own `dor iframe <url>`.

## Remaining limitations

### Inherent (designed around, not patchable)

- **Focus still leaves Dormouse for the tool's own keys.** The shim reclaims only
  the leader chord; every other keystroke fires in the frame's document and never
  reaches the Wall's `window` listener — *by design*, so the embedded tool keeps
  full keyboard interactivity. The same-origin policy means the parent can't
  observe those keys; the leader is the one chord we round-trip.

### Known v1 gaps

- **`https://` upstreams are deferred** — the panel shows a `scheme` message with a
  `dor ab` hint.
- **Absolute-origin sub-resources bypass the proxy.** The dedicated-port origin
  makes root-relative URLs proxy transparently, but a dev server that emits
  absolute `http://localhost:5173/…` (notably Vite's HMR `ws://localhost:5173/…`)
  connects straight to the upstream — uninstrumented, though harmless for loopback
  since the browser can reach it.
- **No teardown-on-kill hook yet.** A killed iframe surface's proxy server is
  reaped by the idle sweep, not immediately on kill. (The shared teardown hook is
  tracked under Path 2 below.)

---

# Render Backends: Two Axes

> **Path 1 (the swap) is migrating to the unified `browser`-surface model below;
> Path 2 (the plugin system) is the remaining roadmap.** Both reuse the proxy +
> shim substrate unchanged.

With the proxy in place, "view a web thing in a pane" factors into two
**independent axes**. There is exactly one content surface — **`surfaceType:
'browser'`** — and these axes are its parameters, not separate surface types:

| | **Target: just a URL** | **Target: a backend Dormouse spawns & owns** |
| --- | --- | --- |
| **Render: `ab-screencast` / `ab-popout`** | `dor ab open <url>` — today | (possible, rarely wanted) |
| **Render: `iframe`** (proxy + shim iframe) | `dor iframe <localhost>` — today | **the plugin system (Path 2)** |

- **Render axis** = *how* you see it, the pane's `renderMode`. The agent-browser
  engine offers two (`ab-screencast` — real Chromium to a canvas, agent-drivable,
  any URL, laggy; `ab-popout` — the same session relaunched headed as an OS
  window); `iframe` is the engine-less DOM embed (the page's own DOM, zero-lag,
  loopback-only, not agent-drivable). The `ab-` prefix names the *engine*, leaving
  room for a future engine (`xyz-screencast`) beside it; `iframe` carries no
  engine.
- **Target axis** = *what* you point at. A bare URL, vs. a URL whose backend
  process Dormouse spawns and reaps.

The shim and proxy live **entirely in the `iframe` render backend**, which is why
both paths below reuse them unchanged — they differ only in which other axis they
exercise.

## Path 1 — One `browser` surface, swappable renderer

> Status: **migrating to the unified model below.** The swap mechanism is
> implemented (lib + the VS Code and standalone hosts) and is triggered from the
> **Display modal** (the far-left header chip), whose *Render* section offers
> `ab-screencast`, `ab-popout` (see dor-agent-browser.md → Headed Pop-Out), and
> `iframe`. The migration replaces the previous "two surface types, swap by
> destroy-and-recreate" implementation — whose transitions lost the URL and the
> selected mode — with the single-surface, canonical-state model here.

A browser pane is **one surface with a swappable renderer**, not three surface
types. The render axis is a per-pane choice: same target, switch
`ab-screencast` ↔ `ab-popout` ↔ `iframe`. This is the hedge on the agent-browser
bet — if the screencast's lag is unacceptable for a local dev server, one gesture
swaps it to the zero-lag iframe.

### Canonical pane state (the single source of truth)

Two things are persisted in the dockview **panel params** and are authoritative
for *every* renderer — this is what makes a swap preserve "where you were" and
"how you were looking at it":

```ts
// surfaceType: 'browser'
type BrowserPaneState = {
  url: string;                                      // the target — every renderer reads & writes it
  renderMode: 'ab-screencast' | 'ab-popout' | 'iframe';
  agentBrowser?: {                                  // engine state, present iff renderMode starts with `ab-`
    session: string; wsPort?: number; binaryPath?: string; syncEngaged?: boolean;
  };
};
```

- **`url` is single-homed.** The iframe renderer already round-trips `params.url`;
  the agent-browser renderer must do the same — write the active tab's URL back to
  `params.url` whenever its chrome snapshot changes, and seed the param from the
  `dor ab open <url>` that created it. Every transition then reads `params.url`,
  **never** a live stream snapshot that can be empty mid-relaunch. This is the fix
  for the previous class of swap bugs (blank-page swaps, `about:blank`
  auto-revert): the URL had no canonical home for agent-browser and was laundered
  from whatever happened to be live at the instant of the swap.
- **`renderMode` is one field**, not a `(surfaceType, poppedOut)` tuple split
  across two representations. Restore seeds straight from it. Invariant:
  `renderMode`'s engine prefix ⇔ the matching `agentBrowser` sub-state is present.

### One shell, two renderer children (not a fused component)

`AgentBrowserPanel` and `IframePanel` are **not** fused into a dual-mode
mega-component — their input models differ fundamentally (CDP `input_*` messages
vs native DOM). Instead a thin **`BrowserPanel` shell** owns `url` + `renderMode`,
registers the screen controller (so the browser chrome is present in *every* mode,
unconditionally — this is why `dor iframe` is a full browser-chrome tab), and
conditionally mounts the matching renderer **child** (`AgentBrowserContent` /
`IframeContent`). Switching mode updates the shell's state + params and remounts
only the child; the shell, the chrome, and the URL survive. The two renderers stay
separate components, so the anti-fusion constraint holds while the chrome and
target unify above them.

### Render-mode transitions

| From → To | Behavior |
| --- | --- |
| `iframe` → `ab-screencast` / `ab-popout` | **Trivial.** One frame → spawn an agent-browser session at `params.url` = one tab; no loss. Host-gated on `agentBrowserOpen` (the webview can't resolve/run the binary); the Wall caches the last `dor ab` `binaryPath` to spawn with. Absent ⇒ the swap option is hidden (e.g. the web host). |
| `ab-screencast` ↔ `ab-popout` | Same session, relaunch headed/headless. **Silently drops all but the active tab** — accepted limitation pending profile persistence (dor-agent-browser.md → Future work). No warning. |
| `ab-screencast` / `ab-popout` → `iframe` | If the session has **1 tab**, swap directly. If it has **≥2 tabs**, the agent-browser renderer (which owns the live tab list — the chrome snapshot carries only the active tab) shows a **warning that only the active tab transitions and the rest are closed, gated behind a typed-character confirm** (the gesture the original pop-out design reserved). On confirm, close the session and mount the iframe renderer at `params.url`. |

Because `url` and `renderMode` are canonical params, a swap is no longer a fragile
`replaceSurface` that hand-assembles state per direction; it is a renderer remount
inside a shell that already holds both. URL edits and Back/Forward update
`params.url` and (for the iframe renderer) re-resolve the proxy; shim `location`
reports from in-frame navigation update only the displayed URL and the panel's
small parent-side history. Reload explicitly re-resolves the proxy.

### New tab from the iframe renderer → new pane

The iframe renderer is a single frame with no tab model, but pages do try to open
new tabs (`target=_blank`, `window.open`). Today the shim **ignores** them — its
click handler bails on any non-`_self` target (`iframe-proxy-rewrite.ts`) and
`window.open` is untouched — so the attempt is silently dropped, which is poor.
Because Dormouse owns the served bytes, the shim can intercept instead: it already
posts Dormouse-owned `leader` / `pointerdown` / `location` messages to the parent,
so add an **`open-window`** message (from intercepted `target=_blank` clicks and a
`window.open` override) carrying the target URL.

`IframePanel`'s existing origin-validated `message` listener handles `open-window`
by **prompting the user**, and on accept opens the URL as a **new `browser` pane**
(split beside the current one). This is the renderer-symmetric model:
**agent-browser holds many tabs inside one pane (the tab strip); the iframe
renderer spreads them across panes.** Two honest limits, surfaced in the prompt
rather than hidden:

- **Proxied mode only.** The raw-iframe fallback (no proxy, e.g. the web host) has
  no shim to intercept with, so popups there stay at the webview's mercy.
- **Opener-coupled popups don't survive a new pane.** OAuth / payment flows that
  `postMessage` back to `window.opener` break across a separate browsing context +
  proxy origin. Those are exactly what agent-browser's real tabs handle natively,
  so the prompt also offers **"switch this pane to `ab-screencast`"** for
  popup-heavy pages — turning a silent dead-end into an informed choice.

## Path 2 — Plugin System

> Status: **not yet built** — the remaining roadmap item.

Extend the **target axis** with process ownership: Dormouse spawns the plugin's
backend (an HTML editor, `openvscode-server` / `code serve-web`, any local tool)
and renders it through the same `embed` backend. The rendering is solved by the
proxy; what Path 2 adds is a **process supervisor** — spawn (in what cwd/env?
per-workspace or per-pane? reuse across panes?), allocate/health-check the port,
wire the proxy to it, and **reap the process when the pane is killed.**

That last requirement is the second consumer that justifies generalizing the
per-surface **teardown-on-kill hook** — the one-off `agent-browser` close currently
special-cased in `Wall.tsx`'s `killPaneImmediately` (see
[dor-agent-browser.md](dor-agent-browser.md) → Lifecycle), and the same hook the
iframe proxy server would use to close immediately instead of waiting for the idle
sweep.

**Risk specific to the motivating example (code-server / openvscode-server):** it
will stress the substrate more than a Vite dev server — worth a spike before
committing. It needs a broader `sandbox` (`allow-same-origin allow-scripts
allow-forms allow-popups allow-downloads allow-modals`, still omitting
`allow-top-navigation`); may want COOP/COEP for cross-origin isolation
(SharedArrayBuffer) — verify against the actual target; and leans on WebSocket
passthrough harder than most.

## Decisions made in v1

1. **Remote frameable targets** → render best-effort with the leader shim
   (loopback fully instrumented; a remote that refuses → error page). Keeps a crisp
   "loopback = full instrument, remote = best-effort, refusing = `dor ab`" line.
2. **Absolute-origin sub-resources** → left as a known gap. The dedicated-port
   origin solves root-relative URLs for free; absolute upstream URLs bypass the
   proxy rather than rewriting response bodies.
3. **SSRF range-blocking** → refuse link-local/metadata, trust other ranges (the
   command is the user's own).
4. **Web host** → keep the blind raw-iframe fallback rather than hiding the
   surface.
