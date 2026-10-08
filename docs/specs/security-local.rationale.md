# Local Security — rationale

## Terminal output

What the `OSC 52` strip actually buys. The pinned `@xterm/xterm` registers OSC handlers for 0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111 and 112 only — no 52 — and no clipboard addon is a dependency, so an `OSC 52` reaching xterm today would be discarded rather than acted on. Dormouse's strip is therefore the barrier it controls, not the only one standing; xterm's handler table is not ours to keep, and an addon or a version bump could add 52 without a diff here.

Why the OSC 633 command line carries two bounds. `COMMAND_LINE_LIMIT` (2048) is applied by `sanitizeText` *after* `decodeOsc633Value`, because the `\xNN` unescape re-introduces the control characters the emit side removed. A 4x bound holds the raw value before the unescape, so an emitter cannot make the decoder do unbounded work on the way to that cap.

Why fail-inertly is a rule and not an aspiration. Dormouse reports an iTerm2-compatible identity to unlock the iTerm2-style sequences it does implement, so emitters offer it many more than it models; every one of those arrives from an untrusted program, and the only safe disposition for a sequence with no behavior behind it is silence.

Why inline IIP does not reopen file access. The addon's `File` name is base64 metadata and is never used, while a transfer without `inline=1` is rejected before decoding. The only bytes reaching the image decoder are carried inside the control sequence itself; no path is resolved and no download is written.

Why image data has different bounds from semantic text. Titles, commands, and directories become long-lived strings and keys, so code-point caps plus control stripping are their boundary. Graphics are streaming binary payloads decoded into RGBA storage; encoded-byte, pixel-count, and per-Session FIFO caps bound the actual allocation dimensions instead.

