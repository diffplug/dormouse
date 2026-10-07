# Local Security

> - See `docs/specs/glossary.md` for Pane, Session, and the Surface model; this spec uses them bare.
> - Owns the boundaries a user of the local application has: terminal output, browser panes, `dor`, loopback listeners, the network policy's Nothing, and what persists on disk.
> - Defers every mechanism to the spec named at its rule, and the network boundary to `docs/specs/security-remote.md`.
> - Read `docs/specs/security.md` first; `docs/specs/security-audit.md` says how the `FAIL IF` lines here are run.

## Terminal output

The attacker is any program writing to a PTY.

Output reaches the screen, Session state, and bounded terminal reports — rendered text/images, alerts, titles, prompt/command boundaries, CWD, and `OSC 8` — except a running designated Tool's OSC 367 `open`, gated below, and a stopping Tool's `dehydrate`, which reaches only its own next run (`docs/specs/dor-tool.md` → Reaping). xterm.js and ImageAddon answer cursor, device, focus, size, and graphics reports (`docs/specs/transport.md` -> "Report filtering on the input side"). Retained output is bounded by representation (`docs/specs/terminal-state.md` -> "Supported OSC Inputs", `docs/specs/terminal-escapes.md` -> "Parsing location", `docs/specs/layout.md` -> "Inline graphics").

`OSC 52` only offers its text to the copy editor over the user's own drag, copied when the user picks it (`docs/specs/mouse-and-clipboard.md` §4.6). **Inline images carry their own bytes**: no path is resolved, ImageAddon dropping any non-`inline=1` transfer (`docs/specs/layout.md` -> "Inline graphics").

**An `OSC 8` hyperlink opens only after a confirmation dialog**, except a local `file:` link whose display text names its target, which previews through the user's `open` rules (`docs/specs/dor-tool.md` -> "Terminal links"); a target whose display text names a different host gets **no open action at all** (`docs/specs/mouse-and-clipboard.md` -> "OSC 8 hyperlinks"). File opens use `docs/specs/dor-tool.md` -> "Opening local files".

Notification text: `docs/specs/alert.md` -> "Text And Security".

**The `OSC 633` terminator escape is emit-side**, in the shipped shell-integration scripts — the parser scans raw bytes and cannot defend it (`docs/specs/terminal-state.md` -> "Shell-integration injection"; rationale).

