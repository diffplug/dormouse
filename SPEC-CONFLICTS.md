# Spec conflicts in `docs/specs/` (HEAD vs main)

Audit of the changed regions in `iTerm2.md`, `layout.md`, `terminal-state.md` (new), and `vscode.md`.

## Substantive conflicts

## Smaller issues

### 10. CWD fallback list vs. priority statement

`terminal-state.md` line 173–180: the numbered fallback list looks like a strict priority, but the immediately following sentence describes a different, looser semantics ("process may fill `null` or replace manual/restored, but not OSC"). It would be clearer as a single rule; as written, the two paragraphs leave the manual-vs-process tiebreak ambiguous when both fight for the same slot at runtime.

### 11. `OSC 9` vs `OSC 9;4` title-candidate split is implicit

`iTerm2.md`'s title-candidate side-effects table lists `OSC 9` as recording `titleCandidates.osc9 = message`, but `OSC 9;4` (progress) appears only as a notification source. A reader has to infer that "OSC 9" in the candidate row means *only* the message form, not the progress form. Worth saying explicitly given they share the same OSC number.

---

Severity: all remaining items are minor. (#1, #2, #3, #4, #5, #6, #7, #8, #9 are resolved.)
