# Spec and code prose audit

This review catches prose debt that a correctness lint cannot judge. It covers every spec, its rationale, and the code references resolved from markdown links and backticked paths or unique basenames.

## Run the inventory

From the repository root:

```sh
pnpm audit:prose
pnpm audit:prose --changed=origin/main
```

The full pass proves corpus coverage. The changed pass selects any spec whose text or referenced code changed from the given base, plus working-tree changes. Use the stacked PR's actual base branch rather than assuming `main`. `--json` emits machine-readable results.

The command is dependency-free and advisory. Its thresholds intentionally favor recall: a hit is a review prompt, not a lint failure or permission to delete text. The default report caps each spec's detail; add `--all` or `--json` to inspect every hit.

## Review one cluster

1. Read each spec and the rationale sections matching the headings being touched.
2. Inspect every resolved reference. Resolve any reported file-like reference manually; ambiguity often means the pointer itself can be clearer.
3. Give each hit one disposition:

   - `KEEP` — a non-obvious invariant or local constraint is already at its useful home.
   - `CUT` — duplication, scaffolding prose, a test catalog, or history that git already preserves.
   - `POINTER` — replace copied explanation with one rule and a directional `Source of truth:` or code-comment pointer.
   - `RATIONALE` — move durable evidence or rejected alternatives under the paired heading.
   - `MATRIX` — merge parallel cases into one table, precedence ladder, or flow.
   - `CANONICAL` — let generated help, a type, constant, registry, or test own an exact shape.

4. Apply only high-confidence edits. Preserve invariants, edge cases, message direction, cross-package ownership, and the `## Future` fold.
5. Run `node scripts/spec-lint.mjs`, relevant focused tests, and `git diff --check`. Lower changed word budgets to retain a small ratchet margin.
6. Commit a coherent cluster so reviewers can distinguish mechanical compression from behavior changes.

## Cadence

Run the full inventory as a periodic maintenance pass and after a large spec-writing phase. Run the changed pass before review whenever a PR modifies a spec or a referenced file. Keep this advisory: comment length and prose similarity are signals, while only broken structural conventions belong in `spec-lint`.