- **FAIL IF** a `TerminalProtocolEvent` reaches the clipboard, a file, or anything but the screen, Session state, or a bounded terminal report beyond the two Tool exceptions above and the `OSC 52` copy-editor offer, or the parser emits a `response` outside three answer families — `OSC 10/11/12 ; ?` color, `OSC 99` capability, `CSI > q` device: `TerminalProtocolParser` in `lib/src/lib/terminal-protocol.ts` and its consumers.
- **FAIL IF** `TerminalProtocolParser` stops consuming `OSC 52`, `OSC 50`, or an `OSC 1337` outside `OSC1337_FORWARDED`, or a parse site stops running it before `pty:data` leaves it (rationale). Pinned by `lib/src/lib/terminal-protocol.test.ts`.
- **FAIL IF** an escape sequence `docs/specs/terminal-escapes.md`'s registry marks consumed or ignored, or one it does not list, has any visible, clipboard, file, focus, or privilege effect rather than failing inertly (rationale).
- **FAIL IF** an `OSC 52` payload can reach the clipboard except as the copy editor's program format the user chose and copied, is retained unbounded or with control characters other than newline and tab, or is accepted into a pane with no shadowed drag: `parseOsc52` and `CLIPBOARD_OFFER_LIMIT` in `lib/src/lib/terminal-protocol.ts`, `offerProgramCopy` in `lib/src/lib/mouse-selection.ts`, `copySelection` in `lib/src/lib/copy-selection.ts`. Pinned by `lib/src/lib/terminal-protocol.test.ts`, `lib/src/lib/mouse-selection.test.ts`, and `lib/src/lib/copy-editor.test.ts`.
- **FAIL IF** a value the parser retains stops being bounded and control-stripped before storage, or a new one arrives without a limit — `TITLE_LIMIT`, `BODY_LIMIT` and `COMMAND_LINE_LIMIT` in `lib/src/lib/terminal-protocol.ts`, `sanitizeText` in `lib/src/lib/osc-sanitize.ts`, `MAX_CWD_LENGTH` and `boundedCwdValue` in `lib/src/lib/terminal-state.ts`; or an incomplete semantic OSC stops being bounded by `OSC_INCOMPLETE_LIMIT`, or ImageAddon by the encoded-byte, pixel, and storage limits of `IMAGE_ADDON_OPTIONS` in `lib/src/lib/terminal-lifecycle.ts`. `commandLineEvents` bounds a command line before decoding as well as after (rationale).
- **FAIL IF** an `OSC 8` activation reaches an adapter's `openExternal` without the confirmation dialog, or the dialog renders an open action for a **deceptive** verdict: `linkHandler` in `lib/src/lib/terminal-lifecycle.ts`, `classifyDisplayMatch` in `lib/src/lib/external-links.ts`, the render branches in `lib/src/components/ExternalLinkModal.tsx`. Pinned by `lib/src/lib/external-links.test.ts` and `lib/src/components/ExternalLinkModalHost.test.tsx`; the host also rejects a deceptive confirmation (rationale).
- **FAIL IF** a host launches an external URL without revalidating it through `normalizeExternalUri` in `lib/src/lib/external-links.ts`, consent notwithstanding — VS Code's in the extension host (`vscode-ext/src/message-router.ts`), standalone's in `standalone/src/tauri-adapter.ts` and `openUrl` in `standalone/src/updater.ts`.
- **FAIL IF** an unconfirmed `OSC 8` activation reaches the preview path when its display text is not a whole-component suffix of its decoded target, or the host opens a `file:` URL whose host is not empty, `localhost`, or this machine: `localFileLinkPreviewPath` in `lib/src/lib/external-links.ts`, `activateTerminalLink` in `lib/src/lib/terminal-link-activation.ts`, `resolveLocalToolTarget` in `lib/src/host/tool-input.ts`. Pinned by `lib/src/lib/external-links.test.ts`, `lib/src/lib/terminal-link-activation.test.ts`, and `lib/src/host/tool-input.test.ts`.
- **FAIL IF** an OSC 367 `open` reaches `surface.tool` from replay, from a Session that is not a Tool running its designated command, or naming anything but an absolute path free of controls; or if a control-socket request can set its `oscOpen` flag, or its failure reaches the error viewer's argv with a control character. Read `parseToolOpen` in `dor-tools-lib/src/osc.ts`, `dispatchToolOpens` in `lib/src/lib/tool-open-requests.ts` (reached from `applyLiveToolEvents`, never from `parseReplay` in `lib/src/lib/platform/replay-parse.ts`), the `oscOpen` argument of `dispatchDorControlRequest` in `lib/src/lib/platform/dor-control-dispatch.ts`, and the `oscOpen` gate in `lib/src/components/wall/use-dor-control.ts`. Pinned by `lib/src/components/wall/preview-slot.test.tsx`.

## Browser panes

The attacker is the page inside a browser pane.

Where Windows screenshots and pasted images land is a known gap (`docs/specs/security.md` -> "Known gaps").

**Every listener the webview realm exposes to a framed page checks the sender's origin before it acts** — `IframePanel` against its own panel's proxy origin, the Wall's leader channel against any live grant (`docs/specs/dor-browser.md` -> "Iframe Shim"). **That separates a proxied frame from any other, never the injected shim from the page it runs in** (rationale).

**A framed page cannot forge a *host* message.** The VS Code webview authenticates every host→webview message with a per-boot token minted at serve time into the nonce-gated boot script, unreadable cross-origin, and the guard fails closed when no token was injected (`docs/specs/vscode.md` -> "Webview message authentication"). **The standalone adapters have no forgeable inbox**: host events arrive over Tauri IPC, never `window.postMessage`.

**Each injected shim hop must address only its proxy origin and the embedder chain's innermost origin, never `'*'`.** Nested frames relay the three pane-level messages through same-origin parents; their document-level locations stop there. With no usable chain the proxy injects nothing and strips no framing header (`docs/specs/dor-browser.md` -> "Iframe Host Capability And CSP"). What it grants a *caller* is [Loopback Listeners](#loopback-listeners)'s business.