Why the `OSC 633` terminator filter is emit-side. The parser scans raw bytes for the three terminators `findOscTerminator` knows — `BEL`, `ESC \`, the C1 ST — so a directory name or command line carrying one ends the `633` sequence early and the remainder arrives as a fresh, fully trusted OSC. Nothing the parser can do distinguishes that from an emitter that meant it, which is why the boundary is in the scripts Dormouse ships. `lib/src/lib/terminal-protocol.test.ts` proves the parser *cannot* defend it: for each of the three terminators it forges an `OSC 9` notification with the body `PWNED` through an unfiltered `Cwd=`.

Why the OSC 367 `open` check names its evidence. Its earlier wording, "a Tool running its designated command", left open what shows the command is running, and the gate compared the command line the shell reports, which is output. Two nightly audits split on it (2026-10). The check now names the host's launch as the evidence and rules out anything the output reports, so the verdict no longer depends on the auditor's reading.

Why deceptive links are gated twice. The modal omits its Open action and focuses Copy, while the host callback independently rejects the deceptive verdict. The component regression exercises both the rendered buttons and a direct callback invocation, so an accidental presentation change cannot alone enable opening.

## Browser panes

Why the origin check is not an authenticity check. The iframe proxy serves the untrusted upstream on the same origin it grants the shim, so `e.origin` cannot tell a message the shim sent from one the page sent; what the check buys is that no *other* frame can send them at all. The shim's actions are bounded downstream — exiting passthrough, selecting a pane, an `http:`/`https:` URL behind an open prompt, a frame-URL reading that may lie, and read-only theme variables. Theme delivery additionally checks the actual iframe window; requesting it grants no host command. `use-wall-keyboard`'s leader channel accepts any live grant rather than one panel's, so a page in one browser pane can exit passthrough while another is focused. The nested-frame relay preserves this boundary: it accepts only the same proxy origin and reconstructs one of the three pane-level shapes, so document-level locations, unrelated application messages, and every foreign origin stop at the child frame.

Why "the standalone adapters" and not "the standalone webview". The Wall's two proxy-origin `message` listeners (`use-wall-keyboard.ts`, `IframePanel.tsx`) are bundled into the standalone webview as well as the VS Code one, so a framed page's `parent.postMessage` does reach that window. What has no forgeable inbox is the adapters' host channel, which arrives over Tauri IPC. `docs/specs/vscode.md` -> "Webview message authentication" scopes it the same way.

## The dor control socket

Why the socket's limit is stated rather than assumed. A `0700` directory and a `0600` file stop another local *account*; neither stops a process already running under the user's own uid, which can read the socket path out of its own environment. The same limit is already stated for the Burrow ACL store in `docs/specs/security-remote.md`, and stating it here keeps an agent holding `dor` from being read as a lesser principal than the person at the keyboard.

Why the proof construction being hand-mirrored matters. `proveToken` and `proofMatches` exist twice, in `standalone/sidecar/dor-control-server.js` and `dor/src/control-client.ts`, and only the two proof *domains* are pinned across the copies by `lib/src/lib/mirrored-constants.test.ts`. A change to the HMAC construction or the comparison in one copy breaks the channel loudly; a change that weakens the comparison in both — a string compare for a `timingSafeEqual` — breaks nothing visible.

What mutual proof buys. Whoever merely bound the path receives the client's nonce and a client proof tied to the squatter's challenge, but no token or Surface request. That proof is not replayable against the real server's fresh random challenge. The server proves knowledge of the token before the client releases its request; it does not prove itself before receiving the client proof.

Why a failed handshake gets no reply at all. A wrong answer and a port scan get the same nothing: any distinguishable response tells a prober a Dormouse control endpoint is at that path, exactly what the random name is spent hiding.

Why a lost bind withholds the token rather than exiting. PTY work has to survive a dead control channel, so exiting the host is not the answer. But a host that kept handing `DORMOUSE_CONTROL_TOKEN` to every shell after a failed bind would feed both clients and their bearer credential to whoever won the race for the path or pipe name. Withholding it degrades safely instead: nothing dials a stranger.

## Loopback Listeners

**What the browser gives an attacker page.** An ephemeral port is not a secret — the range scans in seconds. A POST with a simple content-type needs no preflight, so it *executes* even when the attacker cannot read the reply; and WebSockets are not subject to CORS at all, so a socket that connects is a socket that can be read.

**Why a URL token is not available to the iframe proxy.** It would land in `location.pathname` and break client-side routers, and it would not survive onto root-relative sub-resource requests at all. The browser-dev harness owns its page's URL, so it can carry one.

**Why no request header answers "who is allowed to frame me".** An iframe navigation carries no `Origin`, and `Sec-Fetch-Site` reads `cross-site` for our own webview and for an attacker page alike, so only an embedder named in `frame-ancestors` and enforced by the browser distinguishes them.

**Why the iframe proxy admits everyone.** Vouching for a stranger is what turns a transparent proxy into an amplifier, so it declines to vouch rather than to admit; refusing outright would be worse, because forwarding the caller's real `Origin` lets the upstream apply its own policy. That is also why the upgrade path matters most: a laundered `Origin` there does not merely let a stranger write, it hands them a readable socket to a dev server or `openvscode-server` that would have refused their real origin.

**How the proxy once handed a stranger two privileges.** Dropping an upstream's `X-Frame-Options` / CSP `frame-ancestors` for everyone gave a page that scanned the port two things the upstream had refused it: framing a document that answered `DENY`, and reading that document's live URL and anchor hrefs back cross-origin. No request header can tell that page apart from Dormouse's webview, which is why the replacement `frame-ancestors` has to name the embedder chain the webview supplied.

**Why same-grant framing is an accepted relaxation.** Storybook and similar apps put same-origin documents in nested frames, which an app-only policy blocks. The extra `'self'` source also permits a proxy page loaded top-level to frame another document from that grant, but one grant is one origin and one fixed upstream: those documents already share same-origin authority. A foreign page still appears in the ancestor chain and fails the policy, and a different grant has a different origin.

**Why the listener set is derived, not trusted.** An enumeration goes stale the moment someone adds a listener — the same failure mode that once left `.vscode/` owned by nobody.

**Why the webview gets one guarded viewer socket, never an upstream.** The webview once held a browser-level CDP socket from `get cdp-url` for a popped-out window's URL — `Runtime.evaluate` in any target, `file://` navigation — and in VS Code dialed a relay that piped raw bytes to any loopback port it named, with `Origin` dropped (review of the browser stack, 2026-09). The host now speaks each upstream's protocol itself and relays only parsed state, frames and rebuilt input, so a webview naming another loopback port gets nothing it could not already reach with its own `ws://127.0.0.1:*` `connect-src`. The listener checks `Host` as well as the token, like every listener built after the relay.

