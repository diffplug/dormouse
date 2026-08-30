# Terminal Escapes — Rationale

> Informative companion to [terminal-escapes.md](terminal-escapes.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

The registry itself is almost entirely normative — every table row, strip/pass-through/answer semantic, and replay-filter rule is a rule, not evidence — so this file is short by design. Only two of its rules carry a narrative worth keeping out of the spec body.

## OSC color queries on Windows require the bundled ConPTY

**Two ConPTY backends, one of which eats the query.** OSC 10/11/12 answering only works if the program's query actually reaches the consumer, and on Windows that is decided entirely by which ConPTY backend node-pty spawns with. The in-box `CreatePseudoConsole` swallows color queries silently: they never reach the consumer, so nothing can answer, and a background-detecting TUI is left assuming a dark terminal. node-pty's bundled OpenConsole (`conpty.dll`) forwards them instead — the same passthrough Windows Terminal itself relies on, which is the reason the extra prebuilds are worth their packaging cost on both distributions.

## Shell-integration injection

**Why the emit-side filter is a security boundary and not tidiness.** Once an attacker-chosen directory name or command line closes the `633` sequence early, the remainder arrives as a fresh OSC that the parser trusts completely — and `OSC 9` is the most damaging thing to forge there, because an alert latches a ring, persists, is spoken aloud, and is pushed to the paired phone. The attack is also invisible and durable: the injected bytes are consumed by the parser, so nothing appears on screen, and a poisoned directory re-fires for everyone who enters it, outliving the process that planted it.
