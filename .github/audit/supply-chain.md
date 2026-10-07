# Domain: supply-chain

**Scope — these specs, and no others:**

- `docs/specs/security-supply-chain.md`

**Output file:** `audit-supply-chain.md`

The default `$GH_TOKEN` in this environment is a workflow `GITHUB_TOKEN` and does **not** have admin scope. GitHub omits `security_and_analysis` for a non-admin token and answers 403 rather than 204 on the Dependabot alert endpoint, so the secret-scanning and Dependabot checks read as absent when they are on. Prefix those `gh api` calls with `GH_TOKEN=$AUDIT_PAT`:

```sh
GH_TOKEN=$AUDIT_PAT gh api repos/$GITHUB_REPOSITORY --jq .security_and_analysis
GH_TOKEN=$AUDIT_PAT gh api repos/$GITHUB_REPOSITORY/vulnerability-alerts
```

An earlier step guarantees `$AUDIT_PAT` is present; `docs/specs/security-audit.md` states its scopes. If a prefixed call still returns 403, record FAIL with the note "PAT scope drifted from docs/specs/security-audit.md". When run by `scripts/security-audit-local.sh` without `AUDIT_PAT`, use the operator's existing `gh` authentication without a `GH_TOKEN=` override, and report an inaccessible check as `UNVERIFIABLE`.

Run the generate-deps check in a scratch copy of the audited commit (`git archive HEAD` into a temporary directory, committed clean there), after `pnpm install --frozen-lockfile --ignore-scripts` in that copy, never in the audited tree: the generator resolves every dependency by walking real `node_modules` directories and throws rather than under-reporting if they are absent.

A diff in that copy is a real FAIL.

For the shipped-workspace check under "Disclosure", work out from first principles which workspace packages put files on a user's disk and by what route; the generator's arrays are the shortcut that goes stale.

## Work streams

Delegate only by these streams (`.github/audit/_preamble.md` -> "Work streams"). Each holds every rule under the headings it names:

- `disclosure` — `docs/specs/security-supply-chain.md`: "Disclosure".
- `runtime-cooldown` — `docs/specs/security-supply-chain.md`: "Bundled runtime", "Cooldown and alerts".
- `qualitative` — the qualitative pass below, once, over the whole of this domain's scope.

## Qualitative pass

You own the dependency graph, the lockfile, and **all of `website/` except `website/public/`**, which is `ci-and-secrets`' because the Tauri updater manifest lives there. So `website/src/`, `website/scripts/`, and the build config (`package.json`, `vite.config.ts`, `react-router.config.ts`, `tsconfig.json`) are all yours. `generate-deps.js` is in that set: audit the whole generator, not just the arrays "Disclosure" names.

- newly added or upgraded runtime dependencies since the last audit
- anything in the lockfile that resolves outside the registry
- install scripts in production dependencies
- any package a user runs that is reachable but not disclosed
