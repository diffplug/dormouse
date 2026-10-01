# Domain: hosted

**Scope — these specs, and no others:**

- `docs/specs/security-hosted.md`

**Output file:** `audit-hosted.md`

This is a code-and-specs audit of Hosted's three Workers — the account
application (`hosted.dormouse.sh`), the relay that serves the Hosted Relay's
account-scoped routes, Pocket, and the one-time rendezvous
(`relay.dormouse.sh`), and managed voice (`voice.dormouse.sh`). You need no
PAT — do not use one. The two pgstencil provenance checks below do read the
GitHub API, but only a public repository, which the workflow's default
`GITHUB_TOKEN` and the operator's own `gh` login both reach; if that API is
unreachable, report those two checks as `UNVERIFIABLE`.

Read `docs/specs/hosted.md`, `docs/specs/one-time.md` (its "Wire contract",
"Hosted rendezvous", and "Phone page"), `docs/specs/relay.md` (its "HTTP API",
"Setup tokens and the pairing QR", "WebAuthn without a WebAuthn library",
"Routing", "Web Push", and "State files", whose semantics the Hosted Relay
keeps), `hosted/server/`, `hosted/src/`,
`hosted/scripts/`, `hosted/wrangler.jsonc`, `hosted/wrangler.relay.jsonc`,
`hosted/wrangler.voice.jsonc`,
`remote-lib-common/src/remote/one-time-wire.ts`,
`remote-lib-common/src/remote/relay-common.ts`,
`remote-lib-common/src/remote/web-push.ts` and its test
`remote-lib-common/test/web-push.test.mjs`, the Pocket build the relay
serves (`lib/vite.pocket.config.ts`, `lib/pocket/`), the phone page it serves —
`lib/vite.one-time.config.ts`, `lib/one-time/`, `lib/src/remote/one-time-app/`,
and `lib/scripts/assert-pocket-worker.mjs` — and
`.github/workflows/hosted-preview.yml` and
`.github/workflows/hosted-production.yml` — `docs/specs/security-hosted.md`'s
Deployment boundary quantifies over the preview and production paths, which
live in those scripts and workflows rather than in the Worker.

Verify the installed `pgstencil` and `@pgstencil/auth` packages by reading each
`dist/provenance.json`, without auditing package code. Require a 40-hex commit,
no `dirty: true`, and the same commit in both packages. Confirm `pnpm-lock.yaml`
resolves both through the npm registry with integrity hashes. Inspect Hosted's
runtime imports for references to a sibling pgstencil checkout.

Verify npm's signed SLSA provenance for each installed package/version. Use a
temporary npm consumer of the exact locked versions and `npm audit signatures
--json --include-attestations` (npm does not audit a pnpm-only install). Each
package **must appear in `verified`** with a SLSA provenance bundle; reject
`invalid` and `missing` entries too. Decode the verified SLSA DSSE payload and
the Fulcio certificate in that bundle. The certificate SAN must be
`https://github.com/diffplug/pgstencil/.github/workflows/release.yml@refs/heads/main`;
its source-repository digest extension `1.3.6.1.4.1.57264.1.13` must equal
the installed `dist/provenance.json` commit. The signed subject must identify
the installed package/version and digest; the payload's
`externalParameters.workflow` and `resolvedDependencies` must agree with the
certificate and commit. npm verifies the signature and subject digest, but
the payload's workflow claim alone is not the signer identity. Then check the
commit against pgstencil `main` and its audit:

```sh
gh api repos/diffplug/pgstencil/compare/<commit>...main --jq .status
gh api repos/diffplug/pgstencil/commits/<commit>/check-runs \
  --jq '.check_runs[] | select(.name=="security-audit") | .conclusion'
```

The first must be `ahead` or `identical`. A commit can carry several
`security-audit` runs, and a `cancelled` one, from a manual dispatch that was
stopped, is not a verdict: ignore `cancelled`, then require at least one
`success` and no other conclusion. The released code
itself is audited in `diffplug/pgstencil` by that repository's own
`security-audit` workflow against its `SECURITY.md`; do not audit the installed packages'
contents here — audit how `hosted/` configures the adapter. Distinguish tested
code from pending production configuration; do not treat local provider
simulations as live OAuth acceptance, and treat a checked-in placeholder as no
evidence about an external control. Production activation is staged under the
spec's `## Future`: while it sits below the fold there is no check here, so
report its state as INFO under `### Qualitative findings`.

## Qualitative pass

You own `hosted/` and the installed pgstencil boundary. You **read** `.github/workflows/hosted-preview.yml`
and `.github/workflows/hosted-production.yml` for the Deployment boundary above,
but you do not own them: `ci-and-secrets` owns those workflows' credentials,
environments, reviewers, and token placement
(`docs/specs/security-ci.md` -> "Hosted Deployments"). Report what the
deployment *path* does and leave that half to it, so the two domains do not
report the same finding twice.

Be adversarial, and go past the `FAIL IF` list. Ask specifically:

- **Is each Worker's origin the only one that can drive it?** Trace a request
  from `hosted/server/worker.ts`, `hosted/server/relay-worker.ts`, and
  `hosted/server/voice-worker.ts` through `workerApp`'s origin gate and
  `secureHeaders`: a foreign `Host`, a sibling Worker's origin, a preview
  hostname, a misconfigured deployment's error path, and the account's SPA
  fallback must each answer without credentialed CORS, without a cacheable
  shell, and without inline script. The siblings are same-site, so the login
  cookie rides their requests to the account: every account cookie route must
  refuse their `Origin`. Check that authentication cookies stay `__Host-`,
  Secure, HttpOnly, `Path=/` and Domain-less, and that no session token
  reaches browser JSON or storage.
