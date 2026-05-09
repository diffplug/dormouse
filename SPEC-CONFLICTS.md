# Spec conflicts in `docs/specs/` (HEAD vs main)

Audit of the changed regions in `iTerm2.md`, `layout.md`, `terminal-state.md` (new), and `vscode.md`.

## Substantive conflicts

### 1. `ShellActivity` (5 kinds) ≠ `DerivedHeader.status` / status grouping (4 values)

`terminal-state.md`:

- `ShellActivity.kind`: `unknown | prompt | editing | running | finished` (line 48–53).
- `DerivedHeader.status`: `"unknown" | "idle" | "running" | "finished"` (line 189).
- Status grouping (line 225): `unknown | idle | running | finished`.

`prompt` and `editing` collapse to `idle` somewhere, but the spec never states that mapping. Two different vocabularies for the same axis.

### 2. Header-derivation rules don't form a clean priority chain

`terminal-state.md` line 194–204 vs `layout.md`.

`layout.md` lays out a clean order: *user-pinned → app-sent override → current/freshly-finished command → `<idle>`*.

But the bullets in `terminal-state.md` contradict that:

- "A freshly finished command uses `lastCommand.displayCommand` until the next prompt signal." — no override carve-out, even though the bullet above grants override precedence.
- "Idle terminals use `<idle>` unless a user-pinned title exists." — omits the app-sent override case entirely.

Read literally, an app-sent OSC 9 on an idle pane would be ignored (idle rule wins), and an override during `lastCommand` would be ignored (finished rule wins). Both contradict `layout.md`'s priority list.

### 3. OSC 9 title-override timing is stated three different ways

- `iTerm2.md` prose: "Legacy `OSC 9` message text also participates in pane header/door title derivation as an app-sent title override" — unconditional.
- `iTerm2.md` table: "may override the pane header/door label" — conditional, condition unstated.
- `layout.md` and `terminal-state.md`: only OSC 9 / OSC 0/2 "emitted **after the current command started**" are overrides; "Older shell titles remain fallback-only."

These three need to agree, and the timing condition itself is underdefined: what about an OSC 9 emitted while running, after the command has now finished (i.e., `lastCommand` is set)? `layout.md`'s priority list says the override still beats the finished-command title, but `terminal-state.md`'s reducer/rules don't say when an override expires. Does it survive the next `commandStart`? Next prompt? Forever?

### 4. `pty:data` strip semantics conflict with the "streaming parser" description

`vscode.md` vs `iTerm2.md`.

`vscode.md` (changed) now says `pty:data` is "PTY output **after supported OSC sequences have been parsed/stripped**" and adds a separate `terminal:semanticEvents` message for the parsed events.

But `iTerm2.md` (changed) describes "**The same streaming parser**" recognizing OSC 7/9;9/633/1337/133/0/2 — this parser, in the surrounding spec context, is the webview parser. If the extension host has already stripped those sequences from `pty:data`, the webview's "same streaming parser" never sees them in live data, only in `pty:replay`.

Either the parser exists in two places (under-specified), or one of these two specs is wrong about who parses what. As written, "the same streaming parser also recognizes" is misleading.

### 5. Dead/unreferenced enum values

- `CommandRun.source` (line 67–73) declares `"foreground_process"` and `"title"`, but no rule, table row, or fallback in the document produces them.
- `CwdState.source` (line 40) declares `"manual"`, with no production rule. CWD fallback step 3 ("initial launch or restored directory") is the most likely candidate, but it's never tied to the `manual` value.
- `TerminalTitle.source` (line 84–93) declares `"notification"`, `"profile"`, and `"derived"` — none of these are produced by any documented event, none appear in the `titleCandidates` tables in `iTerm2.md`, and none are listed in `layout.md`'s right-click popup channels.

### 6. Disambiguator coverage is inconsistent

- `layout.md`: "running command's `cwdAtStart` or the idle pane's latest `cwd`" — only running and idle.
- `terminal-state.md`: running **and finished** use `cwdAtStart`; idle uses `pane.cwd`.
- Neither covers `unknown`-kind panes, even though `unknown` is a first-class status.

`layout.md` silently drops the "finished" case.

### 7. Right-click popup channels (6) ≠ `TerminalTitle.source` enum (9)

`layout.md` says the diagnostic popup lists "user, OSC 0, OSC 2, OSC 9, OSC 99, and OSC 777 where present." The type allows three more (`notification`, `profile`, `derived`). Either the popup is exhaustive (and the enum has dead values), or the enum is right (and the popup spec is incomplete).

### 8. Resume seeding: `non-unnamed` filter only on one side

`vscode.md` vs `layout.md`.

- `vscode.md`: "seeds any **non-unnamed** saved pane or door titles as user titles."
- `layout.md`: "seed any saved pane or door title as the Session's user title."

If `<unnamed>` is rejected at write time per the rename rules (`layout.md` line 262), the read-time filter is unnecessary; if legacy data can contain it, both specs should agree on the filter. Pick one.

## Smaller issues

### 9. "Stale pending command-line fallback"

`terminal-state.md` line 162–163: `promptStart` and `promptEnd` "clear stale pending command-line fallback" without defining what makes a pending line "stale." With `user_input` fallback firing in `editing` and OSC 633 ; E firing later, the staleness condition is load-bearing but unstated.

### 10. CWD fallback list vs. priority statement

`terminal-state.md` line 173–180: the numbered fallback list looks like a strict priority, but the immediately following sentence describes a different, looser semantics ("process may fill `null` or replace manual/restored, but not OSC"). It would be clearer as a single rule; as written, the two paragraphs leave the manual-vs-process tiebreak ambiguous when both fight for the same slot at runtime.

### 11. `OSC 9` vs `OSC 9;4` title-candidate split is implicit

`iTerm2.md`'s title-candidate side-effects table lists `OSC 9` as recording `titleCandidates.osc9 = message`, but `OSC 9;4` (progress) appears only as a notification source. A reader has to infer that "OSC 9" in the candidate row means *only* the message form, not the progress form. Worth saying explicitly given they share the same OSC number.

---

Severity: #1, #2, and #3 are blockers — they change actual behavior depending on which spec a reader trusts. #4 and #5 are spec-hygiene issues that will silently rot. The rest are minor.