- **FAIL IF** an injected shim targets anything but its proxy origin or the embedder chain's innermost origin, relays a nested `location`, a foreign-origin message, or an unregistered message, or the proxy uses a chain it did not validate in full: `iframeShim` and `normalizeEmbedderOrigins` in `lib/src/host/iframe-proxy-rewrite.ts`, applied in `lib/src/host/iframe-proxy.ts`. Pinned by `lib/src/host/iframe-proxy-rewrite.test.ts` and `lib/src/host/iframe-proxy.test.ts`.
- **FAIL IF** a `VSCodeAdapter` host-channel listener acts on a message before `isHostMessage` (`lib/src/lib/vscode-message-token.ts`) accepts it, or the token stops being minted per serve and attached only by `WebviewChannel.post` in `vscode-ext/src/webview-messaging.ts`: `dor:controlRequest` is one of the shapes a framed page could otherwise claim. The proxy-origin listeners above are guarded by origin, not the token. Pinned by `lib/src/lib/platform/vscode-adapter.test.ts`.

Source of truth: `isProxyOrigin` in `lib/src/lib/iframe-proxy-registry.ts`, the per-panel check in `lib/src/components/wall/IframePanel.tsx`; `lib/src/host/private-capture-dir.ts`, `standalone/sidecar/clipboard-ops.js`, `standalone/src-tauri/src/clipboard_win.rs`.

## The dor control socket

The attacker is another local account. The channel carries the whole Surface API — keystrokes into any Pane, its screen and scrollback back out, `dor kill` — and an app restart behind the running-work confirmation (`docs/specs/dor-cli.md` -> "Host Plumbing", "dor app").

The socket bounds other local accounts, never a process running as the user (`docs/specs/security.md` -> "What is not defended"; rationale).

**The server picks the path unguessably and hardens its directory before it binds.** POSIX: `<tmpdir>/dormouse-dor-<uid>/<8 random bytes>.sock`, inside a per-user directory `lstat`ed before the bind; one of ours that is merely loose is tightened, anything else stands the channel down. Windows has a named pipe and no directory (`docs/specs/security.md` -> "What is not defended").

**The token never crosses the wire in either direction** — 24 CSPRNG bytes per host process, never written to disk, proven by HMAC-SHA256 over the peer's nonce under a per-direction domain and compared in constant time. **The server challenges first and proves its own half before the client sends any request**; a peer that fails its half is hung up on with no reply. **A peer that has not finished the handshake within 10 s is dropped** (`HANDSHAKE_BUDGET_MS`).

**A lost bind stands the channel down rather than weakening it**: both hosts delete the two control variables at startup and re-attach them to spawned shells only once the bind reports ready.

- **FAIL IF** `ensureControlDir` in `standalone/sidecar/dor-control-server.js` stops requiring all four of a real directory, not a symlink, owned by this uid, at exactly mode `0700`, or `resolveControlSocketPath` stops refusing to name a socket when that predicate fails or derives a socket or pipe name from anything but fresh random bytes, the PID included. Pinned by `standalone/sidecar/dor-control-server.test.js`.
- **FAIL IF** the raw token reaches a socket, or either side compares a proof with anything but the SHA-256-then-`timingSafeEqual` of `proofMatches`. The construction is hand-mirrored between `standalone/sidecar/dor-control-server.js` and `dor/src/control-client.ts`; only the two proof domains are pinned across the copies, by `lib/src/lib/mirrored-constants.test.ts` (rationale).

## Loopback Listeners

Dormouse binds loopback HTTP and WebSocket servers to render its own surfaces.

**A loopback bind is not an access control.** `127.0.0.1` keeps out the network, but the attacker that matters is a page open in the user's own browser, which reaches loopback exactly as easily as our webview does; **an ephemeral port is not a secret either** (rationale).

Listeners check their loopback name and recognize callers; the iframe proxy admits strangers but declines to vouch. URL tokens appear only where the listener owns the page URL, as the browser-dev harness does; iframe proxies cannot preserve them through upstream routing and subresources (rationale).

