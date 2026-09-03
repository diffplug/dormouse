# Dor CLI — Rationale

> Informative companion to [dor-cli.md](dor-cli.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Bundling And PATH

**What a missing `ELECTRON_RUN_AS_NODE` looks like.** Under VS Code `DORMOUSE_NODE` is the editor's Electron binary, which behaves as Node only when that variable is set, and terminals routinely strip it from the ambient env. Without it Electron launches its GUI, ignores the script, and exits 0 — so `dor` fails with no error, no output, and a success exit code, which reads as "the command did nothing" rather than as a launcher bug.

**Why the standalone's bundled node is GUI-subsystem in the first place.** A console-subsystem node pops a stray terminal window every time Rust spawns the sidecar, so the bundled binary is patched to the GUI subsystem. That patch is exactly what makes it unusable as `DORMOUSE_NODE`: a GUI-subsystem node has no console to inherit and drops all stdout/stderr under a shell's ConPTY.

**What a verbatim path actually looks like.** `dor.cmd` is reached through `DORMOUSE_CLI_BIN` on `PATH`, and cmd.exe cannot execute a batch file via a `\\?\` path — it fails with "The system cannot find the path specified.", which names neither the launcher nor the prefix that caused it. Tauri's `resource_dir()` returns a verbatim prefix in the bundled and dev layouts alike, so the standalone host strips it once at the boundary (`resolve_sidecar_path`) and every derived path stays plain.

**What an LF-only `dor.cmd` looks like.** cmd.exe misparses the file rather than refusing it, dropping the leading character of every line: `setlocal` → `tlocal`, `if not` → `not`. So the launcher spews parse errors even on the runs where it otherwise works, and the noise points at the batch source rather than at line endings.

## Git Bash PATH survival

**Why stripping `ORIGINAL_PATH` is what saves the prepend.** `/etc/profile` rebuilds `PATH` from an exported `ORIGINAL_PATH` whenever that variable is already set, and the value the PTY inherits predates our prepend — so a Git Bash login shell would silently restore a `PATH` with no staged `bin` on it. Removing the variable from the child env forces the shell to recapture the exact `PATH` handed to node-pty instead.

## Spawning External Binaries

**The two Windows spawn failures cross-spawn absorbs.** Node's `spawn` does not consult `PATHEXT`, so a bare `agent-browser` ENOENTs instead of resolving the `agent-browser.cmd` PATH shim npm/vfox installs (on POSIX the file is a real executable with a shebang); and Node ≥22 refuses to spawn `.cmd`/`.bat` without a shell (the CVE-2024-27980 hardening), so spawning the resolved absolute `.cmd` EINVALs too. Neither route works, and neither failure has a POSIX counterpart.

**What a missing `windowsHide` looks like.** cross-spawn runs `.cmd` shims through `cmd.exe`, and the browser panel's screenshot loop spawns one per stream-frame pulse — so a live page flickers focus-stealing console windows several times a second.

**Why none of the `exit`-vs-`close` trouble surfaced on macOS.** The `agent-browser` daemon double-forks and detaches from the inherited fds, so the pipe closes and `close` fires normally. Only Windows, where the daemon keeps the parent's stdout/stderr pipes open for its whole life, turns a `close`-only wait into a permanent hang.

## Control-channel security

**Who the threat actually is.** Not the network — the channel is a local socket or named pipe. It is another principal on the same box (a second account, or any process running as the user) that gets between `dor` and its host and thereby inherits the whole surface API: typing arbitrary keystrokes into any pane, reading its screen and scrollback back out, destroying it.

**Where the 8-byte socket name comes from.** macOS caps `sun_path` near 104 bytes and its `os.tmpdir()` already spends ~50 of them, so the per-uid directory plus a longer random component would not fit. Both spellings then use the same length; only the POSIX one is actually constrained.

**What the server-speaks-first handshake buys.** Whoever merely bound the path — having won a race, or squatted a Windows pipe name — learns two nonces and nothing else: no token, and no proof it can replay against the real server. Ordering it the other way would hand a squatter the client's proof before it had shown any of its own.

**Why a failed handshake gets no reply at all.** A wrong answer and a port scan deserve the same nothing: any distinguishable response tells a prober that a Dormouse control endpoint is at that path, which is exactly what the random name is spent on hiding.

**Why the token must stop at the process that owns the server.** PTY work has to survive a dead control channel, so exiting the host is not the answer. But a host that kept handing `DORMOUSE_CONTROL_TOKEN` to every shell after a failed bind would be feeding both clients and their bearer credential to whoever won the race for the path or pipe name. Withholding the credential is the only response that degrades safely: `dor` reports the endpoint unavailable, and nothing dials a stranger.

## Current Implemented Commands

**What `dor list` replaced.** It subsumed two retired cmux-shaped commands, `list-panes` and `list-pane-surfaces`, plus `dor identify`, whose whole output became the top-level identity block of `dor list --json`. Collapsing all three into one listing is why new selection power goes into `dor list`'s filters rather than into a second enumeration command.

**Why `dor await` prints no terminal text.** Mirroring `dor read` would drag its whole output-flag surface (`--lines`, mode selection) onto `await`, and would spend the one thing `await` has that composes cleanly: a stdout that is nothing but the cause, so `CAUSE=$(dor await …)` needs no parsing. `dor await … && dor read …` gets the screen back for one extra command.

## Browser Open Target Resolution

**Why the port, and not the hostname, picks `http`.** A public HTTPS site lives on 443 and is written without a port, whereas a bare `host:port` is overwhelmingly a dev or infra server — loopback, a LAN container, a Tailnet peer — and those speak `http`. The hostname carries no usable signal: `box.ts.net` is a private Tailnet peer and looks like any other domain, so the CLI does not try to classify it. That leaves exactly one case needing the scheme typed by hand: a public HTTPS service on a nonstandard port.

**Why a purely numeric "host" has to be rejected explicitly.** `new URL` accepts `800:600` and packs it into a bogus IPv4 rather than failing, so an accidental resolution-looking argument would silently navigate somewhere real instead of erroring.

## Agent Skill

**The pointer-only stub was tried and was too soft.** A stub that only said "run `dor skill`" left agents skipping it and falling back to native subprocesses and their own browser tools — the two behaviors that have to be redirected *before* an agent would think to read the skill. Hence the two mandatory directives in the stub itself, duplicated at the top of `dor/skill.md` so an agent that does run `dor skill` meets them again up front.

**Why exactly those two directives and no more.** `dor ensure` and `dor ab` are foundational command names, the least likely `dor` facts to ever drift; a stub built only from them stays correct without maintenance, which is the whole point of committing it to a repo where nobody will revisit it. Every additional fact would be one more thing that can go stale in a file that travels with the clone.
