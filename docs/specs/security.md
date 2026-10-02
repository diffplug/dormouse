# Security

> See `docs/specs/glossary.md` for Session, Pane, Surface, and remote-role vocabulary.
> Owns the guarantees Dormouse makes, what it does not defend, the gaps it
> knows about, and how all of it is checked. Defers every mechanism to the spec
> that owns it, and every audited check to the specs under
> [How the guarantees are checked](#how-the-guarantees-are-checked). Published
> at `https://dormouse.sh/security`, whole but for the three blocks split
> by audience; `docs/specs/website-docs.md` owns the page.

Dormouse holds shells, source trees, credentials, and local files. Its
**dependencies and release pipeline** determine what code reaches a machine;
**remote control** admits an authorized phone as a person at the keyboard;
**loopback listeners** receive requests from pages in the user's browser.

**Remote control supports relay-backed sessions and direct one-time connections.**
The Relay can be self-hosted; Hosted implements admin-entitled enrollment,
account-scoped relay routing, and Pocket, with live production controls and paid-service
acceptance requiring verification ([Hosted](./hosted.md)). **Hosted account sign-in alone grants
no terminal access.** Pairing and presence remain the Burrow's decision.
Hosted also serves the one-time phone page and forwards only that connection's
handshake ciphertext, authorizing nothing
([Hosted rendezvous](./one-time.md#hosted-rendezvous)); its deployment pipeline and
Cloudflare account are part of a one-time session's trust base.

A self-hosted Relay runs on hardware the user owns; the default installer keeps
it private to the tailnet, while the application boundary permits a public HTTPS
origin ([SELF_HOST.md](../../SELF_HOST.md)). **Remote access starts only when a
Burrow enrolls with a Relay or opens a one-time link**; a link admits one phone
for one session. Paid cloud operation still needs the review under
[Cloud-hosted mode](./security-remote.md#cloud-hosted-mode).

## Guarantees

Each guarantee names its owning rule and automated checks. The
[nightly audit](#how-the-guarantees-are-checked) checks all of them; *audit* in the
last column identifies a property without a cheaper automated check. Native
Cargo tests run in separate CI jobs, outside root `pnpm test`.

| Guarantee | Rule | Pinned by |
| --- | --- | --- |
| **Terminal output cannot write your clipboard or steal focus.** File access requires a user action or a running designated Tool's gated OSC 367 `open`. OSC 52 only offers a copy format; links require confirmation or an allowed local preview, and deceptive links have no open action. | [Terminal output](./security-local.md#terminal-output) | `lib/src/lib/terminal-protocol.test.ts`, `lib/src/lib/external-links.test.ts`, `lib/src/lib/terminal-link-activation.test.ts`, `lib/src/components/ExternalLinkModalHost.test.tsx` |
| **A page in a browser pane cannot forge a host message.** | [Browser panes](./security-local.md#browser-panes) | `lib/src/lib/platform/vscode-adapter.test.ts` |
| **Only your own account can drive your terminals through `dor`.** Its token never crosses the wire. | [The dor control socket](./security-local.md#the-dor-control-socket) | `standalone/sidecar/dor-control-server.test.js` |
| **A loopback listener grants a stranger nothing it could not get from the upstream directly.** | [Loopback Listeners](./security-local.md#loopback-listeners) | `scripts/loopback-lint.mjs` |
| **Current persistence writers never save terminal scrollback.** Standalone snapshots are owner-only; VS Code controls access to its own storage. Older snapshots may contain transcripts. | [Persisted state](./security-local.md#persisted-state) | `cargo test` in `standalone/src-tauri` (the owner-only half); audit |
| **Phone authorization requires local confirmation at the Burrow, which makes every access decision.** | [Pairing](./remote-security-model.md#pairing), [Burrow Authorization](./remote-security-model.md#burrow-authorization) | `remote-lib-common/test/security-guarantees.test.mjs` |
| **A one-time connection is one session, confirmed at the laptop, with nothing saved at either end.** Terminal traffic runs directly between the devices under Settings → Network; Hosted carries only the handshake. | [One-time connection](./remote-security-model.md#one-time-connection), [its checks](./security-remote.md#one-time-connection) | `lib/src/remote/client/one-time-e2e.test.ts`, `scripts/e2e-lint.mjs` |
| **The Relay cannot read ceremony or terminal content or grant terminal access.** Account data and routing metadata remain visible. | [Trust Model](./remote-security-model.md#trust-model), [Residual metadata](./remote-security-model.md#residual-metadata) | `scripts/e2e-lint.mjs` |
| **Push notifications are opt-in, and a push is sealed to the one phone that receives it.** | [Push sealing](./remote-security-model.md#push-sealing) | `remote-lib-common/test/push-seal.test.mjs` |
| **A stolen or synced passkey buys sign-in, not a terminal.** Every connection also needs the phone's own paired key and a fresh presence proof bound to that connection. | [Passkeys](./remote-security-model.md#passkeys), [Presence proofs](./remote-security-model.md#presence-proofs) | `remote-lib-common/test/security-guarantees.test.mjs` |
| **The Burrow bounds remote session state and handshake admission independently of the Relay.** Deadlines use its own clock. | [Burrow bounds](./remote-security-model.md#burrow-bounds) | `lib/src/remote/burrow/burrow-bounds.test.ts`, `relay/test/malicious-relay.test.mjs` |
| **Under Settings → Network → Nothing, a new install's level, Dormouse opens no connection on its own**: no relay socket, one-time link, push, managed voice, or update check. What you click, and what your terminals and browser panes reach, are yours. | [Network policy](./security-local.md#network-policy) | `lib/src/host/remote/service.test.ts`, `lib/src/host/managed-voice-host.test.ts`, `standalone/src/updater.test.ts` |
| **A Burrow talks only to the one relay origin its build was pointed at, and a self-host build contacts Dormouse's servers only when you click a link.** A stock build reaches only Hosted. | [Relay origin](./security-remote.md#relay-origin) | `lib/src/host/relay-origin.test.ts` |
| **The self-host installer restricts Relay credentials to the installing account**, on macOS, Windows, and Linux; Burrow enrollment uses protected app storage or VS Code's secret storage. Installer owner-check gaps are listed below. | [Credentials at rest](./security-remote.md#credentials-at-rest) | `scripts/deploy-lint.mjs` |
| **The self-host HTTPS origin may be public; its plaintext backend may not.** Enrollment is admission-limited, cross-origin browsers receive no grant, and terminal access still requires local Burrow approval. | [The setup password](./security-remote.md#the-setup-password), [Cross-origin access](./security-remote.md#cross-origin-access), [Network posture](./security-remote.md#network-posture-self-hosted) | `relay/test/setup-password-store.test.mjs`, `relay/test/config.test.mjs`, `relay/test/token-bucket.test.mjs`, `relay/test/cors.test.mjs`, `scripts/deploy-lint.mjs` |
| **Push, when enabled, cannot be aimed back into the tailnet.** | [What crosses the boundary](./security-remote.md#what-crosses-the-boundary) | `relay/test/push-endpoint.test.mjs` |
| **Every dependency Dormouse puts on a user's machine is disclosed** at [dormouse.sh/supply-chain](https://dormouse.sh/supply-chain), and a change without the disclosure fails CI. | [Disclosure](./security-supply-chain.md#disclosure) | `.github/workflows/ci.yml` |
| **The bundled runtime is the version disclosed.** The build verifies the binary against the pin. | [Bundled runtime](./security-supply-chain.md#bundled-runtime) | `standalone/src-tauri/build.rs` |
| **Dependency adoption has at least a 24-hour cooldown**, except audited pgstencil releases approved with 2FA. | [Cooldown and alerts](./security-supply-chain.md#cooldown-and-alerts) | audit |
| **Merging to `main` and creating a tag are admin-only**, and every workflow this repository authors pins its actions by commit. | [GitHub Actions Policies](./security-ci.md#github-actions-policies) | audit |
| **The bot maintainer cannot merge, tag, or read a release secret**, and its token never enters its own environment. | [Automated Maintainer (tend)](./security-ci.md#automated-maintainer-tend) | `.github/workflows/workflow-audit.yaml`, nightly |
| **Publishing the extension takes a second human's approval.** | [VS Code Extension Releases](./security-ci.md#vs-code-extension-releases) | audit |
| **Desktop binaries are signed locally.** CI never holds production signing or updater keys, and the signing script verifies CI's attestations and hashes first. | [Desktop Releases](./security-ci.md#desktop-releases) | `scripts/sign-and-deploy.test.mjs` |

## What is not defended

- **A process running as you.** `dor`, its socket, and every file mode bound
  other local accounts, never a program already running under your own account;
  an agent holding `dor` has exactly the power of the person at the keyboard
  ([The dor control socket](./security-local.md#the-dor-control-socket)).
- **The Windows `dor` pipe carries no ACL of ours.** A named pipe has no
  directory to harden, so an unguessable name and the token handshake are the
  whole of it ([The dor control socket](./security-local.md#the-dor-control-socket)).
- **What VS Code does with the pane state it stores.** Structure persists in VS
  Code's own storage under its modes, never a transcript
  ([Persisted state](./security-local.md#persisted-state)).
- **A compromised browser or operating system, on either end.** Active XSS in
  the Pocket origin can use the phone's key and, with encrypted fallback storage,
  extract its private bytes ([Client statics](./remote-security-model.md#client-statics)). Exactly
  two endpoints are trusted: the distributed Burrow binaries and the exact Pocket
  artifact the origin serves ([Trust Model](./remote-security-model.md#trust-model));
  a one-time session also trusts the page Hosted serves
  ([One-time connection](./remote-security-model.md#one-time-connection)).
- **Traffic analysis.** The Relay sees who talks to whom, when, how often, and
  how large each ciphertext is, and keystroke timing, never keystroke values
  ([Residual metadata](./remote-security-model.md#residual-metadata)). An
  authorized session may move onto a direct connection between the two devices,
  after which the Relay sees that the session exists and nothing about its
  traffic ([Direct path](./remote-security-model.md#direct-path)). Hosted's
  one-time rendezvous sees a handshake's timing, addresses, and frame sizes,
  and Cloudflare's STUN server sees every Hosted-served phone's public address, and
  under Anywhere this computer's ([Direct path](./security-remote.md#direct-path)).
- **Push replay, when push is enabled.** A push proves confidentiality, not freshness: a Relay that
  kept an envelope can re-deliver it ([Push sealing](./remote-security-model.md#push-sealing)).
- **Per-Burrow unlinkability, when push is enabled.** One push endpoint per browser lets the Relay see
  every Burrow one phone registered ([Residual metadata](./remote-security-model.md#residual-metadata)).
- **Phone-key durability.** Clearing site data means pairing again. Nothing is
  compromised; a lost key authorized nothing on its own
  ([Client static loss](./remote-security-model.md#client-static-loss)).
- **Availability.** Remote terminal access needs an online Burrow and, for
  new relay-backed sessions, an available Relay
  ([Goals](./remote-security-model.md#goals); [keeping it up](../../SELF_HOST.md#keeping-the-relay-up-while-the-laptop-sleeps)).
- **The bot's upstream is pinned by tag, not commit**, so a hostile upstream
  could change what the bot runs without a diff here. Accepted: the trust equals
  what the harness already holds ([Automated Maintainer](./security-ci.md#automated-maintainer-tend)).
- **The Chromatic and Argos tokens are reachable by any workflow the bot can author.**
  Accepted with rotation; each dashboard shows abuse
  ([Automated Maintainer](./security-ci.md#automated-maintainer-tend)).

## Known gaps

Gaps rather than accepted risks: we intend to close them.

- **Browser-pane scripts share loopback cookies across grant ports.** HTTP and
  WebSocket cookie headers are stripped, but `document.cookie` remains shared;
  cookie-authenticated iframe pages are unsupported
  ([Loopback Listeners](./security-local.md#loopback-listeners)).
- **Browser screenshots and pasted clipboard images inherit parent ACLs on Windows.**
  ([Browser panes](./security-local.md#browser-panes)).
- **Neither VS Code's peer-link token, its Tool trust receipts, nor the
  `recovery.json` beside them carries a Windows ACL applied by Dormouse.**
  They are written owner-only by unix mode, which Windows makes a no-op;
  standalone locks its state directory instead
  ([Persisted state](./security-local.md#persisted-state)).
- **The standalone log file is written at the umask** and records the `dor`
  socket path ([Persisted state](./security-local.md#persisted-state)).
- **Revocation has no mechanism.** Revoking a lost phone is editing the Burrow's
  ACL file and restarting the Burrow
  ([Revocation and the audit trail](./security-remote.md#revocation-and-the-audit-trail)).
- **There is no structured audit trail** covering connects, attaches, denials,
  or writes ([same](./security-remote.md#revocation-and-the-audit-trail)).
- **The workflow audit can miss malicious changes**
  ([Automated Maintainer](./security-ci.md#automated-maintainer-tend)).
- **Audit domains share one credential.** Their contexts are separate;
  `AUDIT_PAT` is not ([Domains](./security-audit.md#domains)).
- **The notarization password sits on a command line for up to half an hour**
  per architecture; the remedy is known and not yet done
  ([Desktop Releases](./security-ci.md#desktop-releases)).
- **Pocket Home Screen camera verification requires real iOS hardware**
  ([Device verification](./remote-security-model.md#device-verification)).

## How the guarantees are checked

Root `pnpm test` runs the JavaScript checks and lint mutation suites; native
Cargo CI jobs test platform-specific persistence. `package.json` owns the root
suite, and [Specs in AGENTS.md](../../AGENTS.md#specs) maps its lints to their
owning contracts. A mutation test must make its protected rule fail;
`scripts/installer-verify-test.mjs` executes installer helpers the lints only read.

**Every night at 04:21 UTC, and before every VS Code release**, the
[security audit](./security-audit.md#schedule-and-gate) executes every audited
clause and reads each domain adversarially for holes no check names. Its
[Domains](./security-audit.md#domains) own the disjoint scopes and prompts.
A failure or inconclusive run files a public
issue labeled
[`security-audit-failure`](https://github.com/diffplug/dormouse/issues?q=is%3Aissue+label%3Asecurity-audit-failure)
and holds the release; a later pass closes it. Open issues are live; closed
ones record what tripped and changed. `scripts/security-audit-local.sh` runs
the same prompts locally. pgstencil audits the packages Hosted consumes in
its own repository.

Production dependency changes require committed regenerated
[disclosure](./security-supply-chain.md#disclosure). Desktop release artifacts
carry CI attestations and hash manifests, verified locally before
[signing](./security-ci.md#desktop-releases).

Source of truth: root scripts in `package.json`; native jobs in
`.github/workflows/ci.yml`; `.github/workflows/security-audit.yaml` and its
release gate in `.github/workflows/release.yml`.

## Reporting a vulnerability

**Must report vulnerabilities privately** through GitHub's
[Report a vulnerability](https://github.com/diffplug/dormouse/security/advisories/new)
form, visible only to the reporter and maintainers. **Never open a public issue
or email the maintainer.** Include the version or commit, deployment
(self-hosted Relay, Hosted, standalone app, or VS Code extension), and shortest
reproduction. Every advisory is acknowledged with intended next steps; there
is no bounty or promised response time. A coordinated-release requirement is
communicated in the advisory.

- **FAIL IF** private vulnerability reporting is disabled on the repository
  (`gh api repos/diffplug/dormouse/private-vulnerability-reporting` must report
  `enabled: true`): the advisory form is the only channel this spec offers, and
  a disabled one sends a reporter to a public issue.
