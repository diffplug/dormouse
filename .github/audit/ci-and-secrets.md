# Domain: ci-and-secrets

**Scope — these specs, and no others:**

- `docs/specs/security.md`
- `docs/specs/security-ci.md`
- `docs/specs/security-audit.md`

**Output file:** `audit-ci-secrets.md`

The default `$GH_TOKEN` in this environment is a workflow `GITHUB_TOKEN` and
does **not** have admin scope. For checks that need admin access — ruleset
bypass actors, repo or environment secret listings, environment policy details,
private vulnerability reporting, `actions/permissions/workflow` — prefix
`gh api` with `GH_TOKEN=$AUDIT_PAT`:

```sh
GH_TOKEN=$AUDIT_PAT gh api repos/$GITHUB_REPOSITORY/rulesets/16757376
```

`$AUDIT_PAT` is a fine-grained, read-only PAT covering Administration +
Secrets + Environments, guaranteed present by an earlier step. If a prefixed
call still returns 403, record FAIL with the note "PAT scope drifted from
docs/specs/security-audit.md".

When run by `scripts/security-audit-local.sh` without `AUDIT_PAT`, use the
operator's existing `gh` authentication without a `GH_TOKEN=` override.
Report an inaccessible check as `UNVERIFIABLE`; local credentials are not
evidence about the CI PAT's scope.

**Check effective permissions, not declared ones.** A job-level `permissions:`
block overrides the workflow-level block; absent both, the repository default
applies. Unspecified scopes in an explicit block are `none`. Read
`actions/permissions/workflow` before judging any inherited-permission check.

**Derive every inventory from the live API, never from the spec's own list.** A
`FAIL IF` that says "any" quantifies over what exists now; the `Today:` or
inventory lines under it illustrate the expected answer and go stale the moment
someone adds a member. So enumerate `GET /repos/$GITHUB_REPOSITORY/environments`
before checking deployment-branch-policies, `GET .../actions/secrets` and each
environment's own secret listing before checking placement, and
`GET .../rulesets` before checking bypass actors — then check every member the
API returned. An unlisted member is a finding, not out of scope: report each one
you found that the spec's list omits, and never record `PASS` on a condition you
only evaluated over the listed subset.

## Qualitative pass

You own `.github/` (including `.github/audit/`, which holds this audit's own
prompts), `.config/`, `.claude/`, `.vscode/`, `scripts/`, and
`website/public/` — the Tauri updater manifest shipped apps fetch lives there,
so it is a release artifact rather than marketing. You also own any code
anywhere that touches a secret.

`.vscode/` is here rather than with the product code because it is
configuration that can execute: a `tasks.json` entry with
`"runOn": "folderOpen"` runs on checkout when a maintainer opens the folder,
which is the same shape of persistence `workflow-audit.yaml` watches workflows
for. There is no such task today; the point is that adding one should be a
finding, not a quiet config change.
