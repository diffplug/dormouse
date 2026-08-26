# Domain: supply-chain

**Scope — these sections, and no others:**

`## Dependency Supply Chain`

**Output file:** `audit-supply-chain.md`

The workspace is installed by an earlier workflow step, so try the
generate-deps check directly; if it errors on a missing module, run
`pnpm install --frozen-lockfile` first. The check requires a clean working tree
*after* that install — the generator resolves every dependency by walking real
`node_modules` directories and throws rather than under-reporting if they are
absent.

If the check produces a diff, that is a real FAIL. Revert it
(`git checkout -- website/src/data/`) before you finish so you leave the tree
clean.

On the root-completeness bullet: derive the answer from `pnpm-workspace.yaml`,
not from the enumeration in the bullet. Work out from first principles which
workspace packages put files on a user's disk and by what route. A package
missing from both the roots and the stated exclusions is the failure; the
enumeration is the shortcut that goes stale.

## Qualitative pass

You own the dependency graph, the lockfile, `website/src/`, and
`website/scripts/` — the generator whose output the first `FAIL IF` checks
lives there, and owning the output without the generator is half a check.

- newly added or upgraded runtime dependencies since the last audit
- anything in the lockfile that resolves outside the registry
- install scripts in production dependencies
- any package a user runs that is reachable but not disclosed
