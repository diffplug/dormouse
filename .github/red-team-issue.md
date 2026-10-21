The monthly red-team pass (`docs/specs/security-audit.md` → "Red team"): an open-ended review of the code and the published guarantees, without the `FAIL IF` lines, on at least two model families. Findings go to the private ledger first; this issue records the pass once its findings are fixed or documented and disclosed.

### Checklist

- [ ] Build one stripped tree per engine from `main`, and record the commit reviewed.
- [ ] Run each engine: Claude through Anthropic's Cyber Verification Program, Codex through OpenAI's Daybreak program (optionally Gemini).
- [ ] Run each engine's second round, which proves its claims against the real code.
- [ ] Verify every claimed break with a separate reviewer.
- [ ] File each confirmed item in the ledger, fix it in a plain-worded PR, and close it citing the PR.
- [ ] Record the pass in the private `red-team/runs/`.
- [ ] After the nightly audit discloses the fixed findings, summarize the pass here and close.

### The most serious findings

**Nothing found allowed an account takeover or remote access to a terminal.** _Confirm or replace this sentence, and say why it holds._ Everything rated above low is described below. _Which release fixes it, and which releases were affected._

| Severity | What could happen | Who could do it | Fixed in |
|---|---|---|---|
| _Severity_ | _**What could happen, in one bolded sentence.** How, in plain words._ | _Who could do it._ | _PR_ |

Low-severity findings, fixed or documented: _each in a clause with its PR, or none._

### This month

- **Passes:** _each pass's commit and engines._
- **Fixed:** _PRs._
- **Documented** as not defended or a known gap: _PRs._
- **Disclosed:** [`security-audit-finding`](https://github.com/diffplug/dormouse/issues?q=label%3Asecurity-audit-finding).
- **Process changes it led to:** _PRs, or none._
