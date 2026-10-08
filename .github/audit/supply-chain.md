# Domain: supply-chain

**Scope — these specs, and no others:**

- `docs/specs/security-supply-chain.md`

**Output file:** `audit-supply-chain.md`

The secret-scanning and Dependabot clauses under "Cooldown and alerts" are judged in `audit-github-state.md`, which `scripts/github-state-check.mjs` wrote before you started; **do not re-derive or re-record them** — the reporting step reads that fragment itself. For every other `FAIL IF` marked `Pinned by` a script or test, run it — `node --test scripts/supply-chain-config.test.mjs` for the cooldown, Renovate, runtime-pin, `npx`, and CI-linter rules — and record its result as the evidence, one line per clause it pins. What stays yours is the unpinned clauses, the judgement bullets, and the qualitative pass.

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