- **Does a secret reach a Worker that has no use for it?** Read each mapper in
  `hosted/server/bindings.ts` and each Wrangler config: the relay and voice
  Workers must hold and pass no auth secret and never import Better Auth, and
  the account and relay no ElevenLabs key, and the account and voice no
  `RELAY_ENROLL_SECRET` or VAPID private key, which must be a relay Worker
  secret and never a `vars` entry. The relay's Hyperdrive reaches only
  its own tables and the entitlement's user row.
- **Can one account reach another's Relay rows?** Trace every query in
  `hosted/server/relay-api.ts`: a session or Burrow token of account B must not
  list, prove with, spend, or mint against account A's Burrows, passkeys,
  nonces, setup tokens, or setup challenges; a single-use row must be spent in
  the statement that reads it; a bearer secret must be at rest only as its
  hash; a de-entitled account or removed Burrow must act on nothing, the
  account's sessions and sign-in included; every unauthenticated route that
  reaches Postgres must spend its per-address limit first; and every table a
  caller grows must stay bounded against that caller, a capped write never
  touching another key's rows. Classify a percent-encoded path (`/%63onnect/`,
  `/%61ssets/`) the way `secureHeaders` and the routes do.
- **Can an enrollment become someone else's Burrow, or a second one?** Trace
  a device code from `begin` through the account's approval
  (`hosted/server/relay-account.ts`) to the poll that redeems it: begin must
  write nothing; a web page must not begin or poll; the device code must carry
  its own expiry and its user code must be the relay secret's HMAC of it, so
  no one can forge a device code that redeems another's approval; an approval
  must need a recent admin login from the account's own origin and never
  replace a live one; the redemption must be one statement whose owner is that
  approver, and a redeemed approval must never redeem again, even once its
  Burrow is removed; and a removed Burrow's row must be gone, its token opening nothing
  on any relay route. Look for a user code predictable without the secret, an
  unlimited approval loop, and a table an unauthenticated caller can grow.
- **Can push leak text, cross an account, or reach somewhere it should not?**
  Trace a send through `relayPushRoutes` in `hosted/server/relay-push.ts`: the
  Relay must forward exactly the sealed envelope's three fields plus the
  token's `burrowId`, read and log no notification text, and reach only the
  calling Burrow's rows. A session must not register against, read back, or
  delete another account's rows, even holding its `deliveryId`, and an
  upsert's endpoint rotation, its caps, and the 404/410 prune must stay inside
  the account. Every fetch must go to an endpoint `knownPushEndpoint` admits,
  follow no redirect, and keep at most 1 KiB of a refusal's body. Check the sender against
  RFC 8291 and RFC 8292 yourself: the test's expected bytes must come from the
  RFC, not the code, and a JWT's `aud` must be the endpoint's origin. Look for
  an endpoint string that parses to an allowlisted host in one place and
  another host in another.
- **Can a Hosted login become terminal access, or an account become someone
  else's?** `authPolicy` must keep explicit linking and independent logins; a
  callback whose initiating login was revoked must fail; an unused or unknown
  provider credential must enable nothing. No Hosted endpoint may mint a Burrow
  ACL grant or stand in for the encrypted pairing and presence proof, the
  Relay must read no cookie, and the rendezvous authorizes nothing. Pocket and
  `/connect/` share the relay origin; check what each page's policy lets it
  reach of the other.
- **Can one account's relay socket reach another's?** Trace an upgrade
  through `relaySocketRoutes` (`hosted/server/relay-sockets.ts`) into
  `RelayRoom` (`hosted/server/relay-room.ts`): the object must be named only
  from the account a token resolved to, refuse any request or RPC naming
  another, and receive no header or token of the caller's; a web page must not
  open a Burrow socket, nor another origin a Client socket. Look for routing
  state kept in memory that a hibernated object would lose, a socket torn down
  twice or routed after its close began, a frame parsed before its length is
  bounded or bounded in characters rather than bytes, a `ct` read, decoded,
  logged, or stored outside the shared frame layer's field copy, a Client cap
  one socket can evict past, a session that outlives its alarm, a ping that
  wakes the object, a Burrow socket accepted on a row removed after the token
  check, and a removed or de-entitled Burrow whose socket outlives the hourly
  sweep.
- **Can the rendezvous become more than a handshake pipe?** Trace a frame
  through `OneTimeRoom`: nothing may read, keep, or log it, and the length,
  type, and count bounds must close both ends before a byte past them is
  forwarded. Look for a second phone admitted across an await or a hibernation,
  a room that outlives its alarm, a web page that can mint a room, a join from
  another origin, a room id a caller can choose, and a limit a caller can step
  around. The relay is same-site with the account, so account cookies can
  ride the phone's upgrade: no one-time route or the room may read them or
  reach auth.
- **Does anything from the test or preview build reach production?** No
  production Worker may export the captured-email inbox, the deterministic
  clock, or the testing injection module; previews must not copy production
  routes, bindings, triggers, or credentials, must not call real mail, OAuth,
  or ElevenLabs, and their cleanup must check out the base branch rather than
  the closed PR's.

Does the shipped code still match what the spec and this section claim? Spec
drift is a finding; say which side is wrong.
