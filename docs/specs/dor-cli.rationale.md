# Dor CLI — Rationale

> Informative companion to [dor-cli.md](dor-cli.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Bundling And PATH

**What a missing `ELECTRON_RUN_AS_NODE` looks like.** Under VS Code `DORMOUSE_NODE` is the editor's Electron binary — Node only when that variable is set, and terminals routinely strip it from the ambient env. Without it Electron launches its GUI, ignores the script, and exits 0: no error, no output, success exit code, reading as "the command did nothing" rather than as a launcher bug.

**Why the standalone's bundled node is GUI-subsystem.** A console-subsystem node pops a stray terminal window every time Rust spawns the sidecar, so the bundled binary is patched to the GUI subsystem — and that same patch leaves it no console to inherit.

**What a verbatim path looks like.** cmd.exe fails with "The system cannot find the path specified.", naming neither the launcher nor the prefix that caused it. Tauri's `resource_dir()` returns a verbatim prefix in the bundled and dev layouts alike, so the standalone host strips it once at the boundary (`resolve_sidecar_path`) and every derived path stays plain.

**What an LF-only `dor.cmd` looks like.** cmd.exe misparses rather than refuses, dropping the leading character of every line — `setlocal` → `tlocal`, `if not` → `not` — so the launcher spews parse errors even on runs that otherwise work, and the noise points at the batch source rather than at line endings.

## Git Bash PATH survival

**Why stripping `ORIGINAL_PATH` saves the prepend.** `/etc/profile` rebuilds `PATH` from an exported `ORIGINAL_PATH` whenever that variable is already set, and the value the PTY inherits predates our prepend — so a login shell would silently restore a `PATH` with no staged `bin` on it. Removing it forces the shell to recapture the exact `PATH` handed to node-pty.

## Spawning External Binaries

**The two Windows spawn failures cross-spawn absorbs.** Node's `spawn` does not consult `PATHEXT`, so a bare `agent-browser` ENOENTs instead of resolving the `agent-browser.cmd` shim npm/vfox installs (on POSIX that file is a real executable with a shebang); and Node ≥22 refuses to spawn `.cmd`/`.bat` without a shell (the CVE-2024-27980 hardening), so the resolved absolute `.cmd` EINVALs too. Neither failure has a POSIX counterpart.

**What a missing `windowsHide` looks like.** cross-spawn routes `.cmd` shims through `cmd.exe`, which owns a real console window, and the browser panel's screenshot loop spawns one per stream-frame pulse — a live page flickers focus-stealing windows several times a second.

**Why none of the `exit`-vs-`close` trouble surfaced on macOS.** The `agent-browser` daemon double-forks and detaches from the inherited fds, so `close` fires normally; only on Windows, where the daemon holds the parent's stdout/stderr pipes for its whole life, does a `close`-only wait hang forever.

## Control-channel security

**Who the threat is.** Not the network — the channel is a local socket or named pipe. The attacker is a second account on the same box, or any process running as the user; interposing inherits the whole verb set at once — keystrokes in, screen and scrollback out, pane destroyed.

**Where the 8-byte socket name comes from.** macOS caps `sun_path` near 104 bytes and its `os.tmpdir()` already spends ~50, so the per-uid directory plus a 16-byte random component would not fit. Both spellings then use the same length; only the POSIX one is constrained.

**What the server-speaks-first handshake buys.** Whoever merely bound the path — won a race, squatted a Windows pipe name — learns two nonces and nothing else: no token, and no proof replayable against the real server. The other order would hand a squatter the client's proof before it had shown any of its own.

**Why a failed handshake gets no reply at all.** A wrong answer and a port scan get the same nothing: any distinguishable response tells a prober a Dormouse control endpoint is at that path, exactly what the random name is spent hiding.

**Why the token stops at the process that owns the server.** PTY work has to survive a dead control channel, so exiting the host is not the answer. But a host that kept handing `DORMOUSE_CONTROL_TOKEN` to every shell after a failed bind would feed both clients and their bearer credential to whoever won the race for the path or pipe name. Withholding it degrades safely instead: nothing dials a stranger.

## Current Implemented Commands

**What `dor list` replaced.** Two retired cmux-shaped commands, `list-panes` and `list-pane-surfaces`, plus `dor identify`, whose whole output became the top-level identity block of `dor list --json`. Collapsing all three into one listing is why new selection power goes into `dor list`'s filters rather than a second enumeration command.

**Why `dor await` prints no terminal text.** Mirroring `dor read` would drag its whole output-flag surface (`--lines`, mode selection) onto `await` and spend the one thing `await` has that composes cleanly: a stdout that is nothing but the cause, so `CAUSE=$(dor await …)` needs no parsing. `dor await … && dor read …` gets the screen back for one extra command.

## Browser Open Target Resolution

**Why the port, and not the hostname, picks `http`.** A public HTTPS site lives on 443 and is written without a port, whereas a bare `host:port` is overwhelmingly a dev or infra server — loopback, a LAN container, a Tailnet peer — and those speak `http`. The hostname carries no usable signal: `box.ts.net` is a private Tailnet peer and looks like any other domain, so the CLI does not try to classify it.

**Why a purely numeric "host" is rejected explicitly.** `new URL` accepts `800:600` and packs it into a bogus IPv4 rather than failing, so a resolution-looking argument would silently navigate somewhere real instead of erroring.

## Agent Skill

**The pointer-only stub was tried and was too soft.** A stub that only said "run `dor skill`" left agents skipping it and falling back to native subprocesses and their own browser tools — the two behaviors needing redirection *before* an agent would think to read the skill. Hence the same two directives in the stub itself and again at the top of `dor/skill.md`, so an agent that does run `dor skill` meets them up front.

**Why exactly those two directives and no more.** `dor ensure` and `dor ab` are foundational command names, the least likely `dor` facts to drift, so a stub built only from them stays correct without maintenance — the point of committing it to a repo nobody will revisit. Every extra fact is one more thing that can go stale in every clone.