- **FAIL IF** any loopback HTTP or WebSocket listener grants an unrecognized caller a privilege it could not obtain by reaching the upstream directly. Refusing the request is one way; the iframe proxy's *admits all, vouches for none, names its embedder* is another, and is not a violation (rationale). `scripts/loopback-lint.mjs` mechanizes the guard-reference half (AGENTS.md lint table); whether every request calls the guard is the audit's. `BIND_FORMS` in `scripts/loopback-lint.mjs` is the bind inventory; a new server dependency adds its spelling there. The Relay is separate (`docs/specs/security-remote.md` -> "Cross-origin access"). A Unix-domain socket or named pipe is out of scope — no browser can reach one — so the `dor` control channel is bounded by socket permissions instead.
- **FAIL IF** the iframe proxy rewrites `Origin` to the upstream's own origin for a caller whose inbound `Origin` is not the proxy's own — in `handleRequest` **or** `handleUpgrade`. A foreign `Origin` must be forwarded untouched rather than blocked, so the upstream sees the truth and applies its own policy (rationale).
- **FAIL IF** the iframe proxy forwards `Cookie` upstream or `Set-Cookie` downstream on HTTP or WebSocket handshakes, including refused upgrades. Pinned by `lib/src/host/iframe-proxy.test.ts` (rationale).
- **FAIL IF** the iframe proxy stops checking that `Host` names its own grant port, on either path. Its per-grant ephemeral port and one-fixed-upstream binding are real mitigations but neither is a secret, so the `Host` check is what makes DNS rebinding fail.
- **FAIL IF** the iframe proxy drops upstream `X-Frame-Options` / CSP `frame-ancestors` without replacing them with exactly `frame-ancestors 'self' <validated embedder chain>` — the full chain the webview supplies with each proxy URL request — admits another source, or targets the shim anywhere but its own proxy origin and that chain's innermost origin. `'self'` admits same-grant nesting only. With no usable chain it must preserve the headers and inject nothing (rationale).
- **FAIL IF** an iframe proxy grant outlives its view — a leased grant or its upgraded pipe survives its lease's release or its owner's reinitialization or end, or a lease's owner comes from the webview, not the host transport — or a *foreign* `Origin` refreshes an unleased grant's idle timer: a grant holds a live upstream binding a stranger must not keep open. An *absent* `Origin` must keep refreshing it, as a live frame's own loads send. `releaseIframeProxyLease` in `lib/src/host/iframe-proxy.ts` and its callers.
- **FAIL IF** the browser viewer listener upgrades without both its own loopback `Host` and a single-use, 60-second grant for that one view, or passes a provider a webview message it has not rebuilt; or the host dials an agent-browser stream or a browser's CDP off loopback: `createViewerServer` and `parseViewerInput` in `lib/src/host/browser-viewer.ts`, `viewStream` and `askCdpEndpoint` in `lib/src/host/agent-browser-host.ts`. The webview holds no CDP and reaches no daemon (rationale). Pinned by `lib/src/host/browser-viewer.test.ts`.
- **FAIL IF** the browser-dev bridge drops any of its four gates — the per-run token, the loopback `Host` check, the `application/json` content-type required of every non-GET, and the exact-origin `access-control-allow-origin` — or the first three stop running together before routing. It is dev-only, but dispatches `pty_spawn` with caller-supplied `shell`, `args`, `cwd` and `env` on a maintainer or CI-agent machine (rationale).
- **FAIL IF** the browser-dev Vite server permits cross-origin reads of token-bearing modules or disables its DNS-rebinding Host check. Pinned by `standalone/scripts/dev-agent-browser.test.mjs` (rationale).

What header stripping leaves shared is a known gap (`docs/specs/security.md` -> "Known gaps"; rationale).

Source of truth: the shared rule and predicates — `isLoopbackHost`, `isOwnOrigin`, `isForeignOrigin` — in `lib/src/host/loopback-guard.ts`; `startDevVite` in `standalone/scripts/dev-run.mjs`.

### Local-file viewer

**FAIL IF** `dor-tools-builtin/src/file-viewer.ts` serves any request without the fresh 256-bit URL capability, its own case-insensitive loopback `Host`, and an absent or same-listener `Origin`. Methods are GET/HEAD, plus POSTs requiring its own non-null Origin and a bounded body: text-editor save/state and Markdown image rename carry JSON, and Markdown image paste carries the image's bytes typed `image/png`, `image/jpeg`, `image/gif`, or `image/webp`, none of them CORS-safelisted. Compare capability prefixes by SHA-256 then `timingSafeEqual`, including malformed lengths. `allowsFileViewerRequest` in `dor-tools-builtin/src/file-viewer-loopback-guard.ts` gates every route. Never grant CORS access to foreign origins, cache responses, or send the capability as a referrer.

