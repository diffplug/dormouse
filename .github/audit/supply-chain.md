# Domain: supply-chain

**Scope — these specs, and no others:**

- `docs/specs/security-supply-chain.md`

**Output file:** `audit-supply-chain.md`

The default `$GH_TOKEN` in this environment is a workflow `GITHUB_TOKEN` and
does **not** have admin scope. GitHub omits `security_and_analysis` for a
non-admin token and answers 403 rather than 204 on the Dependabot alert
endpoint, so the secret-scanning and Dependabot checks read as absent when they
are on. Prefix those `gh api` calls with `GH_TOKEN=$AUDIT_PAT`:

```sh
GH_TOKEN=$AUDIT_PAT gh api repos/$GITHUB_REPOSITORY --jq .security_and_analysis
GH_TOKEN=$AUDIT_PAT gh api repos/$GITHUB_REPOSITORY/vulnerability-alerts
```

`$AUDIT_PAT` is a fine-grained, read-only PAT covering Administration +
Secrets + Environments, guaranteed present by an earlier step. If a prefixed
call still returns 403, record FAIL with the note "PAT scope drifted from
docs/specs/security-audit.md". When run by `scripts/security-audit-local.sh`
without `AUDIT_PAT`, use the operator's existing `gh` authentication without a
`GH_TOKEN=` override, and report an inaccessible check as `UNVERIFIABLE`.

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

You own the dependency graph, the lockfile, and **all of `website/` except
`website/public/`**, which is `ci-and-secrets`' because the Tauri updater
manifest lives there. So `website/src/`, `website/scripts/`, and the build
config (`package.json`, `vite.config.ts`, `react-router.config.ts`,
`tsconfig.json`) are all yours. `generate-deps.js` is in that set: audit the
whole generator, not just the `productDependencyFilters` array the
root-completeness bullet names.

- newly added or upgraded runtime dependencies since the last audit
- anything in the lockfile that resolves outside the registry
- install scripts in production dependencies
- any package a user runs that is reachable but not disclosed
