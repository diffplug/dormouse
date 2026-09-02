# Handoff: a Windows-path-aware `commandArgv0`

> Delete this file in the PR that does the work — it is a task brief, not a spec.

Branch `windows-argv0`, based on `origin/main` (not on the Dor Tools stack: the
bug predates it and every fix here lands for `main` users immediately).

## The bug

`tokenizeCommand` in
[`lib/src/lib/terminal-state.ts`](lib/src/lib/terminal-state.ts) treats `\` as a
POSIX escape character, outside single quotes:

```ts
if (char === '\\' && quote !== "'") {
  escaping = true;
  continue;
}
```

On a shell that reports Windows paths (PowerShell, cmd — Git Bash reports POSIX
paths and is unaffected), that eats the path separators before anything can
split on them:

| OSC 633 command line | tokens today | `commandArgv0` today | wanted |
| --- | --- | --- | --- |
| `C:\tools\dor.cmd tool storybook` | `['C:toolsdor.cmd', 'tool', …]` | `C:toolsdor.cmd` | `dor.cmd` |
| `C:\Program Files\nodejs\npm.cmd run dev` | `['C:Program', 'Filesnodejsnpm.cmd', …]` | `C:Program` | `npm.cmd` |
| `C:\Users\me\.claude\local\claude` | `['C:Usersme.claudelocalclaude']` | `C:Usersme.claudelocalclaude` | `claude` |

The basename split inside `commandArgv0` (`command.split(/[\\/]/)`) runs *after*
tokenizing, so by then there is no separator left to split on.

## What it costs today

Everything keyed on the program name silently misses when the user (or a
launcher, or a shim) invokes by absolute path on Windows:

- **WATCHING rules never match.** `lib/src/lib/watched-commands.ts` stores bare
  program names and `alert-manager.ts` compares them against
  `commandArgv0(rawCommandLine)`. A user who added `claude` gets no alerts from
  a Session started as `C:\Users\me\.claude\local\claude` — the alert simply
  never rings, with nothing on screen to explain why (`docs/specs/alert.md` →
  WATCHING).
- **Pane headers and the TODO dialog show mangled text.**
  `TerminalPaneHeader.tsx:138` and `TodoAlertDialog.tsx:42` render `commandArgv0`
  output; `summarizeCommandLine` (the `displayCommand` in
  `docs/specs/terminal-state.md` → command lifecycle) runs the same tokenizer,
  so a header reads `C:Program ...` instead of `npm run dev`.
- **`dor tool`'s take-over gate fails closed.** `isNakedToolInvocation` in
  `lib/src/components/wall/tool-takeover.ts` (branch `tool-takeover`, PR #514)
  checks `commandArgv0(line)` against the launcher names, so
  `C:\bin\dor.cmd tool storybook` splits instead of taking over the pane. That
  one is a placement miss, not a wrong action, and was accepted there precisely
  so the fix could land here for every consumer at once — see the resolved
  thread on `tool-takeover.ts:29` in PR #514.

## Why it is not a one-line change

The escape rule is load-bearing for POSIX shells, which is what everything else
reports: `foo\ bar` is one token containing a space, `find . -name \*.ts` passes
a literal `*`. Dropping the escape branch outright would regress those.

## Suggested approach

**Preferred — decide per backslash, inside the tokenizer.** A backslash is an
escape only when it precedes a character that shells actually escape
(whitespace, a quote, another backslash, or a glob/metacharacter); before a
path-ish character it is a literal separator. `C:\tools\dor.cmd` then survives
tokenizing intact and the existing `split(/[\\/]/)` basename does the rest,
while `foo\ bar` and `\*.ts` keep their current meaning. Self-contained: no
plumbing, and all three consumers above are fixed by the one change.

**Alternative — carry the dialect.** `CwdState.pathKind` (`'posix' | 'windows' |
'unknown'`, already on every pane's state) says which dialect the shell speaks,
so `tokenizeCommand` could take it and switch escaping wholesale. More
principled, but it threads a parameter through `summarizeCommandLine`,
`commandArgv0`, `resolveCommandStart` and their callers, and the reported cwd is
not always present when a command line arrives. Prefer this only if the
per-character heuristic turns out to be ambiguous in practice.

Whatever shape wins, keep **one** tokenizer: the gate in `tool-takeover.ts`
reuses `commandArgv0` / `primaryCommandTokens` exactly so the take-over gate and
the pane header can never disagree about one command line.

## Scope checklist

- [ ] `tokenizeCommand` in `lib/src/lib/terminal-state.ts`.
- [ ] Table-driven cases in `lib/src/lib/terminal-state.test.ts` next to the
      existing `summarizeCommandLine` / `commandArgv0` cases: Windows absolute
      paths with and without spaces, a `.cmd`/`.exe` launcher, plus the POSIX
      escapes (`foo\ bar`, `\*.ts`) as regression pins.
- [ ] `lib/src/lib/terminal-prompt-shape.test.ts` fixtures use the maintainer's
      real shell (`ntwigg@ntwigg-mac-2025`) — check nothing there depends on the
      old mangling.
- [ ] Specs: this changes no documented rule, so the edit is likely limited to a
      sentence in `docs/specs/terminal-state.md` if the tokenizer's dialect
      handling is worth stating. Do **not** grow `alert.md` — the WATCHING rule
      it documents is already "the bare program name"; this only makes the code
      match it. Check the word budgets in `scripts/spec-word-budgets.json` if you
      do add prose.
- [ ] `pnpm lint:specs` and the `lib` suite; no `dor` package changes expected.

## Verification

jsdom tests cover the parsing, but the payoff is on Windows. The repo has a
Windows CI lane (`Standalone Platform Check (windows-latest)`); a real check is
a PowerShell pane running an absolute-path command and confirming the header
shows the program name and a WATCHING rule on that name rings.
