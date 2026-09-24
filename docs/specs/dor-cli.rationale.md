# Dor CLI — Rationale

> Informative companion to [dor-cli.md](dor-cli.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Bundling And PATH

The file viewer needs Node types, but the renderer imports CLI protocol and shell helpers as values. A browser-platform bundle check rejects Node imports in those helpers and their dependencies without splitting the CLI into separate TypeScript projects.

**What a missing `ELECTRON_RUN_AS_NODE` looks like.** Under VS Code `DORMOUSE_NODE` is the editor's Electron binary — Node only when that variable is set, and terminals routinely strip it from the ambient env. Without it Electron launches its GUI, ignores the script, and exits 0: no error, no output, success exit code, reading as "the command did nothing" rather than as a launcher bug.

**Why the standalone's bundled node is GUI-subsystem.** A console-subsystem node pops a stray terminal window every time Rust spawns the sidecar, so the bundled binary is patched to the GUI subsystem — and that same patch leaves it no console to inherit.

**What a verbatim path looks like.** cmd.exe fails with "The system cannot find the path specified.", naming neither the launcher nor the prefix that caused it. Tauri's `resource_dir()` returns a verbatim prefix in the bundled and dev layouts alike, so the standalone host strips it once at the boundary (`resolve_sidecar_path`) and every derived path stays plain.

**What an LF-only `dor.cmd` looks like.** cmd.exe misparses rather than refuses, dropping the leading character of every line — `setlocal` → `tlocal`, `if not` → `not` — so the launcher spews parse errors even on runs that otherwise work, and the noise points at the batch source rather than at line endings.

## Git Bash PATH survival

**Why stripping `ORIGINAL_PATH` saves the prepend.** `/etc/profile` rebuilds `PATH` from an exported `ORIGINAL_PATH` whenever that variable is already set, and the value the PTY inherits predates our prepend — so a login shell would silently restore a `PATH` with no staged `bin` on it. Removing it forces the shell to recapture the exact `PATH` handed to node-pty.

## Spawning External Binaries

**The two Windows spawn failures cross-spawn absorbs.** Node's `spawn` does not consult `PATHEXT`, so a bare `agent-browser` ENOENTs instead of resolving the `agent-browser.cmd` shim npm/vfox installs (on POSIX that file is a real executable with a shebang); and Node ≥22 refuses to spawn `.cmd`/`.bat` without a shell (the CVE-2024-27980 hardening), so the resolved absolute `.cmd` EINVALs too. Neither failure has a POSIX counterpart.

**Why the bare name is a code-execution primitive on Windows.** cross-spawn
delegates resolution to `which`, whose Windows branch prepends `process.cwd()`
to the search path (`which@2.0.2/which.js:19-21`, comment *"windows always
checks the cwd first"*), and its `.cmd`-shim path re-emits the **bare** name
into `cmd.exe` (`cross-spawn@7.0.6/lib/parse.js:36,48-59`), which resolves the
cwd first as well. `dor` inherits the pane's cwd, so before this rule a cloned
repository containing `agent-browser.cmd` executed on the next `dor ab` — and
`dor skill` mandates `dor ab` for every page view. The 2026-09-19 security audit
([run 35432996343](https://github.com/diffplug/dormouse/actions/runs/35432996343))
raised it as its one BLOCKER: the hijack needs a *legitimate* install present,
because `browserBinaryIsMissing` refuses to spawn when the PATH walk finds
nothing. The same audit named three sidecar sites spawning system binaries by
bare name (`standalone/sidecar/pty-core.js`, `standalone/sidecar/clipboard-ops.js`)
whose cwd is the app directory rather than a user's repository;
`pty-core.js`'s `%SystemRoot%\System32` join is the pattern those should follow.

**What promoting the walk to the spawn target changed.** Before it, the walk
only proved the install present and travelled to the host as a hint, so its
divergence from `which` was inert: a fixed `.cmd`/`.exe`/`.bat` order and a bare
`existsSync`. Once it decides what runs, both diverge observably — a directory
holding `agent-browser.exe` and `agent-browser.cmd` would switch which one runs,
and a non-executable file or directory named `agent-browser` earlier on `PATH`
would fail EACCES/EISDIR where `which` walked past it to the real install (that
one is not Windows-specific). A second round found that `which@2`'s fallback list
is npm's `.EXE;.CMD;.BAT;.COM` rather than `cmd.exe`'s `.COM;.EXE;.BAT;.CMD`, so
copying the shell's order inverts `.com`-vs-`.exe` and `.bat`-vs-`.cmd`; that
`which` uses `||` rather than `??` for it, so an empty `PATHEXT` falls back
instead of yielding no candidates; and that it unshifts an empty extension when
the command contains a `.`, so `agent-browser.exe` is searched as itself. All
four are `getPathInfo` in `which/which.js`, read at 2.0.2. A third round caught
the invariant stating the opposite of the fix in the case that motivated it —
`which`'s Windows branch prepends `process.cwd()`, so an unscoped "select the
file `which` would" licenses the hijack — and that the X_OK probe was unpinned
because `statSync().isFile()` already rejected the directory the test shadowed
with. All three rounds were review findings on the fix, before it merged.

**What a missing `windowsHide` looks like.** cross-spawn routes `.cmd` shims through `cmd.exe`, which owns a real console window, and the browser panel's screenshot loop spawns one per stream-frame pulse — a live page flickers focus-stealing windows several times a second.

**Why none of the `exit`-vs-`close` trouble surfaced on macOS.** The `agent-browser` daemon double-forks and detaches from the inherited fds, so `close` fires normally; only on Windows, where the daemon holds the parent's stdout/stderr pipes for its whole life, does a `close`-only wait hang forever.

**Why byte chunks are not text boundaries.** In a subprocess regression on
macOS in 2026-09, writing the bytes of `🐭` and `€` across separate pipe chunks
produced `���` on both streams when each chunk was converted with `String`.
Node's stream decoder holds incomplete UTF-8 sequences until the next chunk;
the caller receives the command's text regardless of pipe chunking.

**Why settling the promise does not finish the CLI.** A subprocess reproduction
on macOS in 2026-09 resolved capture at 279 ms but kept its caller alive until a
pipe-inheriting descendant exited at 3054 ms. The `dor` entry point sets
`process.exitCode` rather than forcing exit, so open read handles defeat the
exit-grace fallback. In the long-lived host, their data listeners also keep
appending daemon output after the result is immutable. Neither caller reads
those bytes; capture owns the read ends and releases them at settlement.

**The daemon owns its remaining output lifetime.** Agent-browser 0.31.1 already
expects its spawning CLI to drop the read end after startup: its
[daemon setup](https://github.com/vercel-labs/agent-browser/blob/v0.31.1/cli/src/native/daemon.rs)
redirects Unix stderr to a log or `/dev/null`, and daemon diagnostics discard
write errors. Closing capture's read ends does not signal or kill descendants;
a descendant that continues writing must tolerate a closed output sink.

## Control-channel security

**Who the threat is.** Not the network — the channel is a local socket or named pipe. The attacker is a second account on the same box, or any process running as the user; interposing inherits the whole verb set at once — keystrokes in, screen and scrollback out, pane destroyed.

**Where the 8-byte socket name comes from.** macOS caps `sun_path` near 104 bytes and its `os.tmpdir()` already spends ~50, so the per-uid directory plus a 16-byte random component would not fit. Both spellings then use the same length; only the POSIX one is constrained.

**What mutual proof buys.** Whoever merely bound the path receives the client's
nonce and a client proof tied to the squatter's challenge, but no token or
Surface request. That proof is not replayable against the real server's fresh
random challenge. The server proves knowledge of the token before the client
releases its request; it does not prove itself before receiving the client proof.

**Why a failed handshake gets no reply at all.** A wrong answer and a port scan get the same nothing: any distinguishable response tells a prober a Dormouse control endpoint is at that path, exactly what the random name is spent hiding.

**Why the token stops at the process that owns the server.** PTY work has to survive a dead control channel, so exiting the host is not the answer. But a host that kept handing `DORMOUSE_CONTROL_TOKEN` to every shell after a failed bind would feed both clients and their bearer credential to whoever won the race for the path or pipe name. Withholding it degrades safely instead: nothing dials a stranger.

## Current Implemented Commands

**What `dor list` replaced.** Two retired cmux-shaped commands, `list-panes` and `list-pane-surfaces`, plus `dor identify`, whose whole output became the top-level identity block of `dor list --json`. Collapsing all three into one listing is why new selection power goes into `dor list`'s filters rather than a second enumeration command.

**Why `dor await` prints no terminal text.** Mirroring `dor read` would drag its whole output-flag surface (`--lines`, mode selection) onto `await` and spend the one thing `await` has that composes cleanly: a stdout that is nothing but the cause, so `CAUSE=$(dor await …)` needs no parsing. `dor await … && dor read …` gets the screen back for one extra command.

## Browser Surface Addressing

**Why the bind waits past the host's browser request timeout.** `surface.browser` answers only once the host has asked the browser where it streams, and that `attach` queues behind any launch, relaunch or close of the same browser, which can take the host's whole budget. At the client's default 5 s deadline, a command run just after a pop-out printed "could not open the Dormouse browser surface … timed out" and the pane bound anyway; agents read stderr, so the warning misled them (review of #777, 2026-09).

## Browser Open Target Resolution

**Why the port, and not the hostname, picks `http`.** A public HTTPS site lives on 443 and is written without a port, whereas a bare `host:port` is overwhelmingly a dev or infra server — loopback, a LAN container, a Tailnet peer — and those speak `http`. The hostname carries no usable signal: `box.ts.net` is a private Tailnet peer and looks like any other domain, so the CLI does not try to classify it.

**Why a purely numeric "host" is rejected explicitly.** `new URL` accepts `800:600` and packs it into a bogus IPv4 rather than failing, so a resolution-looking argument would silently navigate somewhere real instead of erroring.

## Agent Skill

**The pointer-only stub was tried and was too soft.** A stub that only said "run `dor skill`" left agents skipping it and falling back to native subprocesses and their own browser tools — the two behaviors needing redirection *before* an agent would think to read the skill. Hence the same two directives in the stub itself and again at the top of `dor/skill.md`, so an agent that does run `dor skill` meets them up front.

**Why exactly those two directives and no more.** `dor ensure` and `dor ab` are foundational command names, the least likely `dor` facts to drift, so a stub built only from them stays correct without maintenance — the point of committing it to a repo nobody will revisit. Every extra fact is one more thing that can go stale in every clone.
