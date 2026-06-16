# Dor Iframe Surface

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary,
> `docs/specs/dor-cli.md` for the shared `dor` CLI, surface handle model, and
> host control plumbing this surface builds on, and
> `docs/specs/dor-agent-browser.md` for the sibling browser surface.

`dor iframe <url>` opens an absolute `http(s)` URL in a high-fidelity `<iframe>`
surface for human inspection. Unlike the agent-browser surface (a screencast of a
real Chromium), the iframe renders the page's **own DOM** directly — zero-lag and
pixel-perfect — but as a **separate browsing context** that Dormouse neither
controls nor can observe.

> Status: **provisional.** The surface works for displaying a page, but has
> structural limitations (below) that keep it from being usable for real
> interaction today. Two things follow from that: arbitrary web browsing is
> served by the **agent-browser** surface instead (`dor ab`, see
> [dor-agent-browser.md](dor-agent-browser.md)), and the iframe's own path
> forward is the **transparent proxy** in Future Work below, which converts it
> from a blind embedder into Dormouse-served content and resolves four of the
> five limitations. Do not build features on top of the raw iframe surface until
> that lands.

## The Current Surface

`dor iframe <url>` (`dor/src/commands/iframe.ts`) sends a `surface.iframe` control
request; `parseIframeUrl` constrains inputs to absolute `http://`/`https://`
(Dormouse does not infer schemes). Placement follows the shared content-surface
rule (`lib/src/components/Wall.tsx` → `createContentSurface`): an untouched
terminal caller is replaced in place, anything else gets a split next to the
caller.

