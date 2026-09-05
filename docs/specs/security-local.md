# Local Security

> See `docs/specs/glossary.md` for Pane, Session, and the Surface model; this spec uses them bare.
> Owns the boundaries a user of the local application has: terminal output, browser panes, `dor`, loopback listeners, and what persists on disk. Defers every mechanism to the spec named at its rule, and the network boundary to `docs/specs/security-remote.md`.
> Read `docs/specs/security.md` first; `docs/specs/security-audit.md` says how the `FAIL IF` lines here are run.

## Terminal output

The attacker is any program writing to a PTY.

**Must bound retained output by representation**: `TerminalProtocolParser` semantic values by code points and control stripping, an incomplete semantic OSC at 16,384 code units, and ImageAddon data by encoded bytes, decoded pixels, and FIFO storage (`docs/specs/terminal-escapes.md` -> "Parsing location", "Inline graphics").

**Never let untrusted PTY output write the clipboard or access a file**: consume `OSC 52`, `OSC 50`, and unsupported `OSC 1337`. **Inline images carry their own bytes**: no path is resolved, ImageAddon dropping any non-`inline=1` transfer (`docs/specs/terminal-escapes.md` -> "Inline graphics").

**An `OSC 8` hyperlink opens only after a confirmation dialog**; a target whose
display text names a different host gets **no open action at all** — close and
copy only, copy holding initial focus
(`docs/specs/terminal-escapes.md` -> "OSC 8 hyperlinks"). **Nothing opens without
a second pass through `normalizeExternalUri`** (VS Code's in the extension
host); the dialog is consent, not the boundary.

**Unsupported escape sequences must fail inertly** — consumed or ignored, with
no visible garbage, clipboard, file, focus, or privilege effect
(`docs/specs/terminal-escapes.md` -> "iTerm2 identity"; rationale).

**Notification text is untrusted terminal output**: sanitized at protocol-parse
time, rendered as plain text and never as markup, re-bounded by a second pass
before speech or push (`docs/specs/alert.md` -> "Text And Security").

**The `OSC 633` terminator escape is emit-side**, in the shipped
shell-integration scripts — the parser scans raw bytes and cannot defend it
(`docs/specs/terminal-escapes.md` -> "Shell-integration injection"; rationale).

**Must confine output to the screen, Session state, and bounded terminal reports** — rendered text/images, alerts, titles, prompt/command boundaries, CWD, and `OSC 8`. **The PTY-boundary parser writes exactly three answer families**: `OSC 10/11/12 ; ?` color, `OSC 99` capability, `CSI > q` device. xterm.js and ImageAddon answer cursor, device, focus, size, and graphics reports
(`docs/specs/terminal-escapes.md` -> "Report filtering on the input side").

- **FAIL IF** `isKnownUnsupportedIterm2Osc` in `lib/src/lib/terminal-protocol.ts` stops consuming `OSC 52`, or a parse site stops running `TerminalProtocolParser` before `pty:data` leaves it (rationale). Pinned by `lib/src/lib/terminal-protocol.test.ts`.
- **FAIL IF** a value the parser retains stops being bounded and control-stripped before storage, or a new one arrives without a limit — `TITLE_LIMIT`, `BODY_LIMIT`, `COMMAND_LINE_LIMIT` and `sanitizeText` in `lib/src/lib/terminal-protocol.ts`, `MAX_CWD_LENGTH` and `boundedCwdValue` in `lib/src/lib/terminal-state.ts`. `COMMAND_LINE_LIMIT` binds *after* the `\xNN` unescape, a 4x bound before it (rationale).
- **FAIL IF** an `OSC 8` activation reaches an adapter's `openExternal` without the confirmation dialog, or the dialog renders an open action for a **deceptive** verdict: `linkHandler` in `lib/src/lib/terminal-lifecycle.ts`, `classifyDisplayMatch` in `lib/src/lib/external-links.ts`, the render branches in `lib/src/components/ExternalLinkModal.tsx`. The classification is pinned by `lib/src/lib/external-links.test.ts`; the *absence* of the open action is not (rationale).