**FAIL IF** the file viewer exposes directory listings, arbitrary path reads/writes, or a file outside its opened-document grant and fixed shipped-editor assets. Grant construction permits only regular files, rejects symlinks escaping the canonical document directory, bounds static dependency discovery, and retains media/HTML descriptors. Text reads/saves revalidate the exact canonical file and reject symlink substitution; saves compare content revisions and file identity before atomic replacement. Only text viewers accept writes. The Markdown editor's grant adds regular image-format files at or under the document's canonical directory, opened per request by realpath and served with a `sandbox` CSP; its other writes create signature-checked images exclusively beside the document and rename such images within their own directory without replacing a file (`dor-tools-builtin/src/markdown-images.ts`), and its page renders document HTML only through `safeCreateDOM`'s allowlist in `dor-tools-builtin/viewer/markdown-safety.ts`, and a fenced `mermaid` block only as the SVG `renderDiagram` in `dor-tools-builtin/viewer/mermaid-block.tsx` returns from mermaid initialized with `securityLevel: 'strict'` and nothing that loosens it (`secure`, `dompurifyConfig`); no `%%{init}%%` directive in the document can change that level (rationale). Viewer resources and editor workers are restricted by CSP to its own origin plus inline scripts/styles and data images, including through the iframe proxy; source text is JSON data, never executable markup. The viewer preserves upstream CSP (`docs/specs/dor-browser.md` → Iframe Renderer).

What the viewer CSP and mermaid's sanitizer leave open is `docs/specs/security.md` -> "What is not defended" (rationale).

**FAIL IF** the folder viewer, `dor-tools-builtin/src/folder-viewer.ts`, serves any request without the capability, `Host`, `Origin`, and response-header rules above, or accepts a POST whose `Origin` is absent, `null`, or not its own. `allowsFileViewerRequest` with `post` gates every route; a POST writes an OSC 367 `open`, which the host runs as `dor open` from that Tool.

**FAIL IF** the folder viewer returns file contents, lists or opens anything outside its canonical root, or renders an entry name as markup. `resolveInside` refuses `.`, `..`, and empty segments, backslashes, and controls, then requires the realpath at or under the root; a symlink whose target leaves it lists as `other`. A listing carries names, kinds, and ignore flags only, and `folderViewerPage` sets names through `textContent`, since script in the page could POST as it.

**FAIL IF** the error viewer, `dor-tools-builtin/src/error-viewer.ts`, serves anything but its one page, breaks the capability, `Host`, `Origin`, and response-header rules above, allows script, or renders its target or message as markup.

**FAIL IF** any built-in viewer's `OSC 2` title keeps a C0, DEL, or C1 character. `viewerTitle` in `dor-tools-builtin/src/file-viewer-format.ts` strips them from the target's basename, which would otherwise write terminal escapes such as a forged `OSC 367 serve`.

**FAIL IF** `gitIgnored` lets `core.fsmonitor` run, which the browsed folder's own `.git/config` can name; how it names git is "Spawned programs" below.

Source of truth: `startCapabilityViewer` in `dor-tools-builtin/src/viewer-server.ts`; `dor-tools-builtin/src/folder-viewer.ts`; `dor-tools-builtin/src/folder-viewer-page.ts`; `sanitizeResponseHeaders` in `lib/src/host/iframe-proxy.ts`.

## Network policy

The exposure is traffic the user never chose, which under Nothing is none. `docs/specs/remote-network.md` -> "Policy" owns the rule these checks audit.

- **FAIL IF** anything opens a connection on its own while the network policy is `nothing` or unread. `BurrowService` in `lib/src/host/remote/service.ts` must route every socket, request, and direct peer through its transport guard, which refuses at the call, and `BurrowRuntime` and `burrowFetch` must take theirs from it with no default to the global `WebSocket` or `fetch`; start no `BurrowRuntime` under `nothing`; and refuse `enroll`, `enrollOffer`, `beginHostedEnrollment`, and `oneTimeOpen` before any request. `createManagedVoiceHost` in `lib/src/host/managed-voice-host.ts` must ask `networkAllowed` before every speak, and `runUpdateCheck` in `standalone/src/updater.ts` must not call `check()` unless the policy it read is not `nothing` and `autoUpdate` is on, a failed read counting as `nothing`. Search the rest of `lib/src/host/`, `standalone/src/`, and `vscode-ext/src/` for a request outside these three. Pinned by `lib/src/host/remote/service.test.ts`, `lib/src/remote/burrow/burrow-fetch.test.ts`, `lib/src/remote/burrow/burrow-relay-socket.test.ts`, `lib/src/host/managed-voice-host.test.ts`, and `standalone/src/updater.test.ts`.
- **FAIL IF** the policy can be written by anything but the user's own choice or the Burrow service's first-read default (`docs/specs/remote-network.md` -> "Policy"). The service is the only writer, and `setNetworkPolicy` accepts only an exact policy (`parseNetworkPolicy` in `lib/src/remote/network-policy.ts`, `requestedNetworkPolicy` in `lib/src/host/remote/service.ts`); no Client, Relay, or Hosted answer may reach the store, and a stored record that is not a policy must read as `nothing`.

