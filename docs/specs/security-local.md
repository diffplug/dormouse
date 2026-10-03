# Local Security

> See `docs/specs/glossary.md` for Pane, Session, and the Surface model; this spec uses them bare.
> Owns the boundaries a user of the local application has: terminal output, browser panes, `dor`, loopback listeners, the network policy's Nothing, and what persists on disk. Defers every mechanism to the spec named at its rule, and the network boundary to `docs/specs/security-remote.md`.
> Read `docs/specs/security.md` first; `docs/specs/security-audit.md` says how the `FAIL IF` lines here are run.

## Terminal output

The attacker is any program writing to a PTY.

**Must bound retained output by representation**: `TerminalProtocolParser` semantic values by code points and control stripping, an incomplete semantic OSC by length, and ImageAddon data by encoded bytes, decoded pixels, and FIFO storage (`docs/specs/terminal-state.md` -> "Supported OSC Inputs", `docs/specs/terminal-escapes.md` -> "Parsing location", `docs/specs/layout.md` -> "Inline graphics").

**Never let untrusted PTY output write the clipboard or access a file**: consume `OSC 50` and unsupported `OSC 1337`; consume `OSC 52`, which only offers its text to the copy editor over the user's own drag, copied when the user picks it (`docs/specs/mouse-and-clipboard.md` §4.6). **Inline images carry their own bytes**: no path is resolved, ImageAddon dropping any non-`inline=1` transfer (`docs/specs/layout.md` -> "Inline graphics").

