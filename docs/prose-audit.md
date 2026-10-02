# Spec and code prose audit

This review catches prose debt that a correctness lint cannot judge. It covers every spec, its rationale, and the code references resolved from markdown links and backticked paths or unique basenames.

## Run the inventory

From the repository root:

```sh
pnpm audit:prose
pnpm audit:prose --changed=origin/main
```

The full pass inventories the corpus; it does not prove that its claims match implementation. The changed pass selects any spec whose text, rationale, or code referenced by either changed from the given base, plus working-tree changes. Use the stacked PR's actual base branch rather than assuming `main`. `--json` emits machine-readable results.

The inventory includes `AGENTS.md`, `SECURITY.md`, `SELF_HOST.md`, and `docs/compatible-agents.md`, plus each existing rationale and its references. Imported implementation files still need manual inspection: changed selection follows explicit references, not transitive imports.

The command is dependency-free and advisory. Its thresholds intentionally favor recall: a hit is a review prompt, not a lint failure or permission to delete text. The default report caps each spec's detail; add `--all` or `--json` to inspect every hit.

## Review one cluster

1. Read each spec and its paired rationale. Review every behavior-bearing section, including sections with no advisory hit; follow implementation imports and check both spec claims against code and relevant code branches against the spec.
2. Inspect every resolved reference. Resolve any reported file-like reference manually; ambiguity often means the pointer itself can be clearer.
   A `Files` / `Code Map` section should offer useful entrypoints to follow through imports, while section-local `Source of truth:` pointers locate particular rules. Keep both when they serve those distinct jobs; check map paths and role descriptions against code without requiring exhaustive coverage or a map in every spec.
3. Give each hit one disposition:

   - `KEEP` — a non-obvious invariant or local constraint is already at its useful home.
   - `CUT` — duplication, scaffolding prose, a test catalog, or history that git already preserves.
   - `POINTER` — replace copied explanation with one rule and a directional `Source of truth:` or code-comment pointer.
   - `RATIONALE` — move durable evidence or rejected alternatives under the paired heading.
   - `MATRIX` — merge parallel cases into one table, precedence ladder, or flow.
   - `CANONICAL` — let generated help, a type, constant, registry, or test own an exact shape.

4. Apply only high-confidence edits. Preserve invariants, edge cases, message direction, cross-package ownership, and the `## Future` fold.
5. Run `node scripts/spec-lint.mjs`, relevant focused tests, and `git diff --check`. Re-baseline a changed spec with `node scripts/spec-lint.mjs --ratchet <spec>`.
6. Commit a coherent cluster so reviewers can distinguish mechanical compression from behavior changes.

## Cadence

Run the full inventory as a periodic maintenance pass and after a large spec-writing phase. Run the changed pass before review whenever a PR modifies a spec or a referenced file. Keep this advisory: comment length and prose similarity are signals, while only broken structural conventions belong in `spec-lint`.