## Persisted state

The attacker is another local account reading disk; what the remote stack leaves behind is `docs/specs/security-remote.md` -> "Credentials at rest".

**Standalone's session store is owner-only before any bytes are written** — every window snapshot, its geometry sibling, and the arrival journal (`docs/specs/standalone.md` -> "Persistence", "Boot and geometry", "Arrival queue"), on every platform. The same helper locks the whole standalone app-data directory before the sidecar spawns.

**No writer persists scrollback** (`docs/specs/transport.md` -> "What is persisted", "Retiring the transcripts already on disk"). Snapshots older versions left behind do carry transcripts (rationale).

**Standalone writes `recovery.json` beside its sessions directory**, under the state root, owner-only: one rebuilt agent-resume invocation per Surface, never a buffer, unlinked as it is read (`docs/compatible-agents.md` -> "Recovery record").

**The managed-voice token is a bearer credential at rest** — `managed-voice.json` beside the Burrow's enrollment in the state dir, `0700`/`0600`, under the owner-only DACL `burrow_state_dir` applies on Windows before the sidecar spawns (rationale); `docs/specs/alert.md` → "Managed voice" keeps it from any webview. Where the token may go is `docs/specs/security-remote.md` -> "Relay origin".

**VS Code persists pane structure in VS Code's own storage** — `workspaceState` and `vscode.setState()` — so the modes there are VS Code's, not ours, and no transcript reaches either (`docs/specs/vscode.md` -> "Serialization and restore"). Dormouse also writes `recovery.json` in extension storage, mode `0600` on Unix: one rebuilt agent-resume invocation per Surface, no buffer, unlinked as it is read (`docs/compatible-agents.md` -> "Recovery record").

**The VS Code peer-link token is a local credential at rest** — `burrow.peer-token` in the extension's global storage, written mode `0600` with `wx`, its socket directory re-checked on every contention round. Neither control does anything on Windows, and Dormouse applies no Windows DACL to the peer-link token, `recovery.json`, or the `tool-trust` receipts (`docs/specs/security.md` -> "Known gaps"; rationale).

No standalone log call (`docs/specs/standalone.md` -> "Logging") carries PTY bytes, but the log records the `dor` socket path (rationale).

- **FAIL IF** `write_file_atomically` in `standalone/src-tauri/src/lib.rs` stops restricting the directory and the file it writes to the owning user on **every** platform `restrict_to_owner` has an arm for — `0700`/`0600` on unix, and on Windows a DACL protected from inheritance carrying exactly one ACE for the current user — or the mode stops reaching the temp file *before* any bytes are written, or **any** of its callers stops going through it. Enumerate them from the file rather than from this line: every writer under the state root is one, the legacy-transcript scrub and `arrivals.json` included. The one exception is the macOS hang sample `/usr/bin/sample` writes into `hangs/`; it goes through `write_owner_only_with`, which restricts the directory before the child runs and the file after. Pinned by the Rust tests in the same file (rationale).
- **FAIL IF** a standalone log handle opens other than through `open_log` in `standalone/src-tauri/src/lib.rs`, or `open_log` stops leaving the log owner-only on **every** platform — unix: `0600`, an existing file tightened, a symlink refused; Windows: `restrict_to_owner`'s DACL — or the Linux default is not a per-user directory whenever `XDG_STATE_HOME` or `HOME` is absolute. Pinned by the Rust tests in the same file (rationale).

Source of truth: `SESSION_STATE_KEY` in `vscode-ext/src/session-state.ts`, `ensureToken` in `vscode-ext/src/peer-link.ts`, `default_log_location` in `standalone/src-tauri/src/lib.rs`, `createManagedVoiceHost` in `lib/src/host/managed-voice-host.ts`, `hostedVoiceOrigin` in `lib/src/host/relay-origin.ts`.

