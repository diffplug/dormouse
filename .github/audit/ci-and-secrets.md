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

**Check effective permissions, not declared ones.** A job with no
`permissions:` block inherits the repository default, so read
`actions/permissions/workflow` before judging any permission bullet. A job that
declares nothing textually "grants" nothing while its token may carry nine
write scopes.

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
