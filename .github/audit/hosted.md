# Domain: hosted

**Scope — these specs, and no others:**

- `docs/specs/security-hosted.md`

**Output file:** `audit-hosted.md`

This is a code-and-specs audit of the Hosted account application. You need no
PAT — do not use one. The two pgstencil provenance checks below do read the
GitHub API, but only a public repository, which the workflow's default
`GITHUB_TOKEN` and the operator's own `gh` login both reach; if that API is
unreachable, report those two checks as `UNVERIFIABLE`.

Read `docs/specs/hosted.md`, `hosted/server/`, `hosted/src/`, `hosted/scripts/`,
`hosted/wrangler.jsonc`, and `.github/workflows/hosted-preview.yml` and
`.github/workflows/hosted-production.yml` — `docs/specs/security-hosted.md`'s
Deployment boundary quantifies over the preview and production paths, which
live in those scripts and workflows rather than in the Worker.

Verify the vendored packages by their provenance rather than by reading them:
hash each archive in `vendor/` against `vendor/build.json`; read each archive's
own claim with `tar -xOf vendor/<archive>.tgz package/dist/provenance.json` and
check that it names `build.json`'s commit and does not record `dirty`; then
check that commit against pgstencil `main` and its audit:

```sh
gh api repos/diffplug/pgstencil/compare/<commit>...main --jq .status
gh api repos/diffplug/pgstencil/commits/<commit>/check-runs \
  --jq '.check_runs[] | select(.name=="security-audit") | .conclusion'
```

The first must be `ahead` or `identical`, the second `success`. A commit can
carry several `security-audit` runs, and a `cancelled` one, from a manual
dispatch that was stopped, is not a verdict: ignore it, and require that a
completed run succeeded and none failed. The packed code
itself is audited in `diffplug/pgstencil` by that repository's own
`security-audit` workflow against its `SECURITY.md`; do not audit the tarballs'
contents here — audit how `hosted/` configures the adapter. Distinguish tested
code from pending production configuration; do not treat local provider
simulations as live OAuth acceptance, and treat a checked-in placeholder as no
evidence about an external control. Production activation is staged under the
spec's `## Future`: while it sits below the fold there is no check here, so
report its state as INFO under `### Qualitative findings`.

## Qualitative pass

You own `hosted/` and `vendor/`. You **read** `.github/workflows/hosted-preview.yml`
and `.github/workflows/hosted-production.yml` for the Deployment boundary above,
but you do not own them: `ci-and-secrets` owns those workflows' credentials,
environments, reviewers, and token placement
(`docs/specs/security-ci.md` -> "Hosted Deployments"). Report what the
deployment *path* does and leave that half to it, so the two domains do not
report the same finding twice.

Be adversarial, and go past the `FAIL IF` list. Ask specifically:

- **Is the Hosted origin the only one that can drive Hosted?** Trace a request
  from `hosted/server/worker.ts` through `workerApp`'s origin gate and
  `secureHeaders`: a foreign `Host`, a preview hostname, a misconfigured
  deployment's error path, and the SPA fallback must each answer without
  credentialed CORS, without a cacheable shell, and without inline script.
  Check that authentication cookies stay `__Host-`, Secure, HttpOnly, `Path=/`
  and Domain-less, and that no session token reaches browser JSON or storage.
- **Can a Hosted login become terminal access, or an account become someone
  else's?** `authPolicy` must keep explicit linking and independent logins; a
  callback whose initiating login was revoked must fail; an unused or unknown
  provider credential must enable nothing. No Hosted endpoint may mint a Burrow
  ACL grant or stand in for the encrypted pairing and presence proof.
- **Does anything from the test or preview build reach production?** The
  production Worker must not export the captured-email inbox, the deterministic
  clock, or the testing injection module; preview must not copy production
  routes, bindings, or credentials, must not call real mail or OAuth, and its
  cleanup must check out the base branch rather than the closed PR's.

Does the shipped code still match what the spec and this section claim? Spec
drift is a finding; say which side is wrong.