## Terminal context directory actions

- **FAIL IF** a context directory argument, or a terminal-reported directory Workspace auto-naming hands the host's git lookup (`docs/specs/layout.md` → "Workspace names"), reaches a process without being validated as an existing absolute directory and passed as its canonical path in one argument with no shell interpretation; a context directory action goes through the external-URL allowlist rather than this validation; the native opener runs a program the path names (macOS reveals with `open -R`; Windows refuses a path Explorer would split); or a VS Code per-terminal context request or helper ownership update leaves the owning router.

Source of truth: `context` in `standalone/sidecar/pty-core.js`; `attachRouter` in `vscode-ext/src/message-router.ts`; `lookupGitDir` in `lib/src/host/git-info.ts`.

## Spawned programs

The attacker is a file planted in a folder the user opens: Windows looks a bare program name up in the working directory before `PATH` (rationale).

- **FAIL IF** a host, `dor`, or a built-in Tool spawns a program by bare name on Windows: a system program goes by its path under `%SystemRoot%` (`cmd.exe` by `ComSpec`), a user-installed one such as git by the file `docs/specs/dor-cli.md` -> "Spawning External Binaries" resolves on `PATH`, or not at all. Search `standalone/sidecar/`, `lib/src/host/`, `vscode-ext/src/`, `dor/src/`, `dor-lib-common/src/`, and `dor-tools-builtin/src/`. Pinned by `standalone/sidecar/pty-core.test.js`, `standalone/sidecar/clipboard-ops.test.js`, and `lib/src/host/git-upstream.test.ts`.
- **FAIL IF** the VS Code pty host forks in any cwd but the extension's own directory. Pinned by `vscode-ext/test/pty-manager.test.ts`.

Source of truth: `windowsSystemPath` in `standalone/sidecar/windows-system.js`; `resolveBinaryPath` in `dor-lib-common/src/resolve-binary.ts`; `ensureChild` in `vscode-ext/src/pty-manager.ts`.

## Dor Tool configuration

Approval workflow, declaration and resolution belong to `docs/specs/dor-tool.md` → Trust, Declaring tools.

What an upstream grant trusts, and what the trust prompt does not bound, is `docs/specs/security.md` -> "What is not defended".

- **FAIL IF** a repo-local named Tool spawns its terminal or a helper before the user grants trust through Dormouse chrome, or the control socket gains a trust-grant verb beside lookup and launch.
- **FAIL IF** named-tool inputs stop being argv until the renderer quotes them for the target shell, or a project name can replace a user Tool during user-only lookup; user configuration is the local user's authority.
- **FAIL IF** a repo-sourced field reaches a terminal with a C0, DEL, or C1 character unescaped: every field `dor tool` prints, its warnings, `--list --json`, every `dor list` listing, the host errors `dor tool` and `dor open` relay, the host's answer they print, and the file names and handlers the `dor open` picker draws. Pinned by `dor/test/cli-output.test.mjs` and `dor/test/open-picker.test.mjs`.
- **FAIL IF** Tool argv, substituted argv, or a local target reaches launch carrying a C0, DEL, or C1 character, including one exposed by canonicalizing a symlink or decoding a `file:` URL, which a filesystem error would otherwise echo; shell quotes do not protect terminal editing keys. String `run` remains explicit shell code.
- **FAIL IF** a renderer request can supply the grant key rather than the host deriving it from the canonical upstream URL or project-root folder, or a host reads a config unbounded or follows a repo-config symlink. The user config may follow a dotfiles symlink; its opened descriptor must still be a bounded regular file.
- **FAIL IF** a port announced outside the designated command's Session process tree is served (`docs/specs/dor-tool.md` → Serving), or process output turns an ordinary terminal into a Tool; it may only select among that tree's discovered ports.

Source of truth: `createToolHost` in `lib/src/host/tool-host.ts`; `lookupTool` in `lib/src/host/tool-trust.ts`; `useToolServing` in `lib/src/components/wall/use-tool-serving.ts`; `printable` in `dor/src/commands/shared.ts`; `hasShellInputControls` in `dor/src/commands/shell-quote.ts`; `resolveToolInput` in `lib/src/host/tool-input.ts`.
