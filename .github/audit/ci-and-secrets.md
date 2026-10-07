# Domain: ci-and-secrets

**Scope — these specs, and no others:**

- `docs/specs/security.md`
- `docs/specs/security-ci.md`
- `docs/specs/security-audit.md`

**Output file:** `audit-ci-secrets.md`

**Read `audit-github-state.md` before your first check.** `scripts/github-state-check.mjs` wrote it before you started: one line for every clause in your scope that GitHub state answers — rulesets, the bot's role, every environment and its policies and reviewers, the secret inventory, workflow permissions, workflow liveness, private vulnerability reporting, the embargo repository's visibility — each enumerated from the live API and judged against `.github/audit/expected-github-state.json`. The spec marks those `FAIL IF` lines pinned by `scripts/github-state-check.mjs`. **Do not re-derive or re-record those clauses**: the reporting step reads that fragment as its own report, and a second verdict on the same clause is a second chance to get it wrong. Use it as evidence for your judgement bullets. If it is missing or has no `<!-- END OF REPORT -->`, the reporting step already counts that against the run; record one `INFO` line and do not substitute checks of your own.

**For a `FAIL IF` marked `Pinned by` a script or test, run that script and record its result as the evidence** — `node scripts/workflow-lint.mjs`, `node --test scripts/security-audit.test.mjs`, `node --test scripts/workflow-audit.test.mjs`, `node --test scripts/sign-and-deploy.test.mjs` — one line per clause it pins, rather than re-reading the files it reads.

What stays yours: every unpinned clause and judgement bullet, the qualitative pass below, and whether `.github/audit/expected-github-state.json` still encodes the rules in your scope — a value there that a spec does not justify is a FAIL under the spec section it would weaken.

For the GitHub API calls those still need, the default `$GH_TOKEN` is a workflow `GITHUB_TOKEN` without admin scope; prefix `gh api` with `GH_TOKEN=$AUDIT_PAT` for an administration endpoint. An earlier step guarantees `$AUDIT_PAT` is present; `docs/specs/security-audit.md` states its scopes. If a prefixed call still returns 403, record FAIL with the note "PAT scope drifted from docs/specs/security-audit.md". When run by `scripts/security-audit-local.sh` without `AUDIT_PAT`, use the operator's existing `gh` authentication without a `GH_TOKEN=` override, and report an inaccessible check as `UNVERIFIABLE`; local credentials are not evidence about the CI PAT's scope. Use `gh api --paginate` for every list request.

You hold no credential for the private tracker `docs/specs/security-audit.md` -> "Embargo" files to, and need none: read that section's checks from the workflow, the scripts it names, and the deterministic fragment.

**Check effective permissions, not declared ones**, as `docs/specs/security-ci.md` -> "Automated Maintainer (tend)" defines them, and **derive every inventory from what exists, never from the spec's own list**: illustrative `Today:` lists do not limit a `FAIL IF` that says "any". Never record `PASS` on a condition evaluated over only part of what it quantifies over.

## Qualitative pass

You own `.github/` (including `.github/audit/`, which holds this audit's own prompts), `.config/`, `.claude/`, `.vscode/`, `scripts/`, and `website/public/` — the Tauri updater manifest shipped apps fetch lives there, so it is a release artifact rather than marketing. You also own three root files that configure code a maintainer's checkout runs: `dormouse.yml`, whose `tools.*.run` commands `dor tool` launches; `install_skills.sh`, which fetches the agent skills `skills-lock.json` names into the untracked `.agents/skills/` and links them into `.claude/commands/`; and `skills-lock.json` itself. You also own any code anywhere that touches a secret.

`.vscode/` is here rather than with the product code because it is configuration that can execute: a `tasks.json` entry with `"runOn": "folderOpen"` runs on checkout when a maintainer opens the folder, which is the same shape of persistence `workflow-audit.yaml` watches workflows for. There is no such task today; the point is that adding one should be a finding, not a quiet config change.