`IframePanel.tsx` renders a bare `<iframe src={url}>`. Because a cross-origin
frame reports no load result, the panel can only show a **blind 5-second stall
hint** ("if it stays blank, the server may be down, on a different scheme, or
refusing to be embedded") — it cannot actually distinguish those cases.

## Structural Limitations

An `<iframe>` pointed at an arbitrary URL is a **separate browsing context** from
the Wall. Dormouse's input, focus, and attention model assumes a single
same-document context, so the iframe surface conflicts with it. Some conflicts
are **inherent to the browser** (only designable-around, never patchable); others
are **fixable but not yet done**.

### Inherent

- **Focus leaves Dormouse entirely.** When the iframe gains focus, a focused
  cross-origin frame owns the keyboard. Its keystrokes fire in *its* document and
  never reach the parent. Dormouse's global shortcuts are a capturing `window`
  keydown listener (`lib/src/components/wall/use-wall-keyboard.ts`), so
  dual-tap-⌘, pane navigation, split, and kill all go dead until focus returns to
  the Wall. The same-origin policy means the parent cannot observe or intercept
  those keys — this cannot be fixed, only designed around (a click-to-interact
  overlay, or an accept-focus model with a mouse-driven escape).

- **Some sites refuse to be framed, with no error signal.** Servers that send
  `X-Frame-Options` or a CSP `frame-ancestors` directive cannot be embedded at
  all, yielding a blank pane. Cross-origin frames do not report load errors to the
  embedder (`onError` never fires; `onLoad` fires even for a blocked frame), so
  the surface cannot reliably distinguish "loading", "blocked", and "broken". The
  current `IframePanel` shows a best-effort stall hint after a timeout only.

### Fixable but not yet done

- **The app reads iframe-focus as being backgrounded.** Focusing the iframe fires
  a `blur` on the parent `window`. Current handlers treat that as the whole app
  losing focus: `Wall.tsx` clears cross-session attention, and
  `use-window-focused.ts` flips `windowFocused` to `false` (it is naïve —
  `onBlur = () => setFocused(false)`), which drives active styling (e.g.
  `SurfacePaneHeader.tsx`'s `isActiveHeader`). The result is every
  header/focus-ring goes inactive and attention clears the instant the iframe is
  focused. The fix is to distinguish `document.activeElement` being one of our own
  iframes from a real window blur.

- **No programmatic focus handle.** `focusSession`
  (`lib/src/lib/terminal-lifecycle.ts`) only knows xterm terminals in a registry.
  The iframe pane is not registered, so
  `onClickPanel → enterTerminalMode → focusSession(iframeId)` is a no-op: Dormouse
  cannot focus the iframe programmatically and cannot tell when it is focused.

### Host config

- **The VS Code webview must opt into framing.** The webview CSP
  (`vscode-ext/src/webview-html.ts`) is `default-src 'none'`; without a `frame-src`
  directive every `<iframe>` is blocked outright (blank white pane). Today a broad
  `frame-src http: https:` allowance is required for the surface to render at all
  (narrowed by the proxy below).

---

# Future Work

> Designed, not yet built. Everything above describes the surface as it exists
> today; everything below is the roadmap.

The through-line: an `<iframe>` is only crippled when it points at a foreign
context. Put a **host-owned transparent proxy** in front of it and Dormouse
becomes the server — it controls the bytes, which is the one thing the raw iframe
lacks. From there the surface gains a keyboard side-channel, an accurate focus
model, and real error signals; and it becomes one render backend in a small
family shared with agent-browser.

## The Transparent Proxy (Instrumented Iframe)

This is the **substrate** under everything else here. Instead of pointing the
`<iframe>` at the target, Dormouse points it at a loopback proxy that fetches the
target and serves it back. The moment Dormouse serves the bytes, two things become
possible that the raw iframe cannot do — and together they resolve limitations
#1–#4 above:

1. **Inject a keyboard side-channel** so Dormouse's global chords keep working
   inside the frame (the technique VS Code uses for its own webviews).
2. **See the upstream result**, so a refused-to-be-framed page or a dead server
   becomes a clear error instead of a blank pane.

### The one load-bearing fact

Same-origin policy blocks the **parent from reaching into the child**
(`iframe.contentDocument` throws cross-origin). It does **not** block the **child
from posting to the parent** — `window.parent.postMessage()` is cross-origin-safe
by design. Dormouse can never reach *in*, but a script *we put in the served HTML*
can always call out. The only capability we need is control over the served
bytes, which the proxy gives us. This is exactly how VS Code instruments its
plugin webviews — serve HTML from an origin you own, inject a bootstrap that
forwards keydowns — not a new technique, the proven one.

### Target policy: loopback instruments, remote diagnoses

The policy hinges on **loopback vs remote**, because only loopback targets are
"the user's own tools" where forcing framing and stripping headers is safe and
intended.

| Target | Frame-blocking headers | Proxy behavior |
| --- | --- | --- |
| **Loopback** (`localhost`/`127.0.0.1`/`[::1]`) | stripped | Full instrument: relax CSP, drop `X-Frame-Options`/`frame-ancestors`, inject shim, serve. The user spawned it; framing is the intent. |
| **Remote**, frameable | honored | Best-effort render with the leader shim, flagged that `dor ab` is the better tool. *(Open decision — may degrade to error-only.)* |
| **Remote**, refuses framing | honored | **Do not strip.** Serve a Dormouse error page explaining why, with a one-click hint to `dor ab open <url>`. |
| **Unreachable** (conn refused, DNS, non-2xx) | — | Serve a Dormouse error page ("is the dev server running?"). |

We do **not** force-frame third-party sites: rewriting authenticated
cross-origin pages through a proxy is an auth/cookie/ToS dead end, and that's
what the agent-browser surface is for. v1 proxies `http://` upstreams (loopback
dev servers are overwhelmingly plain http) plus WebSocket upgrades; `https://`
upstreams are deferred.

### The keyboard side-channel (resolves #1)

A fixed, Dormouse-owned script — like agent-browser's `EDIT_SCRIPTS`, never
user-supplied, so it is not an eval vector — injected before `</head>`:

```js
// Reclaim ONLY Dormouse's reserved leader chord; everything else flows to the
// tool untouched. The tool keeps full keyboard interactivity; Dormouse keeps
// its global shortcuts.
addEventListener('keydown', (e) => {
  if (isDormouseLeader(e)) {
    parent.postMessage({ __dormouse: 'leader-keydown', key: e.key, code: e.code,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey }, '*');
  }
}, true);
addEventListener('focus', () => parent.postMessage({ __dormouse: 'focus' }, '*'), true);
addEventListener('blur',  () => parent.postMessage({ __dormouse: 'blur'  }, '*'), true);
```

The forwarding is **asymmetric and minimal**: the embedded tool (a code editor, a
full VS-Code-web workbench) wants nearly every keystroke and has its own
keybindings; Dormouse only needs to reclaim its handful of global chords. The Wall
already owns a capturing `window` keydown listener
(`use-wall-keyboard.ts`); it gains a `message` listener that validates the origin
against the live proxy grant, then feeds the forwarded chord into the same
keybinding dispatch — preferably by calling the dispatcher with the serialized
payload directly, not by re-dispatching a synthesized `KeyboardEvent` (whose
constructor drops `keyCode`/`which`; VS Code works around it with
`Object.defineProperty`, a wrinkle we skip by not round-tripping a DOM event).

### Accurate focus model (resolves #2 and #3)

The shim's `focus`/`blur` messages let the Wall keep an accurate model:

- **#2** — the Wall distinguishes "one of our own instrumented panes took focus"
  from a real window blur and keeps `windowFocused` true.
- **#3** — the surface registers a focus handle that posts a `focus-yourself`
  message to the shim, so `onClickPanel → enterTerminalMode` can focus the pane
  like any other surface.

### Real error signals (resolves #4)

With the proxy, **Dormouse is the server**, so it sees the upstream result and
renders a precise error *page* (served from the proxy origin, which the iframe
loads normally): refused framing → "`google.com` refuses to be embedded
(`X-Frame-Options: DENY`); open it with `dor ab open https://google.com`"; server
down → "nothing responding at `localhost:8080` — is the dev server running?".
This turns the `google.com`-into-an-iframe dead end into an actionable message.

### Proxy mechanism

Modeled on the agent-browser **stream relay**
(`vscode-ext/src/agent-browser-host.ts`) — already a loopback-only, tokenized,
single-purpose forwarder. Differences: this proxy speaks **HTTP** (parses and
rewrites responses) rather than being a dumb byte pipe, and passes through
**WebSocket upgrades** (dev-server HMR, openvscode-server's connection).

- **Loopback bind, per-surface token grant** (TTL + lazy sweep), exactly like
  `createStreamRelayUrl`. The proxy forwards only to the exact granted upstream
  for a valid token — never a general-purpose open proxy.
- **Single origin, path-preserving.** Each grant maps a proxy URL
  (`http://127.0.0.1:<proxyPort>/<token>/…`) to one fixed upstream; root-relative
  URLs resolve against the proxy origin and get proxied transparently.
- **Response rewriting.** For `text/html` from a loopback upstream: strip
  `X-Frame-Options`, neutralize CSP `frame-ancestors`, replace the page CSP with
  one permitting the tool plus the injected shim's nonce, inject the shim.
  Non-HTML passes through.
- **Anti-framebust.** The `<iframe>` uses a `sandbox` without
  `allow-top-navigation`, so a tool's `if (top !== self) top.location = …` cannot
  navigate the Wall away.

### Host capability and CSP

A new optional `PlatformAdapter` method mirroring `getAgentBrowserStreamUrl`
(`lib/src/lib/platform/types.ts`), so hosts degrade gracefully:

```ts
createIframeProxyUrl?(targetUrl: string): Promise<
  | { ok: true; url: string }
  | { ok: false; reason: 'frame-refused' | 'unreachable' | 'scheme'; detail?: string }
>;
```

VS Code implements it in the extension host alongside the stream relay (a sibling
`iframe-proxy-host.ts`). **The proxy is needed on every host** — even where a
Tauri webview could frame `http://127.0.0.1` directly for origin reasons,
injection still requires controlling the bytes — unlike the agent-browser relay,
which was a VS-Code-only origin fix. With the proxy, the VS Code webview CSP
(`vscode-ext/src/webview-html.ts`) narrows from the broad `frame-src http:
https:` to the loopback proxy origin only:

```
frame-src http://127.0.0.1:* http://localhost:*
```

### Security model

The same fences as the stream relay: loopback-only bind both sides; per-surface
token grants (no open forwarder); **header-stripping restricted to loopback**
(remote upstreams never stripped — no force-framing third-party sites); the
injected shim is fixed and Dormouse-owned (no user script ever reaches the page).
**SSRF consideration:** the proxy fetches a user-supplied URL (an SSRF shape, e.g.
cloud metadata `169.254.169.254`); the trust boundary is the user's own
`dor iframe <url>` so risk is bounded, but the proxy should consider refusing
link-local/metadata ranges.

## Render Backends: Two Axes

With the proxy in place, "view a web thing in a pane" factors into two
**independent axes**, and the agent-browser and iframe surfaces are just cells in
the grid:

| | **Target: just a URL** | **Target: a backend Dormouse spawns & owns** |
| --- | --- | --- |
| **Render: screencast** (agent-browser) | `dor ab open <url>` — today | (possible, rarely wanted) |
| **Render: embed** (proxy + shim iframe) | `dor iframe <localhost>` — above | **the plugin system (Path 2)** |

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
is already 840 lines and the input models differ fundamentally (CDP `input_*`
messages vs native DOM). Instead, make the swap a **layout operation: replace the
pane's renderer in place, preserving the target.** `createContentSurface` already
replaces an untouched terminal in its slot — generalize that to "replace surface X
with surface Y at the same dock position," triggered by a header affordance ("open
in iframe" / "open in browser"). The substrate makes this nearly free.

## Path 2 — Plugin System

Extend the **target axis** with process ownership: Dormouse spawns the plugin's
backend (an HTML editor, `openvscode-server` / `code serve-web`, any local tool)
and renders it through the same `embed` backend. The rendering is solved by the
proxy; what Path 2 adds is a **process supervisor** — spawn (in what cwd/env?
per-workspace or per-pane? reuse across panes?), allocate/health-check the port,
wire the proxy to it, and **reap the process when the pane is killed.**

That last requirement is the second consumer that justifies generalizing the
per-surface **teardown-on-kill hook** — the one-off `agent-browser` close
currently special-cased in `Wall.tsx`'s `killPaneImmediately` (see
[dor-agent-browser.md](dor-agent-browser.md) → Lifecycle). A plugin backend that
leaks when its pane closes is a real bug, so the abstraction stops being premature
exactly here.

**Risk specific to the motivating example (code-server / openvscode-server):**
it will stress the substrate more than a Vite dev server — worth a spike before
committing. It needs `allow-same-origin allow-scripts allow-forms allow-popups
allow-downloads allow-modals` (still omitting `allow-top-navigation` for the
anti-framebust guarantee); may want COOP/COEP for cross-origin isolation
(SharedArrayBuffer) — verify against the actual target; and leans on WebSocket
passthrough harder than most.

## Open Decisions

1. **Remote frameable targets** — render best-effort with the leader shim, or
   always route remote to an error page that points at `dor ab`? The latter keeps
   a crisp "loopback = iframe, remote = agent-browser" line.
2. **Absolute-origin sub-resources.** Dev servers emitting absolute
   `http://localhost:5173/...` URLs bypass the proxy origin — widen CSP to allow
   the loopback upstream (cheap) vs. rewrite response bodies (invasive)?
3. **SSRF range-blocking** — refuse link-local/metadata/private ranges, or trust
   the user's own command?
4. **Web host** — no host process to run a proxy: hide the surface, or keep the
   blind raw-iframe fallback?
</content>
