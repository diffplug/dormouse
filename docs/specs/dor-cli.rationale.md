# Dor CLI — Rationale

> Informative companion to [dor-cli.md](dor-cli.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Bundling And PATH

**What a verbatim path actually looks like.** `dor.cmd` is reached through `DORMOUSE_CLI_BIN` on `PATH`, and cmd.exe cannot execute a batch file via a `\\?\` path — it fails with "The system cannot find the path specified.", which names neither the launcher nor the prefix that caused it.

**What an LF-only `dor.cmd` looks like.** cmd.exe misparses the file rather than refusing it, dropping the leading character of every line: `setlocal` → `tlocal`, `if not` → `not`. So the launcher spews parse errors even on the runs where it otherwise works, and the noise points at the batch source rather than at line endings.

## Spawning External Binaries

**Why none of the `exit`-vs-`close` trouble surfaced on macOS.** The `agent-browser` daemon double-forks and detaches from the inherited fds, so the pipe closes and `close` fires normally. Only Windows, where the daemon keeps the parent's stdout/stderr pipes open for its whole life, turns a `close`-only wait into a permanent hang.

## Control-channel security

**Where the 8-byte socket name comes from.** macOS caps `sun_path` near 104 bytes and its `os.tmpdir()` already spends ~50 of them, so the per-uid directory plus a longer random component would not fit. Both spellings then use the same length; only the POSIX one is actually constrained.

**Why a failed handshake gets no reply at all.** A wrong answer and a port scan deserve the same nothing: any distinguishable response tells a prober that a Dormouse control endpoint is at that path, which is exactly what the random name is spent on hiding.

## Current Implemented Commands

**What `dor list` replaced.** It subsumed two retired cmux-shaped commands, `list-panes` and `list-pane-surfaces`, plus `dor identify`, whose whole output became the top-level identity block of `dor list --json`. Collapsing all three into one listing is why new selection power goes into `dor list`'s filters rather than into a second enumeration command.

**Why `dor await` prints no terminal text.** Mirroring `dor read` would drag its whole output-flag surface (`--lines`, mode selection) onto `await`, and would spend the one thing `await` has that composes cleanly: a stdout that is nothing but the cause, so `CAUSE=$(dor await …)` needs no parsing. `dor await … && dor read …` gets the screen back for one extra command.

## Browser Open Target Resolution

**Why the port, and not the hostname, picks `http`.** A public HTTPS site lives on 443 and is written without a port, whereas a bare `host:port` is overwhelmingly a dev or infra server — loopback, a LAN container, a Tailnet peer — and those speak `http`. The hostname carries no usable signal: `box.ts.net` is a private Tailnet peer and looks like any other domain, so the CLI does not try to classify it. That leaves exactly one case needing the scheme typed by hand: a public HTTPS service on a nonstandard port.

## Agent Skill

**The pointer-only stub was tried and was too soft.** A stub that only said "run `dor skill`" left agents skipping it and falling back to native subprocesses and their own browser tools — the two behaviors that have to be redirected *before* an agent would think to read the skill. Hence the two mandatory directives in the stub itself, duplicated at the top of `dor/skill.md`.