**Why the browser-dev bridge's content-type gate is a security control.** Without it the endpoint is CORS-simple and needs no preflight to survive, and what it dispatches is `pty_spawn` with caller-supplied `shell`, `args`, `cwd` and `env`.

Why proxy cookies are stripped in both directions. [RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5) scopes cookies by host, not port. An inbound cookie can therefore belong to another local service, including an HttpOnly credential, rather than the fixed upstream. Forwarding it leaks that credential; forwarding an upstream Set-Cookie lets even a remote HTTP target overwrite loopback cookies. The WebSocket handshake is HTTP too, including a refused upgrade. Parsing that handshake before piping bytes closes the same boundary without filtering WebSocket payloads.

The Vite listener serves modules containing the browser-dev bridge token. Vite's default CORS policy allows other localhost origins to read those modules (measured with Vite 8.3.0, 2026-09). Disabling CORS closes that read; the Host check separately blocks DNS rebinding, where the browser sees a same-origin request and CORS does not apply.

What header stripping cannot protect. A proxied script runs on `127.0.0.1` and can still read or write non-HttpOnly cookies through `document.cookie`, subject to browser partitioning. The per-grant port isolates origins, not cookie storage. Full isolation needs a separate browser storage context or host namespace; cookie-backed login in the iframe renderer cannot be preserved safely by forwarding ambient cookies.

## Network policy

**Why the outbound lint classifies files, not calls (2026-10).** Nowhere's promise had rested on the nightly audit reading the tree, and a call-site table found no automatic ungated connection. A textual lint cannot tell a guarded call from an unguarded one, but it can make every network primitive in shipped code a reviewed line with a class and a reason, so a new `fetch` in a component fails a build rather than waiting for an audit. Comments are stripped first, since the remote stack documents `RTCPeerConnection` and `node-datachannel` in prose far more than it calls them, and type-only imports name modules without loading them.

**Why the runtime suites hook the Node layer.** The service's own tests inject its transport, so they prove the guard and not the host wiring around it. Booting `createSidecarHost` and the VS Code glue with nothing injected, and recording at `net.Socket.prototype.connect`, `dns`, `http(s)`, `dgram`, and the addon's load as well as at the globals, catches a path that skips the guard, which a stubbed `fetch` alone would not. A mutation that drops managed voice's `networkAllowed` check, starts the Burrow under `nothing`, or loads the addon at boot each turns them red (2026-10-07).

**Why STUN and the phone rows are not driven.** Each needs a phone's Noise handshake through the relay before any peer is built; `one-time-runtime.test.ts` and the direct-path suites cover the choice of ICE server per level, and `scripts/e2e-lint.mjs` the server itself.

## Persisted state

Why the managed-voice token sits beside the Burrow's enrollment. It is the same class of secret — a revocable bearer credential for a Dormouse service — and that directory is the one `burrow_state_dir` already locks on Windows, where `writeJsonAtomic`'s modes are no-ops. A leaked token lets its holder spend the account's daily speak cap until it is revoked on the Hosted account page; it grants no terminal access.

Why session snapshots earn the strongest protection on disk. They are `PersistedWindow` blobs, and historically they carried terminal transcripts — whatever the user's shells printed, a superset of every other secret in the install — and they inherited the umask as `0644` until this was tightened. On Windows, without the DACL the directory keeps whatever `%LOCALAPPDATA%` hands down, which is never owner-only: always SYSTEM and Administrators, plus whatever stale entries earlier installs left behind. The mode goes on the temp file before any bytes are written because the atomic rename preserves it; tightening after the rename would leave a window where the transcript is world-readable.

What the current writers actually store. `normalizeSession` in `lib/src/lib/session-types.ts` destructures `scrollback` out of every pane on read and `saveSession` never emits it, so a snapshot standalone writes today carries structure only. What a pre-upgrade one carries is retired by the first save over it, or — for a `.json.tmp` no save will ever reach — by the boot sweep.

