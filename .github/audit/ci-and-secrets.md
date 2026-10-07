# Domain: ci-and-secrets

**Scope — these specs, and no others:**

- `docs/specs/security.md`
- `docs/specs/security-ci.md`
- `docs/specs/security-audit.md`

**Output file:** `audit-ci-secrets.md`

The default `$GH_TOKEN` in this environment is a workflow `GITHUB_TOKEN` and does **not** have admin scope. For checks that need admin access — ruleset bypass actors, repo or environment secret listings, environment policy details, private vulnerability reporting, `actions/permissions/workflow` — prefix `gh api` with `GH_TOKEN=$AUDIT_PAT`:

```sh
GH_TOKEN=$AUDIT_PAT gh api repos/$GITHUB_REPOSITORY/rulesets/16757376
```

An earlier step guarantees `$AUDIT_PAT` is present; `docs/specs/security-audit.md` states its scopes. If a prefixed call still returns 403, record FAIL with the note "PAT scope drifted from docs/specs/security-audit.md".

When run by `scripts/security-audit-local.sh` without `AUDIT_PAT`, use the operator's existing `gh` authentication without a `GH_TOKEN=` override. Report an inaccessible check as `UNVERIFIABLE`; local credentials are not evidence about the CI PAT's scope.

**Check effective permissions, not declared ones**, as `docs/specs/security-ci.md` -> "Automated Maintainer (tend)" defines them. Read `actions/permissions/workflow` before judging any inherited-permission check.

**Derive every inventory from the live API, never from the spec's own list.** A `FAIL IF` that says "any" quantifies over what exists now; illustrative `Today:` lists do not limit its scope.

- Enumerate `GET /repos/$GITHUB_REPOSITORY/environments` and read each environment's `deployment_branch_policy` before determining its admitted refs. An empty custom-policy listing alone never proves that no refs are admitted:
  - `null` admits every branch and tag.
  - `protected_branches: true` admits branches with branch protection; if no branch protection rules exist in the repository, all branches can deploy. Check the admitted branches against the spec's admin-gating requirement; branch protection alone does not establish admin-only access.
  - `custom_branch_policies: true` uses `.../deployment-branch-policies`; enumerate those entries and check the refs their patterns admit.
- Enumerate `GET .../actions/secrets`, `GET .../actions/organization-secrets`, and each environment's own secret listing before checking placement.
- Enumerate `GET .../rulesets` before checking bypass actors.
- Use `gh api --paginate` for every list request, including deployment policies and secret listings, and check every member across all returned pages.
- Judge every discovered member against the applicable conditions, including explicit exceptions. Record FAIL for a violated condition. The secret-placement inventory in `security-ci.md` is normative: a secret outside the specified placements is a FAIL, not a documentation omission. A mere mention elsewhere in the scoped specs, such as a blast-radius table row, grants no exception to a placement requirement.
- Absence from an illustrative environment `Today:` list alone is not a violation. Report documentation omissions as INFO under `### Qualitative findings`; skip the INFO when another section of the scoped specs already covers the member. This only suppresses the documentation finding, not a placement FAIL.
- Never record `PASS` on a condition evaluated over only the spec's listed subset or an incomplete API enumeration. Apply the access-error handling above and the shared preamble's incomplete-check verdict rules.

## Qualitative pass

You own `.github/` (including `.github/audit/`, which holds this audit's own prompts), `.config/`, `.claude/`, `.vscode/`, `scripts/`, and `website/public/` — the Tauri updater manifest shipped apps fetch lives there, so it is a release artifact rather than marketing. You also own three root files that configure code a maintainer's checkout runs: `dormouse.yml`, whose `tools.*.run` commands `dor tool` launches; `install_skills.sh`, which fetches the agent skills `skills-lock.json` names into the untracked `.agents/skills/` and links them into `.claude/commands/`; and `skills-lock.json` itself. You also own any code anywhere that touches a secret.

`.vscode/` is here rather than with the product code because it is configuration that can execute: a `tasks.json` entry with `"runOn": "folderOpen"` runs on checkout when a maintainer opens the folder, which is the same shape of persistence `workflow-audit.yaml` watches workflows for. There is no such task today; the point is that adding one should be a finding, not a quiet config change.