**An `OSC 8` hyperlink opens only after a confirmation dialog**, except a local
`file:` link whose display text names its target, which previews through the
user's `open` rules (`docs/specs/dor-tool.md` -> "Terminal links"); a target whose
display text names a different host gets **no open action at all**
(`docs/specs/mouse-and-clipboard.md` -> "OSC 8 hyperlinks"). **Must revalidate
every external-URL launch through `normalizeExternalUri`**, consent
notwithstanding (VS Code's in the extension host); file opens use
`docs/specs/dor-tool.md` -> "Opening local files".

**Unsupported escape sequences must fail inertly** — consumed or ignored, with
no visible garbage, clipboard, file, focus, or privilege effect
(rationale).

**Notification text is untrusted terminal output**: sanitized at protocol-parse
time, rendered as plain text and never as markup, re-bounded by a second pass
before speech or push (`docs/specs/alert.md` -> "Text And Security").

**The `OSC 633` terminator escape is emit-side**, in the shipped
shell-integration scripts — the parser scans raw bytes and cannot defend it
(`docs/specs/terminal-state.md` -> "Shell-integration injection"; rationale).

**Must confine output to the screen, Session state, and bounded terminal reports** — rendered text/images, alerts, titles, prompt/command boundaries, CWD, and `OSC 8` — except a running designated Tool's OSC 367 `open`, gated below, and a stopping Tool's `dehydrate`, which reaches only its own next run (`docs/specs/dor-tool.md` → Reaping). **The PTY-boundary parser writes exactly three answer families**: `OSC 10/11/12 ; ?` color, `OSC 99` capability, `CSI > q` device. xterm.js and ImageAddon answer cursor, device, focus, size, and graphics reports
(`docs/specs/transport.md` -> "Report filtering on the input side").

- **FAIL IF** `TerminalProtocolParser` in `lib/src/lib/terminal-protocol.ts` stops consuming `OSC 52` or `OSC 50`, or a parse site stops running it before `pty:data` leaves it (rationale). Pinned by `lib/src/lib/terminal-protocol.test.ts`.
- **FAIL IF** an `OSC 52` payload can reach the clipboard except as the copy editor's program format the user chose and copied, is retained unbounded or with control characters other than newline and tab, or is accepted into a pane with no shadowed drag: `parseOsc52` and `CLIPBOARD_OFFER_LIMIT` in `lib/src/lib/terminal-protocol.ts`, `offerProgramCopy` in `lib/src/lib/mouse-selection.ts`, `copySelection` in `lib/src/lib/copy-selection.ts`. Pinned by `lib/src/lib/terminal-protocol.test.ts`, `lib/src/lib/mouse-selection.test.ts`, and `lib/src/lib/copy-editor.test.ts`.
- **FAIL IF** a value the parser retains stops being bounded and control-stripped before storage, or a new one arrives without a limit — `TITLE_LIMIT`, `BODY_LIMIT`, `COMMAND_LINE_LIMIT` and `sanitizeText` in `lib/src/lib/terminal-protocol.ts`, `MAX_CWD_LENGTH` and `boundedCwdValue` in `lib/src/lib/terminal-state.ts`. `commandLineEvents` bounds a command line before decoding as well as after (rationale).
- **FAIL IF** an `OSC 8` activation reaches an adapter's `openExternal` without the confirmation dialog, or the dialog renders an open action for a **deceptive** verdict: `linkHandler` in `lib/src/lib/terminal-lifecycle.ts`, `classifyDisplayMatch` in `lib/src/lib/external-links.ts`, the render branches in `lib/src/components/ExternalLinkModal.tsx`. Pinned by `lib/src/lib/external-links.test.ts` and `lib/src/components/ExternalLinkModalHost.test.tsx`; the host also rejects a deceptive confirmation (rationale).
- **FAIL IF** an unconfirmed `OSC 8` activation reaches the preview path when its display text is not a whole-component suffix of its decoded target, or the host opens a `file:` URL whose host is not empty, `localhost`, or this machine: `localFileLinkPreviewPath` in `lib/src/lib/external-links.ts`, `activateTerminalLink` in `lib/src/lib/terminal-link-activation.ts`, `resolveLocalToolTarget` in `lib/src/host/tool-input.ts`. Pinned by `lib/src/lib/external-links.test.ts`, `lib/src/lib/terminal-link-activation.test.ts`, and `lib/src/host/tool-input.test.ts`.
- **FAIL IF** an OSC 367 `open` reaches `surface.tool` from replay, from a Session that is not a Tool running its designated command, or naming anything but an absolute path free of controls; or if a control-socket request can set its `oscOpen` flag, or its failure reaches the error viewer's argv with a control character. Read `parseToolOpen` in `dor-tools-lib/src/osc.ts`, `dispatchToolOpens` in `lib/src/lib/tool-open-requests.ts` (reached from `applyLiveToolEvents`, never from `parseReplay` in `lib/src/lib/platform/replay-parse.ts`), the `oscOpen` argument of `dispatchDorControlRequest` in `lib/src/lib/platform/dor-control-dispatch.ts`, and the `oscOpen` gate in `lib/src/components/wall/use-dor-control.ts`. Pinned by `lib/src/components/wall/preview-slot.test.tsx`.

## Browser panes

The attacker is the page inside a browser pane.

**Known gap: Windows screenshots and pasted clipboard images inherit their
parent's ACL** — private under the default per-user `%TEMP%`, exposed only when
it (or the capture parent) is shared or loosened.

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
- **FAIL IF** a `VSCodeAdapter` host-channel listener acts on a message before `isHostMessage` (`lib/src/lib/vscode-message-token.ts`) accepts it, or the token stops being minted per serve and attached only by `WebviewChannel.post` in `vscode-ext/src/webview-messaging.ts`: `dor:controlRequest` is one of the shapes a framed page could otherwise claim. The proxy-origin listeners above are guarded by origin, not the token. Pinned by `lib/src/lib/platform/vscode-adapter.test.ts`.

Source of truth: `isProxyOrigin` in `lib/src/lib/iframe-proxy-registry.ts`, the
per-panel check in `lib/src/components/wall/IframePanel.tsx`;
`lib/src/host/private-capture-dir.ts`, `standalone/sidecar/clipboard-ops.js`,
`standalone/src-tauri/src/clipboard_win.rs`.

## The dor control socket

The attacker is another local account. The channel carries the whole Surface API
— keystrokes into any Pane, its screen and scrollback back out, `dor kill` — and
an app restart behind the running-work confirmation (`docs/specs/dor-cli.md` ->
"Host Plumbing", "dor app").

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
a peer that fails its half is hung up on with no reply. **A peer that has not finished the handshake within 10 s is dropped** (`HANDSHAKE_BUDGET_MS`).

**A lost bind stands the channel down rather than weakening it**: both hosts
delete the two control variables at startup and re-attach them to spawned shells
only once the bind reports ready.

- **FAIL IF** `ensureControlDir` in `standalone/sidecar/dor-control-server.js` stops requiring all four of a real directory, not a symlink, owned by this uid, at exactly mode `0700`, or `resolveControlSocketPath` stops refusing to name a socket when that predicate fails. Pinned by `standalone/sidecar/dor-control-server.test.js`.
- **FAIL IF** the raw token reaches a socket, or either side compares a proof with anything but the SHA-256-then-`timingSafeEqual` of `proofMatches`. The construction is hand-mirrored between `standalone/sidecar/dor-control-server.js` and `dor/src/control-client.ts`; only the two proof domains are pinned across the copies, by `lib/src/lib/mirrored-constants.test.ts` (rationale).

## Loopback Listeners

Dormouse binds loopback HTTP and WebSocket servers to render its own surfaces.

**A loopback bind is not an access control.** `127.0.0.1` keeps out the network, but
the attacker that matters is a page open in the user's own browser, which reaches
loopback exactly as easily as our webview does; **an ephemeral port is not a secret
either** (rationale).

**Never grant an unrecognized caller anything it could not obtain directly from the upstream.** Listeners check their loopback name and recognize callers; the iframe proxy admits strangers but declines to vouch. **Use URL tokens only where the listener owns the page URL**, as the browser-dev harness does; iframe proxies cannot preserve them through upstream routing and subresources (rationale).

- **FAIL IF** any loopback HTTP or WebSocket listener grants an unrecognized caller a privilege it could not obtain by reaching the upstream directly. Refusing the request is one way; the iframe proxy's *admits all, vouches for none, names its embedder* is another, and is not a violation (rationale). `scripts/loopback-lint.mjs` mechanizes the guard-reference half (AGENTS.md lint table); whether every request calls the guard is the audit's. `BIND_FORMS` in `scripts/loopback-lint.mjs` is the bind inventory; a new server dependency adds its spelling there. The Relay is separate (`docs/specs/security-remote.md` -> "Cross-origin access"). A Unix-domain socket or named pipe is out of scope — no browser can reach one — so the `dor` control channel is bounded by socket permissions instead.
- **FAIL IF** the iframe proxy rewrites `Origin` to the upstream's own origin for a caller whose inbound `Origin` is not the proxy's own — in `handleRequest` **or** `handleUpgrade`. A foreign `Origin` must be forwarded untouched rather than blocked, so the upstream sees the truth and applies its own policy (rationale).
- **FAIL IF** the iframe proxy forwards `Cookie` upstream or `Set-Cookie` downstream on HTTP or WebSocket handshakes, including refused upgrades. Pinned by `lib/src/host/iframe-proxy.test.ts` (rationale).
- **FAIL IF** the iframe proxy stops checking that `Host` names its own grant port, on either path. Its per-grant ephemeral port and one-fixed-upstream binding are real mitigations but neither is a secret, so the `Host` check is what makes DNS rebinding fail.
- **FAIL IF** the iframe proxy drops upstream `X-Frame-Options` / CSP `frame-ancestors` without replacing them with exactly `frame-ancestors 'self' <validated embedder chain>` — the full chain the webview supplies with each proxy URL request — admits another source, or targets the shim anywhere but its own proxy origin and that chain's innermost origin. `'self'` admits same-grant nesting only. With no usable chain it must preserve the headers and inject nothing (rationale).
- **FAIL IF** a request bearing a *foreign* `Origin` refreshes a grant's idle timer: a grant holds a live upstream binding, and a stranger polling it keeps a closed pane's binding open. An *absent* `Origin` must keep refreshing it — that is what a live frame's own navigations and sub-resources send.
- **FAIL IF** the browser viewer listener upgrades without both its own loopback `Host` and a single-use, 60-second grant for that one view, or passes a provider a webview message it has not rebuilt; or the host dials an agent-browser stream or a browser's CDP off loopback: `createViewerServer` and `parseViewerInput` in `lib/src/host/browser-viewer.ts`, `viewStream` and `askCdpEndpoint` in `lib/src/host/agent-browser-host.ts`. The webview holds no CDP and reaches no daemon (rationale). Pinned by `lib/src/host/browser-viewer.test.ts`.
- **FAIL IF** the browser-dev bridge drops any of its four gates — the per-run token, the loopback `Host` check, the `application/json` content-type required of every non-GET, and the exact-origin `access-control-allow-origin` — or the first three stop running together before routing. It is dev-only, but dispatches `pty_spawn` with caller-supplied `shell`, `args`, `cwd` and `env` on a maintainer or CI-agent machine (rationale).
- **FAIL IF** the browser-dev Vite server permits cross-origin reads of token-bearing modules or disables its DNS-rebinding Host check. Pinned by `standalone/scripts/dev-agent-browser.test.mjs` (rationale).

**Cookie-authenticated iframe pages are unsupported.** Header stripping does not isolate `document.cookie`: proxied scripts still share the loopback hostname's non-HttpOnly cookies across grant ports. This remains a browser-pane isolation gap (rationale).

Source of truth: the shared rule and predicates — `isLoopbackHost`, `isOwnOrigin`,
`isForeignOrigin` — in `lib/src/host/loopback-guard.ts`;
`startDevVite` in `standalone/scripts/dev-run.mjs`.

### Local-file viewer

**FAIL IF** `dor-tools-builtin/src/file-viewer.ts` serves any request without the fresh 256-bit URL capability, its own case-insensitive loopback `Host`, and an absent or same-listener `Origin`. Methods are GET/HEAD, plus text-editor save/state and Markdown image paste/rename POSTs requiring its own non-null Origin, JSON, and a bounded body. Compare capability prefixes by SHA-256 then `timingSafeEqual`, including malformed lengths. `allowsFileViewerRequest` in `dor-tools-builtin/src/file-viewer-loopback-guard.ts` gates every route. Never grant CORS access to foreign origins, cache responses, or send the capability as a referrer.

**FAIL IF** the file viewer exposes directory listings, arbitrary path reads/writes, or a file outside its opened-document grant and fixed shipped-editor assets. Grant construction permits only regular files, rejects symlinks escaping the canonical document directory, bounds static dependency discovery, and retains media/HTML descriptors. Text reads/saves revalidate the exact canonical file and reject symlink substitution; saves compare content revisions and file identity before atomic replacement. Only text viewers accept writes. The Markdown editor's grant adds regular image-format files at or under the document's canonical directory, opened per request by realpath and served with a `sandbox` CSP; its other writes create signature-checked images exclusively beside the document and rename such images within their own directory without replacing a file (`dor-tools-builtin/src/markdown-images.ts`), and its page renders document HTML only through `safeCreateDOM`'s allowlist in `dor-tools-builtin/viewer/markdown-safety.ts`. Viewer resources and editor workers are restricted by CSP to its own origin plus inline scripts/styles and data images, including through the iframe proxy; source text is JSON data, never executable markup. The viewer preserves upstream CSP (`docs/specs/dor-browser.md` → Iframe Renderer).

**Must not describe the viewer CSP as confining active documents' navigation.** HTML/SVG scripts can navigate their frame to external URLs, including with granted contents; the resource policy is not a no-egress boundary. (rationale)

**FAIL IF** the folder viewer, `dor-tools-builtin/src/folder-viewer.ts`, serves any request without the capability, `Host`, `Origin`, and response-header rules above, or accepts a POST whose `Origin` is absent, `null`, or not its own. `allowsFileViewerRequest` with `post` gates every route; a POST writes an OSC 367 `open`, which the host runs as `dor open` from that Tool.

**FAIL IF** the folder viewer returns file contents, lists or opens anything outside its canonical root, or renders an entry name as markup. `resolveInside` refuses `.`, `..`, and empty segments, backslashes, and controls, then requires the realpath at or under the root; a symlink whose target leaves it lists as `other`. A listing carries names, kinds, and ignore flags only, and `folderViewerPage` sets names through `textContent`, since script in the page could POST as it.

**FAIL IF** the error viewer, `dor-tools-builtin/src/error-viewer.ts`, serves anything but its one page, breaks the capability, `Host`, `Origin`, and response-header rules above, allows script, or renders its target or message as markup.

**FAIL IF** any built-in viewer's `OSC 2` title keeps a C0, DEL, or C1 character. `viewerTitle` in `dor-tools-builtin/src/file-viewer-format.ts` strips them from the target's basename, which would otherwise write terminal escapes such as a forged `OSC 367 serve`.

**FAIL IF** `gitIgnored` runs git by bare name or lets `core.fsmonitor` run, which the browsed folder's own `.git/config` can name.

Source of truth: `startCapabilityViewer` in `dor-tools-builtin/src/viewer-server.ts`; `dor-tools-builtin/src/folder-viewer.ts`; `dor-tools-builtin/src/folder-viewer-page.ts`; `sanitizeResponseHeaders` in `lib/src/host/iframe-proxy.ts`.

## Network policy

The exposure is traffic the user never chose, which under Nothing is none. `docs/specs/remote-network.md` -> "Policy" owns the rule these checks audit.

- **FAIL IF** anything opens a connection on its own while the network policy is `nothing` or unread. `BurrowService` in `lib/src/host/remote/service.ts` must route every socket, request, and direct peer through its transport guard, which refuses at the call; start no `BurrowRuntime` under `nothing`; and refuse `enroll`, `enrollOffer`, `beginHostedEnrollment`, and `oneTimeOpen` before any request. `createManagedVoiceHost` in `lib/src/host/managed-voice-host.ts` must ask `networkAllowed` before every speak, and `runUpdateCheck` in `standalone/src/updater.ts` must not call `check()` unless the policy it read is not `nothing` and `autoUpdate` is on, a failed read counting as `nothing`. Search the rest of `lib/src/host/`, `standalone/src/`, and `vscode-ext/src/` for a request outside these three. Pinned by `lib/src/host/remote/service.test.ts`, `lib/src/host/managed-voice-host.test.ts`, and `standalone/src/updater.test.ts`.
- **FAIL IF** the policy can be written by anything but the user's own choice. `setNetworkPolicy` is the only writer and takes a policy only exactly (`parseNetworkPolicy` in `lib/src/remote/network-policy.ts`, `requestedNetworkPolicy` in `lib/src/host/remote/service.ts`); no Client, Relay, or Hosted answer may reach the store, and a stored record that is not a policy must read as `nothing`.

## Persisted state

The attacker is another local account reading disk; what the remote stack leaves
behind is `docs/specs/security-remote.md` -> "Credentials at rest".

**Standalone's session store is owner-only before any bytes are written** —
every window snapshot, its geometry sibling, and the arrival journal
(`docs/specs/standalone.md` -> "Persistence", "Boot and geometry", "Arrival queue"), on every platform. The same
helper locks the whole standalone app-data directory before the sidecar spawns.

**No writer persists scrollback** (`docs/specs/transport.md` -> "What is
persisted", "Retiring the transcripts already on disk"). Snapshots older versions
left behind do carry transcripts (rationale).

**Standalone writes `recovery.json` beside its sessions directory**, under the
state root, owner-only: one rebuilt agent-resume invocation per Surface, never a
buffer, unlinked as it is read (`docs/compatible-agents.md` -> "Recovery record").

**The managed-voice token is a bearer credential at rest** — `managed-voice.json` beside the Burrow's enrollment in the state dir, `0700`/`0600`, under the owner-only DACL `burrow_state_dir` applies on Windows before the sidecar spawns (rationale); `docs/specs/alert.md` → "Managed voice" keeps it from any webview. **The token must go only to `hostedVoiceOrigin`'s answer**, never following a redirect (`redirect: 'error'`); a self-host build, answered `null`, sends it nowhere (`docs/specs/relay.md` -> "Relay origin").

**VS Code persists pane structure in VS Code's own storage** — `workspaceState`
and `vscode.setState()` — so the modes there are VS Code's, not ours, and no
transcript reaches either (`docs/specs/vscode.md` -> "Serialization and
restore"). Dormouse also writes `recovery.json` in extension storage, mode `0600`
on Unix: one rebuilt agent-resume invocation per Surface, no buffer, unlinked as
it is read (`docs/compatible-agents.md` -> "Recovery record").

**The VS Code peer-link token is a local credential at rest** —
`burrow.peer-token` in the extension's global storage, written mode `0600`
with `wx`, its socket directory re-checked on every contention round. **Neither
control does anything on Windows** (rationale). **Dormouse applies no Windows
DACL to the peer-link token, `recovery.json`, or the `tool-trust` receipts**;
they inherit the extension storage ACL.

**The standalone log is unprotected and names the control socket.** The log
(`docs/specs/standalone.md` -> "Logging") is created and appended with no mode
and no ACL, so it lands at the umask — readable by another local account
wherever `<tmpdir>` is shared (rationale). No log call carries PTY bytes; the
`dor` control socket path does. A gap, not an accepted risk.

- **FAIL IF** `write_file_atomically` in `standalone/src-tauri/src/lib.rs` stops restricting the directory and the file it writes to the owning user on **every** platform `restrict_to_owner` has an arm for — `0700`/`0600` on unix, and on Windows a DACL protected from inheritance carrying exactly one ACE for the current user — or the mode stops reaching the temp file *before* any bytes are written, or **any** of its callers stops going through it. Enumerate them from the file rather than from this line: every writer under the state root is one, the legacy-transcript scrub and `arrivals.json` included. Pinned by the Rust tests in the same file (rationale).

Source of truth: `SESSION_STATE_KEY` in `vscode-ext/src/session-state.ts`,
`ensureToken` in `vscode-ext/src/peer-link.ts`, `default_log_path` in
`standalone/src-tauri/src/lib.rs`, `createManagedVoiceHost` in
`lib/src/host/managed-voice-host.ts`, `hostedVoiceOrigin` in
`lib/src/host/relay-origin.ts`.

## Terminal context directory actions

**Must validate context directory arguments as existing absolute directories and pass the canonical path as one process argument without shell interpretation.** The same holds for the terminal-reported directories Workspace auto-naming hands the host's git lookup (`docs/specs/layout.md` → "Workspace names"). Keep this capability separate from the external-URL allowlist. VS Code per-terminal context requests and helper ownership updates remain scoped to the owning router.

Source of truth: `context` in `standalone/sidecar/pty-core.js`; `attachRouter` in `vscode-ext/src/message-router.ts`; `lookupGitDir` in `lib/src/host/git-info.ts`.

## Dor Tool configuration

Approval workflow, declaration and resolution belong to `docs/specs/dor-tool.md` → Trust, Declaring tools.

**Must keep repo-local named Tools inert until the user grants trust through Dormouse chrome.** The control socket exposes lookup and launch, never a trust-grant verb. Pending approval spawns neither its terminal nor a helper.

**Must keep named-tool inputs as argv until the renderer quotes them for the target shell.** User configuration is the local user's authority; a project name cannot replace a user Tool during user-only lookup.

**Must escape C0, DEL, and C1 characters in every repo-sourced field `dor tool` prints, its warnings, `--list --json`, the host errors `dor tool` and `dor open` relay, and the file names and handlers the `dor open` picker draws included**, since each is bound for a terminal. Pinned by `dor/test/cli-output.test.mjs`.

**Must reject C0 and DEL characters in Tool argv, substituted argv, and local targets before launch**, including controls exposed by canonicalizing symlinks or by decoding a `file:` URL, which a filesystem error would otherwise echo. Shell quotes do not protect terminal editing keys. String `run` remains explicit shell code.

**Must derive the grant key in the host**, using the canonical upstream URL or project-root folder; a renderer request cannot supply an arbitrary grant URL. **Must bound config reads and refuse repo-config symlinks on every host.** The user config may follow a dotfiles symlink; its opened descriptor must still be a bounded regular file.

**An upstream grant trusts the claimed URL, not authenticated checkout provenance.** A supplied directory containing its own `.git/config` can claim an already-granted upstream; folder-only grants limit this sharing. **Must not describe the chrome gesture as a boundary against other processes running as the user**; the local account model is The dor control socket above.

**Must restrict announced ports to the designated command's Session process tree** (`docs/specs/dor-tool.md` → Serving). Process output may select among that tree's discovered ports; it cannot turn an ordinary terminal into a Tool.

Source of truth: `createToolHost` in `lib/src/host/tool-host.ts`; `lookupTool` in `lib/src/host/tool-trust.ts`; `useToolServing` in `lib/src/components/wall/use-tool-serving.ts`; `printable` in `dor/src/commands/shared.ts`; `hasShellInputControls` in `dor/src/commands/shell-quote.ts`; `resolveToolInput` in `lib/src/host/tool-input.ts`.