## Browser panes

The attacker is the page inside a browser pane.

**Every listener the webview realm exposes to a framed page checks the sender's
origin before it acts** — `IframePanel` against its own panel's proxy origin, the
Wall's leader channel against any live grant (`docs/specs/dor-browser.md` ->
"Iframe Shim"). **That separates a proxied frame from any other, never the
injected shim from the page it runs in** (rationale).

**A framed page cannot forge a *host* message.** The VS Code webview
authenticates every host→webview message with a per-boot token minted at serve
time into the nonce-gated boot script, unreadable cross-origin, and the guard
fails closed when no token was injected (`docs/specs/vscode.md` -> "Webview
message authentication"). **The standalone adapters have no forgeable inbox**:
host events arrive over Tauri IPC, never `window.postMessage`.

**Each injected shim hop must address only its proxy origin and the embedder
chain's innermost origin, never `'*'`.** Nested frames relay the three pane-level
messages through same-origin parents; their document-level locations stop there.
With no usable chain the proxy injects
nothing and strips no framing header (`docs/specs/dor-browser.md` -> "Iframe
Host Capability And CSP"). What it grants a *caller* is [Loopback
Listeners](#loopback-listeners)'s business.

- **FAIL IF** an injected shim targets anything but its proxy origin or the embedder chain's innermost origin, relays a nested `location`, a foreign-origin message, or an unregistered message, or the proxy uses a chain it did not validate in full: `iframeShim` and `normalizeEmbedderOrigins` in `lib/src/host/iframe-proxy-rewrite.ts`, applied in `lib/src/host/iframe-proxy.ts`. Pinned by `lib/src/host/iframe-proxy-rewrite.test.ts` and `lib/src/host/iframe-proxy.test.ts`.
- **FAIL IF** a `VSCodeAdapter` host-channel listener acts on a message before `isHostMessage` (`lib/src/lib/vscode-message-token.ts`) accepts it, or the token stops being minted per serve and attached only by `WebviewChannel.post` in `vscode-ext/src/webview-messaging.ts`: `dor:controlRequest` is one of the shapes a framed page could otherwise claim. The proxy-origin listeners above are guarded by origin, not the token. Pinned by the `host message authentication` block in `lib/src/lib/platform/vscode-adapter.test.ts`.

Source of truth: `isProxyOrigin` in `lib/src/lib/iframe-proxy-registry.ts`, the
per-panel check in `lib/src/components/wall/IframePanel.tsx`.

## The dor control socket

The attacker is another local account. The channel carries the whole Surface API
— keystrokes into any Pane, its screen and scrollback back out, `dor kill`
(`docs/specs/dor-cli.md` -> "Control-channel security").

**A process running as the user is the user.** The socket bounds other local
accounts, never the user's own: an agent holding `dor` has the power of the
person at the keyboard, the local mirror of the remote rule
(`docs/specs/security-remote.md` -> "Remote Control"; rationale).

**The server picks the path unguessably and hardens its directory before it
binds.** POSIX: `<tmpdir>/dormouse-dor-<uid>/<8 random bytes>.sock`, inside a
per-user directory `lstat`ed before the bind; one of ours that is merely loose is
tightened, anything else stands the channel down. **Windows has a named pipe and
no directory to harden**, and Dormouse applies no ACL there, so the name and the
handshake are the whole of it. **Neither spelling may derive from the PID.**

**The token never crosses the wire in either direction** — 24 CSPRNG bytes per
host process, never written to disk, proven by HMAC-SHA256 over the peer's nonce
under a per-direction domain and compared in constant time. **The server
challenges first and proves its own half before the client sends any request**;
a peer that fails its half is hung up on with no reply.

**A lost bind stands the channel down rather than weakening it**: both hosts
delete the two control variables at startup and re-attach them to spawned shells
only once the bind reports ready.

- **FAIL IF** `ensureControlDir` in `standalone/sidecar/dor-control-server.js` stops requiring all four of a real directory, not a symlink, owned by this uid, at exactly mode `0700`, or `resolveControlSocketPath` stops refusing to name a socket when that predicate fails. Pinned by `standalone/sidecar/dor-control-server.test.js`.
- **FAIL IF** the raw token reaches a socket, or either side compares a proof with anything but the SHA-256-then-`timingSafeEqual` of `proofMatches`. The construction is hand-mirrored between `standalone/sidecar/dor-control-server.js` and `dor/src/control-client.ts`, and only the two proof domains are pinned (rationale).

## Loopback Listeners

Dormouse binds loopback HTTP and WebSocket servers to render its own surfaces.

**A loopback bind is not an access control.** `127.0.0.1` keeps out the network, but
the attacker that matters is a page open in the user's own browser, which reaches
loopback exactly as easily as our webview does; **an ephemeral port is not a secret
either** (rationale).

**The rule is about privilege, not admission: no listener may grant an unrecognized
caller anything it could not already obtain by reaching the upstream directly.** Every
such listener answers two questions on every request — **was I addressed by my own
loopback name**, and **do I recognize this caller** — and differs in what it does with
the second. Two refuse the request outright. The iframe proxy admits everyone and
instead declines to **vouch** (rationale). **The recognition mechanism differs per
listener because their URLs differ, and the differences are forced, not stylistic**: a
URL token is available to the browser-dev harness, which owns its page's URL, and never
to the iframe proxy (rationale).

**The replacement policy must allow exactly `'self'` plus the full validated
ancestor chain the webview supplies with each proxy URL request.** `'self'` allows
same-grant nesting; any foreign ancestor fails. No request header identifies the
embedder, and the browser checks the whole chain (rationale).

- **FAIL IF** any loopback HTTP or WebSocket listener grants an unrecognized caller a privilege it could not obtain by reaching the upstream directly. Refusing the request is one way; the iframe proxy's *admits all, vouches for none, names its embedder* is another, and is not a violation (rationale). `scripts/loopback-lint.mjs` (`pnpm test`) makes the cheap half deterministic — a new loopback bind that does not reference a guard module fails the build — but only in the bind forms its `BIND_FORMS` lists, each pinned by a fixture in `scripts/loopback-lint-selftest.mjs`, which goes red on a form that has none. **Adding a server dependency means adding its bind spelling there**; a host built at runtime is invisible to a regex in any spelling. The lint sees only a guard reference, not whether every request calls it, so this bullet is still read by hand. Derive the set by searching the shipped trees for `createServer`, `.listen(`, `serve(` and `WebSocket` rather than trusting this list. Today the set is three: the iframe proxy (`lib/src/host/iframe-proxy.ts`), the VS Code agent-browser stream relay (`vscode-ext/src/agent-browser-host.ts`), and the browser-dev bridge (`standalone/scripts/dev-agent-browser.mjs`). A Unix-domain socket or named pipe is not in scope — no browser can reach one — which is why the `dor` control channel is bounded by socket permissions instead.
- **FAIL IF** the iframe proxy rewrites `Origin` to the upstream's own origin for a caller whose inbound `Origin` is not the proxy's own — in `handleRequest` **or** `handleUpgrade`. A foreign `Origin` must be forwarded untouched rather than blocked, so the upstream sees the truth and applies its own policy (rationale).
- **FAIL IF** the iframe proxy stops checking that `Host` names its own grant port, on either path. Its per-grant ephemeral port and one-fixed-upstream binding are real mitigations but neither is a secret, so the `Host` check is what makes DNS rebinding fail.
- **FAIL IF** the iframe proxy drops upstream `X-Frame-Options` / CSP `frame-ancestors` without replacing them with exactly `frame-ancestors 'self' <validated embedder chain>`, admits another source, or targets the shim anywhere but its own proxy origin and that chain's innermost origin. With no usable chain it must preserve the headers and inject nothing (rationale).
- **FAIL IF** a request bearing a *foreign* `Origin` refreshes a grant's idle timer: a grant holds a live upstream binding, and a stranger polling it keeps a closed pane's binding open. An *absent* `Origin` must keep refreshing it — that is what a live frame's own navigations and sub-resources send.
- **FAIL IF** the stream relay's grant stops being single-use, TTL-bounded, and pinned to one target port, or if it begins rewriting `Origin` rather than dropping it. It needs no `Host` check while the token holds (rationale).
- **FAIL IF** the browser-dev bridge drops any of its four gates — the per-run token, the loopback `Host` check, the `application/json` content-type required of every non-GET, and the exact-origin `access-control-allow-origin`. The first three live together in the gate that runs before routing, so a route that never reads a body is covered by all of them. It is dev-only and ships in nothing, but it dispatches `pty_spawn` with caller-supplied `shell`, `args`, `cwd` and `env` — arbitrary command execution on a maintainer or CI-agent machine (`docs/specs/security-ci.md` -> "Automated Maintainer (tend)"). The content-type rule is a security control, not tidiness (rationale).

Source of truth: the shared rule and predicates — `isLoopbackHost`, `isOwnOrigin`,
`isForeignOrigin` — in `lib/src/host/loopback-guard.ts`.

## Persisted state

The attacker is another local account reading disk; what the remote stack leaves
behind is `docs/specs/security-remote.md` -> "Credentials at rest".

**Session snapshots are owner-only before any bytes are written.**
`restrict_to_owner` locks `<app_data_dir>/sessions/` and, *first*, the temp file
renamed into it, applying a protected single-ACE DACL on Windows where a unix
mode is a silent no-op (`docs/specs/standalone.md` -> "Persistence"). The same
helper locks the whole standalone app-data directory before the sidecar spawns.

**No writer persists scrollback** (`docs/specs/transport.md` -> "What is
persisted"): `normalizeSessionV3` strips it on read, and the standalone store is
switched off today, clearing any legacy snapshot at boot. Snapshots older
versions left behind do carry transcripts (rationale).

**VS Code persists pane structure in VS Code's own storage** — `workspaceState`
under `dormouse.session`, and `vscode.setState()`, a WebviewPanel's only store —
so the modes there are VS Code's, not ours, and no transcript reaches either
(`docs/specs/vscode.md` -> "Serialization and restore"). Dormouse writes one file
of its own there, `recovery.json`, at the umask: one rebuilt agent-resume
invocation per Surface, no buffer, unlinked as it is read
(`docs/specs/vscode.md` -> "Capturing agent recovery").

**The VS Code peer-link token is a local credential at rest** —
`burrow.peer-token` in the extension's global storage, written mode `0600`
with `wx`, its socket directory re-checked on every contention round. **Neither
control does anything on Windows** (rationale).

**The standalone log is unprotected and names the control socket.**
`$DORMOUSE_LOG_FILE`, else `%LOCALAPPDATA%\Dormouse Terminal\dormouse.log`, else
`<tmpdir>/dormouse.log`, created and appended with no mode and no ACL, so it
lands at the umask — readable by another local account wherever `<tmpdir>` is
shared (rationale). No log call carries PTY bytes; the `dor` control socket path
does. A gap, not an accepted risk.

- **FAIL IF** `write_session_to` in `standalone/src-tauri/src/lib.rs` stops restricting the `sessions/` directory and the snapshot to the owning user on **every** platform `restrict_to_owner` has an arm for — `0700`/`0600` on unix, and on Windows a DACL protected from inheritance carrying exactly one ACE for the current user, asserted by `restrict_to_owner_leaves_one_owner_only_ace`. That test covers the Windows arm alone; the unix modes and both call sites are pinned by nothing. The mode reaches the temp file *before* any bytes are written (rationale).

Source of truth: `SESSION_STATE_KEY` in `vscode-ext/src/session-state.ts`,
`ensureToken` in `vscode-ext/src/peer-link.ts`, `default_log_path` in
`standalone/src-tauri/src/lib.rs`.