Why the peer-link token is listed here. It is a `randomUUID()` in the VS Code extension's global storage, and its own comment says it is the only thing between another local process and this installation's terminals — a local credential at rest that the remote spec's credentials table does not cover, because nothing about it is remote. Both of its controls are unix-only: `peerDirIsSafe()` returns true immediately on `win32`, and Node's `mode: 0o600` there touches only the read-only attribute, so unlike `remote_host_state_dir` no DACL work is done for it.

Why the standalone log is guarded at all. The socket path arrives via the sidecar's stderr, which Rust appends verbatim. Linux used to fall back to `env::temp_dir()`, which with `TMPDIR` unset is `/tmp` at `1777`, and still does without a usable `HOME`: another account could pre-plant `dormouse.log` as a symlink, which the truncating open followed, or as a world-writable file of its own, which then collected the log. Kernel `fs.protected_symlinks` / `fs.protected_regular` blunt both only where a distribution enables them (2026-10 audit, #1027). macOS's `$TMPDIR` is the per-user `/var/folders/.../T` at `0700` (measured 2026-09). The open is hardened as well as the directory moved because `$DORMOUSE_LOG_FILE` can point anywhere. `fchmod` on the opened handle doubles as the owner check: it fails on a file another account owns, so that file is refused rather than written. `rename` to `dormouse.previous.log` moves a planted symlink itself, never its target.

What the snapshot tests cover. `restrict_to_owner_leaves_one_owner_only_ace` is Windows-only and asserts `SE_DACL_PROTECTED`, one ACE, and the SID. `session_write_tightens_directory_and_existing_temp_file` exercises the unix writer against deliberately loose modes. The failure regression injects rejection at each permission stage, verifying the old snapshot survives and no replacement bytes reach disk. The single-ACE property depends on `FILE_ALL_ACCESS` rather than `GENERIC_ALL`, which would split into two ACEs.

## Local-file viewer

The viewer allows inline and granted scripts for interactive local reports. CSP fetch directives constrain resource requests, but do not prevent a script assigning an external URL to its own frame. `form-action` constrains form submissions, not arbitrary navigation. Preserving the policy through the proxy repairs the resource-load boundary; it does not establish that active documents cannot send granted contents outside the machine. [CSP3 navigation checks](https://www.w3.org/TR/CSP3/) and its multiple-policy rules distinguish these mechanisms.

Why a document cannot loosen mermaid (mermaid 11.17.2, read 2026-10). Its config `sanitize` deletes every key in `secure` (which holds `securityLevel` and `secure` itself) from each `%%{init}%%` directive before merging it, and `sanitizeDirective` drops any key outside the default config, which `dompurifyConfig` is not. Under `strict`, each label passes DOMPurify as the diagram is built, and the serialized SVG passes a final DOMPurify call whose options are fixed in `render`, never read from config, so a directive's `htmlLabels` changes layout, not what survives the final pass. `render` draws the SVG into a temporary element on the page's own `document.body` before that final pass, so the per-label pass is what covers that window.

## Spawned programs

Why a bare name runs a planted file. On Windows, libuv's `search_path` (Node's `spawn` and `execFile`) and cross-spawn's `which` both look in the working directory before `PATH` (`docs/specs/dor-cli.rationale.md` -> "Spawning External Binaries"). A 2026-10-07 review after the nightly audit found `powershell`, `netstat`, `clip`, and `explorer.exe` spawned by bare name in the sidecar and in VS Code's extension host and pty host, and `git` in `lib/src/host/git-cli.ts`; the pty host inherited the extension host's cwd, which can be a workspace folder. The tests assert the path each spawn receives, run off Windows; none of this was exercised on a Windows machine (2026-10).

## Dor Tool configuration

Why a string `run` and format characters are refused (2026-10). The trust prompt draws Tool text as the browser lays it out, while the shell receives the same text as typed input: a control can be invisible in the prompt yet act as a line-editing key, and a bidi control or zero-width character can make the drawn text differ from the bytes. Refusing them at parse keeps what the prompt shows equal to what runs, which escaping in the prompt alone would not, since the escaped text is not what a person approves running. A multi-line string `run` is refused with the rest because each line would submit separately; `&&` or `;` joins commands on one line. Arguments, substituted paths, the project path, and the upstream URL are refused only for controls and are shown with format characters escaped: they name a location rather than text a repo wrote, and ordinary names need some of them, such as U+200C in Persian spelling or U+200D in emoji.
