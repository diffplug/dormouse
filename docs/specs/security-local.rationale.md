# Local Security — rationale

## Terminal output

What the `OSC 52` strip actually buys. The pinned `@xterm/xterm` registers OSC
handlers for 0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111 and 112 only — no 52 — and
no clipboard addon is a dependency, so an `OSC 52` reaching xterm today would be
discarded rather than acted on. Dormouse's strip is therefore the barrier it
controls, not the only one standing; xterm's handler table is not ours to keep,
and an addon or a version bump could add 52 without a diff here.

Why the OSC 633 command line carries two bounds. `COMMAND_LINE_LIMIT` (2048) is
applied by `sanitizeText` *after* `decodeOsc633Value`, because the `\xNN`
unescape re-introduces the control characters the emit side removed. A 4x bound
holds the raw value before the unescape, so an emitter cannot make the decoder do
unbounded work on the way to that cap.

Why fail-inertly is a rule and not an aspiration. Dormouse reports an
iTerm2-compatible identity to unlock the iTerm2-style sequences it does
implement, so emitters offer it many more than it models; every one of those
arrives from an untrusted program, and the only safe disposition for a sequence
with no behavior behind it is silence.

Why the `OSC 633` terminator filter is emit-side. The parser scans raw bytes for
the three terminators `findOscTerminator` knows — `BEL`, `ESC \`, the C1 ST — so
a directory name or command line carrying one ends the `633` sequence early and
the remainder arrives as a fresh, fully trusted OSC. Nothing the parser can do
distinguishes that from an emitter that meant it, which is why the boundary is in
the scripts Dormouse ships. `lib/src/lib/terminal-protocol.test.ts` proves the
parser *cannot* defend it: for each of the three terminators it forges an
`OSC 9` notification with the body `PWNED` through an unfiltered `Cwd=`.

Why the deceptive verdict needs the component read rather than a test reference.
`ExternalLinkModalHost` gates its open call on the URI's `openable` status alone,
and a deceptive link is still openable; the only thing withholding the open
action is which buttons `ExternalLinkModal` renders. No test asserts that
absence, so the property is one render change away from being lost silently.

## Browser panes

Why the origin check is not an authenticity check. The iframe proxy serves the
untrusted upstream on the same origin it grants the shim, so `e.origin` cannot
tell a message the shim sent from one the page sent; what the check buys is that
no *other* frame can send them at all. The four shim messages are bounded
downstream instead — exiting passthrough, selecting a pane, an `http:`/`https:`
only `browserSurfaceUrl` behind an open prompt, and a frame-URL reading that may
lie. `use-wall-keyboard`'s leader channel accepts any live grant rather than one
panel's, so a page in one browser pane can exit passthrough while another is
focused. The nested-frame relay preserves this boundary: it accepts only the
same proxy origin and reconstructs one of those four shapes, so unrelated
application messages and every foreign origin stop at the child frame.

Why "the standalone adapters" and not "the standalone webview". The Wall's two
proxy-origin `message` listeners (`use-wall-keyboard.ts`, `IframePanel.tsx`) are
bundled into the standalone webview as well as the VS Code one, so a framed
page's `parent.postMessage` does reach that window. What has no forgeable inbox
is the adapters' host channel, which arrives over Tauri IPC.
`docs/specs/vscode.md` -> "Webview message authentication" scopes it the same
way.

## The dor control socket

Why "a process running as the user is the user" is stated rather than assumed. A
`0700` directory and a `0600` file stop another local *account*; neither stops a
process already running under the user's own uid, which can read the socket path
out of its own environment. The same limit is already stated for the Host ACL
store in `docs/specs/security-remote.md`, and stating it here keeps an agent
holding `dor` from being read as a lesser principal than the person at the
keyboard. Note that `docs/specs/dor-cli.rationale.md` names "any process running
as the user" among the attackers the control channel defends against, which the
mechanism does not support; one of the two needs correcting.

Why the proof construction being hand-mirrored matters. `proveToken` and
`proofMatches` exist twice, in `standalone/sidecar/dor-control-server.js` and
`dor/src/control-client.ts`, and only the two proof *domains* are pinned across
the copies by `lib/src/lib/mirrored-constants.test.ts`. A change to the HMAC
construction or the comparison in one copy breaks the channel loudly; a change
that weakens the comparison in both — a string compare for a `timingSafeEqual` —
breaks nothing visible.

Where the directory check actually runs. `ensureControlDir` is called once, from
`resolveControlSocketPath` inside `createDorControlServer`, at host start-up —
not on every use. `docs/specs/dor-cli.md` -> "Control-channel security" says
"re-checked on every use", which is true of the peer link's `peerDirIsSafe()`
(re-run per contention round) and not of this one. The bind is what the
channel's life depends on, so a check before the bind is the load-bearing one,
but the two specs should agree.

## Loopback Listeners

**What the browser gives an attacker page.** An ephemeral port is not a secret — the
range scans in seconds. A POST with a simple content-type needs no preflight, so it
*executes* even when the attacker cannot read the reply; and WebSockets are not subject
to CORS at all, so a socket that connects is a socket that can be read.

**Why a URL token is not available to the iframe proxy.** It would land in
`location.pathname` and break client-side routers, and it would not survive onto
root-relative sub-resource requests at all. The browser-dev harness owns its page's URL,
so it can carry one.

**Why no request header answers "who is allowed to frame me".** An iframe navigation
carries no `Origin`, and `Sec-Fetch-Site` reads `cross-site` for our own webview and for
an attacker page alike, so only an embedder named in `frame-ancestors` and enforced by
the browser distinguishes them.

**Why the iframe proxy admits everyone.** Vouching for a stranger is what turns a
transparent proxy into an amplifier, so it declines to vouch rather than to admit;
refusing outright would be worse, because forwarding the caller's real `Origin` lets
the upstream apply its own policy. That is also why the upgrade path matters most: a
laundered `Origin` there does not merely let a stranger write, it hands them a readable
socket to a dev server or `openvscode-server` that would have refused their real
origin.

**How the proxy once handed a stranger two privileges.** Dropping an upstream's
`X-Frame-Options` / CSP `frame-ancestors` for everyone gave a page that scanned the
port two things the upstream had refused it: framing a document that answered `DENY`,
and reading that document's live URL and anchor hrefs back cross-origin. No request
header can tell that page apart from Dormouse's webview, which is why the replacement
`frame-ancestors` has to name the embedder chain the webview supplied.

**Why same-grant framing is an accepted relaxation.** Storybook and similar apps put
same-origin documents in nested frames, which an app-only policy blocks. The extra
`'self'` source also permits a proxy page loaded top-level to frame another document
from that grant, but one grant is one origin and one fixed upstream: those documents
already share same-origin authority. A foreign page still appears in the ancestor
chain and fails the policy, and a different grant has a different origin.

**Why the listener set is derived, not trusted.** An enumeration goes stale the moment
someone adds a listener — the same failure mode that once left `.vscode/` owned by
nobody.

**Why the stream relay needs no `Host` check.** Rebinding exists to make
same-origin-looking requests to loopback, which buys nothing against a listener
demanding an unguessable one-shot secret.

**Why the browser-dev bridge's content-type gate is a security control.** Without it
the endpoint is CORS-simple and needs no preflight to survive, and what it dispatches
is `pty_spawn` with caller-supplied `shell`, `args`, `cwd` and `env`.

## Persisted state

Why session snapshots earn the strongest protection on disk. They are
`PersistedWindow` blobs, and historically they carried terminal transcripts —
whatever the user's shells printed, a superset of every other secret in the
install — and they inherited the umask as `0644` until this was tightened. On
Windows, without the DACL the directory keeps whatever `%LOCALAPPDATA%` hands
down, which is never owner-only: always SYSTEM and Administrators, plus whatever
stale entries earlier installs left behind. The mode goes on the temp file before
any bytes are written because the atomic rename preserves it; tightening after
the rename would leave a window where the transcript is world-readable.

What the current writers actually store. `normalizeSessionV3` in
`lib/src/lib/session-types.ts` destructures `scrollback` out of every pane on
read, `saveSession` never emits it, and standalone's `PERSIST_SESSION` is
`false`, so the shipped app writes no snapshot at all and clears a legacy one at
boot. `docs/specs/standalone.md` -> "Persistence" and the `restrict_to_owner`
doc comment in `standalone/src-tauri/src/lib.rs` both still say the blob carries
transcripts; that is true of files older versions left behind and false of
anything written now.

Why the peer-link token is listed here. It is a `randomUUID()` in the VS Code
extension's global storage, and its own comment says it is the only thing between
another local process and this installation's terminals — a local credential at
rest that the remote spec's credentials table does not cover, because nothing
about it is remote. Both of its controls are unix-only: `peerDirIsSafe()` returns
true immediately on `win32`, and Node's `mode: 0o600` there touches only the
read-only attribute, so unlike `remote_host_state_dir` no DACL work is done for
it.

Where the standalone log is actually exposed. `env::temp_dir()` honors `TMPDIR`,
which on macOS is the per-user `/var/folders/.../T` directory at `0700`, so the
umask does not matter there (measured on a macOS host, 2026-09). The exposure is
Linux with `TMPDIR` unset — `/tmp` at `1777` — and wherever an operator points
`$DORMOUSE_LOG_FILE`. `init_log` truncates the file and `log_file` appends to it;
neither sets a mode, and `restrict_to_owner` is never called on it. The socket
path arrives via the sidecar's stderr, which Rust appends verbatim.

What the Windows session-snapshot test does and does not cover.
`restrict_to_owner_leaves_one_owner_only_ace` is `#[cfg(windows)]`, runs in CI's
`standalone-platform-check` matrix, and asserts `SE_DACL_PROTECTED`, an ACE count
of one, and the SID — but it calls `restrict_to_owner` directly. Nothing asserts
the unix modes, and nothing exercises `write_session_to`'s two calls: deleting
either leaves the suite green on every platform. The single-ACE property also
depends on `FILE_ALL_ACCESS` rather than `GENERIC_ALL`, which would split into
two ACEs.
