# Security

> Owns the guarantees Dormouse makes, what it does not defend, the gaps it
> knows about, and how all of it is checked. Defers every mechanism to the spec
> that owns it, and every audited check to the four specs under
> [How the guarantees are checked](#how-the-guarantees-are-checked). Published
> as written at `https://dormouse.sh/docs/security`; `docs/specs/website-docs.md`
> owns the page.

Dormouse is a terminal, so users trust it with shells, source trees,
credentials, and local files. Three things sit on that boundary. The
**dependency graph and release pipeline** decide what code reaches a machine.
**Remote control**, pairing a phone with a laptop, is the one feature that
accepts input from the network, and an authorized phone is a person at the
keyboard. And the **loopback listeners** Dormouse binds for its own surfaces
accept input from any page in the user's browser, a boundary precisely because
it does not look like one.

**Only the self-hosted deployment ships.** The relay runs on hardware the user
owns, reachable from their own tailnet ([self-host runbook](https://dormouse.sh/docs/self-host)).
Cloud-hosted operation is staged, and its boundary is re-analyzed before that
code ships ([security-application.md](./security-application.md#future)).

## Guarantees

Each guarantee names the spec that states the rule and what pins it on every
`pnpm test`. The nightly audit
([below](#how-the-guarantees-are-checked)) checks all of them; *audit* in the
last column means nothing cheaper does.

| Guarantee | Rule | Pinned by |
| --- | --- | --- |
| **Nothing but a human at the laptop can authorize a phone.** The only path into a Host's ACL is typing, on that Host, the two digits the phone shows, and the Host makes every access decision. | [Pairing](./remote-security-model.md#pairing), [Host Authorization](./remote-security-model.md#host-authorization) | `server-lib-common/test/security-guarantees.test.mjs` |
| **The Server reads nothing.** One end-to-end channel per ceremony; the relay routes ciphertext it holds no key for, so a compromised Server gains no plaintext and no authorization. | [Trust Model](./remote-security-model.md#trust-model), [Noise suite](./remote-security-model.md#noise-suite) | `scripts/e2e-lint.mjs` |
| **A push notification is sealed to the one phone that receives it.** | [Push sealing](./remote-security-model.md#push-sealing) | `server-lib-common/test/push-seal.test.mjs` |
| **A stolen or synced passkey buys sign-in, not a terminal.** Every connection also needs the phone's own paired key and a fresh presence proof bound to that connection. | [Passkeys](./remote-security-model.md#passkeys), [Presence proofs](./remote-security-model.md#presence-proofs) | `server-lib-common/test/security-guarantees.test.mjs` |
| **A hostile relay cannot exhaust a Host.** Every bound runs on the Host's own clock, and a rejected frame costs it nothing. | [Host bounds](./remote-security-model.md#host-bounds) | `lib/src/remote/host/remote-host-bounds.test.ts`, `server/test/malicious-relay.test.mjs` |
| **A Host talks only to the relay its build was pointed at**, and refuses before any credential leaves the machine. | [Where a Host may reach a relay server](./security-application.md#where-a-host-may-reach-a-relay-server) | `lib/src/host/remote/connect-src.test.ts` |
| **Credentials at rest are readable only by the account that installed them**, on macOS, Windows, and Linux alike. | [Credentials at rest](./security-application.md#credentials-at-rest) | `scripts/deploy-lint.mjs` |
| **The self-host server listens on loopback only, behind the tailnet**, and a public Funnel fails its own verification. | [Network posture](./security-application.md#network-posture-self-hosted) | `scripts/deploy-lint.mjs`, `scripts/installer-verify-test.mjs` |
| **Web Push cannot be aimed back into the tailnet.** | [What crosses the boundary](./security-application.md#what-crosses-the-boundary) | `server/test/push-endpoint.test.mjs` |
| **A loopback listener grants a stranger nothing it could not get from the upstream directly.** | [Loopback Listeners](./security-application.md#loopback-listeners) | `scripts/loopback-lint.mjs` |
| **Every dependency that reaches a machine is disclosed** at [dormouse.sh/supply-chain](https://dormouse.sh/supply-chain), and a change without the disclosure fails CI. | [Disclosure](./security-supply-chain.md#disclosure) | `.github/workflows/ci.yml` |
| **The bundled runtime is the version disclosed.** The build verifies the binary against the pin. | [Bundled runtime](./security-supply-chain.md#bundled-runtime) | `standalone/src-tauri/build.rs` |
| **No newly published dependency is adopted for 24 hours**, security fixes included. | [Cooldown and alerts](./security-supply-chain.md#cooldown-and-alerts) | audit |
| **Merging to `main` and creating a tag are admin-only**, and every workflow this repository authors pins its actions by commit. | [GitHub Actions Policies](./security-ci.md#github-actions-policies) | audit |
| **The bot maintainer cannot merge, tag, or read a release secret**, and its token never enters its own environment. | [Automated Maintainer (tend)](./security-ci.md#automated-maintainer-tend) | `.github/workflows/workflow-audit.yaml`, nightly |
| **Publishing the extension takes a second human's approval.** | [VS Code Extension Releases](./security-ci.md#vs-code-extension-releases) | audit |
| **Desktop binaries are signed offline.** CI never holds a signing or updater key, and the signing script verifies CI's attestations and hashes first. | [Desktop Releases](./security-ci.md#desktop-releases) | audit |

## What is not defended

Stated so the audit does not rediscover them and a reader deciding whether to
run this knows what they are taking on.

- **A compromised browser or operating system, on either end.** Active XSS in
  the Pocket origin can *use* the phone's key without extracting it. Exactly
  two endpoints are trusted: the distributed Host binaries and the exact Pocket
  artifact the origin serves ([Trust Model](./remote-security-model.md#trust-model)).
- **Traffic analysis.** The Server sees who talks to whom, when, how often, and
  how large each ciphertext is, and keystroke timing, never keystroke values
  ([Residual metadata](./remote-security-model.md#residual-metadata)).
- **Push replay.** A push proves confidentiality, not freshness: a Server that
  kept an envelope can re-deliver it ([Push sealing](./remote-security-model.md#push-sealing)).
- **Per-Host unlinkability.** One push endpoint per browser lets the Server see
  every Host one phone registered ([Residual metadata](./remote-security-model.md#residual-metadata)).
- **Phone-key durability.** Clearing site data means pairing again. Nothing is
  compromised; a lost key authorized nothing on its own
  ([Client static loss](./remote-security-model.md#client-static-loss)).
- **Availability.** The relay is down whenever the laptop is
  ([Goals](./remote-security-model.md#goals); [keeping it up](https://dormouse.sh/docs/self-host#keeping-the-relay-up-while-the-laptop-sleeps)).
- **The setup password's hardening is minimal**: a constant-time comparison and
  a fixed delay, with no rate limit or lockout. Accepted because the origin is
  tailnet-only and the password is 32 random bytes the installer wrote. **A
  self-host origin reachable from the internet is a different risk than the one
  analyzed** ([The setup password](./security-application.md#the-setup-password)).
- **The bot's upstream is pinned by tag, not commit**, so a hostile upstream
  could change what the bot runs without a diff here. Accepted: the trust equals
  what the harness already holds ([Automated Maintainer](./security-ci.md#automated-maintainer-tend)).
- **The Chromatic token is reachable by any workflow the bot can author.**
  Accepted with rotation; abuse is visible in Chromatic's dashboard
  ([Automated Maintainer](./security-ci.md#automated-maintainer-tend)).
- **Two signing secrets travel on a command line** for the life of one local
  call, because their tools offer nowhere else ([Desktop Releases](./security-ci.md#desktop-releases)).

## Known gaps

Gaps rather than accepted risks: we intend to close them.

- **Revocation has no mechanism.** Revoking a lost phone is editing the Host's
  ACL file and restarting the Host
  ([Revocation and the audit trail](./security-application.md#revocation-and-the-audit-trail)).
- **There is no audit trail.** Nothing records connects, attaches, denials, or
  writes ([same](./security-application.md#revocation-and-the-audit-trail)).
- **Owner checks are uneven across installers.** Linux verifies mode and owner
  on every credential path; macOS verifies modes only, and Windows the DACL but
  never the owner ([Credentials at rest](./security-application.md#credentials-at-rest)).
- **The workflow audit's window has two evasions**: a backdated committer date,
  and a branch pushed, run, and deleted before the nightly fetch
  ([Automated Maintainer](./security-ci.md#automated-maintainer-tend)).
- **The audit's three subagents share one credential.** Their contexts are
  separate; `AUDIT_PAT` is not ([Domains](./security-audit.md#domains)).
- **The notarization password sits on a command line for up to half an hour**
  per architecture; the remedy is known and not yet done
  ([Desktop Releases](./security-ci.md#desktop-releases)).
- **Two Pocket properties are verified on real hardware only**
  ([Device verification](./remote-security-model.md#device-verification)).

## How the guarantees are checked

**On every `pnpm test`**, four lints turn the cheap half of these specs into
build failures: `scripts/spec-lint.mjs` (the specs' own conventions and word
budgets), `scripts/e2e-lint.mjs` (one Noise suite, no negotiation, no
plaintext path), `scripts/deploy-lint.mjs` (every installer control, on all
three platforms), and `scripts/loopback-lint.mjs` (a new loopback bind
references a guard). **Each carries a self-test that re-introduces the thing it
forbids and requires the lint to go red**; a rule without one is a claim, not a
check. `scripts/installer-verify-test.mjs` executes the installer helpers the
lints can only read.

**Every night at 04:21 UTC, and before every VS Code release**,
`.github/workflows/security-audit.yaml` audits the repository against these
specs. Three subagents, each owning the specs below, run every `FAIL IF` as a
mechanical check with evidence, then read their domain adversarially for what
no check names. A failure, or a run that reaches no verdict, files a public
issue labeled
[`security-audit-failure`](https://github.com/diffplug/dormouse/issues?q=is%3Aissue+label%3Asecurity-audit-failure)
and holds the release; a later pass closes it. Open issues are live; closed
ones are the record of what tripped and what changed.
`scripts/security-audit-local.sh` runs the same prompts locally.
[security-audit.md](./security-audit.md) is the contract.

| Domain | Specs | Covers |
| --- | --- | --- |
| `application-security` | [security-application.md](./security-application.md) | remote control, loopback listeners, and every path no other domain claims |
| `supply-chain` | [security-supply-chain.md](./security-supply-chain.md) | the dependency graph, the lockfile, the disclosure and its generator |
| `ci-and-secrets` | [security-ci.md](./security-ci.md), [security-audit.md](./security-audit.md), this spec | GitHub Actions, the bot, releases, secrets, and the audit itself |

**Every pull request** that adds, removes, or upgrades a production dependency
fails CI until the regenerated disclosure is committed
([Disclosure](./security-supply-chain.md#disclosure)).

**Every release** ships attestations and hash manifests from CI, verified
locally before anything is signed
([Desktop Releases](./security-ci.md#desktop-releases)).

## Reporting a vulnerability

Report privately through GitHub's
[Report a vulnerability](https://github.com/diffplug/dormouse/security/advisories/new)
form, which opens an advisory visible only to you and the maintainers. It is
the right channel for anything here, and for remote control most of all: a
public issue describing a live path into a Host's ACL is a disclosure, not a
report.

**Never open a public issue, and never email the maintainer.** Include the
version or commit, the deployment (self-hosted server, standalone app, VS Code
extension), and the shortest reproduction. Every advisory is acknowledged with
what we intend to do about it. There is no bounty, and a fix that needs a
coordinated release says so in the advisory rather than promising a date; this
is a one-maintainer project and nothing here promises a response time it cannot
keep.

- **FAIL IF** private vulnerability reporting is disabled on the repository
  (`gh api repos/diffplug/dormouse/private-vulnerability-reporting` must report
  `enabled: true`): the advisory form is the only channel this spec offers, and
  a disabled one sends a reporter to a public issue.
