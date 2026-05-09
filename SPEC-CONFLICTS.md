# Spec conflicts in `docs/specs/` (HEAD vs main)

Audit of the changed regions in `iTerm2.md`, `layout.md`, `terminal-state.md` (new), and `vscode.md`.

## Substantive conflicts

## Smaller issues

### 11. `OSC 9` vs `OSC 9;4` title-candidate split is implicit

`iTerm2.md`'s title-candidate side-effects table lists `OSC 9` as recording `titleCandidates.osc9 = message`, but `OSC 9;4` (progress) appears only as a notification source. A reader has to infer that "OSC 9" in the candidate row means *only* the message form, not the progress form. Worth saying explicitly given they share the same OSC number.

---

Severity: all remaining items are minor. (#1–#10 are resolved.)
