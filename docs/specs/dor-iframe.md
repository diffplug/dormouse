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

> Status: **works for loopback dev servers** (implemented on the VS Code host).
> Arbitrary web browsing is still better served by the **agent-browser** surface
> (`dor ab`, see [dor-agent-browser.md](dor-agent-browser.md)): the iframe surface
> proxies `http://` upstreams (loopback dev servers are overwhelmingly plain
> http), defers `https://`, and routes a remote that refuses framing to an error
> page pointing at `dor ab`.

## The CLI → surface

`dor iframe <url>` (`dor/src/commands/iframe.ts`) sends a `surface.iframe` control
request; `parseIframeUrl` constrains inputs to absolute `http://`/`https://`
(Dormouse does not infer schemes). Placement follows the shared content-surface
rule (`lib/src/components/Wall.tsx` → `createContentSurface`): an untouched
terminal caller is replaced in place, anything else gets a split next to the
caller.

`IframePanel.tsx` then asks the host to front the target with its proxy
(`getPlatform().createIframeProxyUrl`) and frames the returned loopback URL. If
the host has no proxy it falls back to a raw `<iframe src={url}>`; if the target
isn't proxyable (e.g. an `https://` URL) it shows an actionable message instead.

## The Transparent Proxy (Instrumented Iframe)

This is the **substrate** the surface is built on. Instead of pointing the
`<iframe>` at the target, Dormouse points it at a loopback proxy
(`vscode-ext/src/iframe-proxy-host.ts`) that fetches the target and serves it
back. The moment Dormouse serves the bytes, two things become possible that the
raw iframe cannot do:

1. **Inject a keyboard side-channel** so Dormouse's global leader chord keeps
   working inside the frame (the technique VS Code uses for its own webviews).
2. **See the upstream result**, so a refused-to-be-framed page or a dead server
   becomes a clear error page instead of a blank pane.

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
- **WebSocket passthrough.** Upgrades are forwarded as a raw byte pipe once the
  upgrade head is rewritten (`Host`/`Origin` → upstream), exactly like the stream
  relay.
- **Anti-framebust.** The `<iframe>` uses a `sandbox` without
  `allow-top-navigation`, so a tool's `if (top !== self) top.location = …` cannot
  navigate the Wall away.

### The keyboard side-channel (resolves #1)

A fixed, Dormouse-owned script — like agent-browser's `EDIT_SCRIPTS`, never
user-supplied, so it is not an eval vector — injected inline before `</head>`. It
reclaims **only** the reserved leader chord (dual-tap ⌘ / ⇧, the same detection as
`handle-dual-tap.ts`) and `postMessage`s it to the parent; **every other keystroke
flows to the tool untouched**. The embedded tool (a code editor, a VS-Code-web
workbench) keeps full keyboard interactivity; Dormouse keeps its one global chord.

The Wall already owns a capturing `window` keydown listener
(`use-wall-keyboard.ts`); it gains a `message` listener that validates
`event.origin` against the live proxy grants (`lib/src/lib/iframe-proxy-registry.ts`)
and feeds the forwarded chord into the same dispatch the in-document dual-tap
would (`exitTerminalMode`) — no synthesized `KeyboardEvent` round-trip.

> Deviation from the original sketch: the shim forwards **only** the leader, not
> `focus`/`blur`. The focus model below needs no message channel.

### Accurate focus model (resolves #2 and #3)

- **#2** — focusing one of our iframes fires `blur` on the parent `window` even
  though the app isn't backgrounded; the focused element is just an `<iframe>`
  *inside* our document, so `document.hasFocus()` stays **true**.
  `use-window-focused.ts` and Wall's blur handler read it instead of blindly going
  inactive, so headers/attention stay live when an iframe takes focus.
- **#3** — `IframePanel` registers a focus handle (`registerSurfaceFocusHandle` in
  `terminal-lifecycle.ts`) so `focusSession` focuses the frame element like any
  other surface. And because clicking *into* a cross-origin frame doesn't bubble a
  `mousedown` to the pane, `IframePanel` adopts "the frame took focus" (window
  `blur` while our iframe is `document.activeElement` and the app still has focus)
  as entering the pane — so mode/selection stay consistent and the leader chord
  round-trips back out.

### Real error signals (resolves #4)

With the proxy, **Dormouse is the server**, so it diagnoses lazily and serves a
precise error *page* from the proxy origin (which frames fine): a refused remote →
"`<host>` refuses to be embedded; `dor ab open <url>`"; a dead upstream → "nothing
responding at `localhost:8080` — is the dev server running?". `createIframeProxyUrl`
itself returns `{ ok: false, reason }` only for the synchronous cases (chiefly an
unproxyable `scheme`); reachability and frame-refusal are surfaced as served
pages.

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

VS Code implements it in the extension host (`iframe-proxy-host.ts`), routed via
`message-router.ts` / `message-types.ts` and the `vscode-adapter.ts` request/
response pair. **The proxy is needed on every host** — even where a Tauri webview
could frame `http://127.0.0.1` directly for origin reasons, injection still
requires controlling the bytes — unlike the agent-browser relay, which was a
VS-Code-only origin fix. Hosts with no process to run one (the web host) omit the
method and the panel falls back to a raw, uninstrumented `<iframe>`.

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
- **Streaming SSR is buffered.** The proxy buffers an HTML response fully before
  injecting the shim, adding latency for streamed responses.
- **No teardown-on-kill hook yet.** A killed iframe surface's proxy server is
  reaped by the idle sweep, not immediately on kill. (The shared teardown hook is
  tracked under Path 2 below.)

---

# Future Work

> Designed, not yet built. Everything above is implemented; everything below is
> the roadmap. Both paths reuse the proxy + shim substrate unchanged.

## Render Backends: Two Axes

With the proxy in place, "view a web thing in a pane" factors into two
**independent axes**, and the agent-browser and iframe surfaces are just cells in
the grid:

| | **Target: just a URL** | **Target: a backend Dormouse spawns & owns** |
| --- | --- | --- |
| **Render: screencast** (agent-browser) | `dor ab open <url>` — today | (possible, rarely wanted) |
| **Render: embed** (proxy + shim iframe) | `dor iframe <localhost>` — today | **the plugin system (Path 2)** |

- **Render axis** = *how* you see it. `screencast` (real Chromium, agent-drivable,
  any URL, laggy) vs `embed` (the page's own DOM, zero-lag, loopback-only, not
  agent-drivable).
- **Target axis** = *what* you point at. A bare URL, vs. a URL whose backend
  process Dormouse spawns and reaps.

The shim and proxy live **entirely in the `embed` render backend**, which is why
both paths below reuse them unchanged — they differ only in which other axis they
exercise.

## Path 1 — Swappable Render Backend

Expose the **render axis** as a per-pane choice: same target, switch screencast ↔
embed. This is the hedge on the agent-browser bet — if the screencast's lag is
unacceptable for a local dev server, one gesture swaps it to the zero-lag embed.

**Do not fuse the surfaces into a dual-mode mega-component.** `AgentBrowserPanel`
is already large and the input models differ fundamentally (CDP `input_*` messages
vs native DOM). Instead, make the swap a **layout operation: replace the pane's
renderer in place, preserving the target.** `createContentSurface` already replaces
an untouched terminal in its slot — generalize that to "replace surface X with
surface Y at the same dock position," triggered by a header affordance ("open in
iframe" / "open in browser").

## Path 2 — Plugin System

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
