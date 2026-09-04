# Domain: application-security

**Scope — these specs, and no others:**

- `docs/specs/security-local.md`
- `docs/specs/security-remote.md`

**Output file:** `audit-application.md`

This is a code-and-specs audit of the product's own boundaries — the remote
control stack, and the local application. You need no GitHub API access and no
PAT — do not use one.

Read, at minimum: `docs/specs/remote-security-model.md` **and its paired
`docs/specs/remote-security-model.rationale.md`**, `docs/specs/relay.md`,
`docs/specs/remote-api.md`, `docs/specs/pocket-app.md`, `SELF_HOST.md`, and then
the code they point at — `remote-lib-common/src/security/`, `relay/src/`,
`lib/src/remote/`, `lib/src/host/remote/`, `vscode-ext/src/burrow*.ts`,
`scripts/csp-defaults.mjs`, and all three installers —
`deploy/local/install-macos.sh`, `deploy/local/install-windows.ps1`, and
`deploy/local/install-linux.sh`. The three hold the same invariants through
different native mechanisms, so read them against each other: a control present
in one and quietly absent from another is a finding.

The end-to-end boundary is where the depth goes. Its modules are
`remote-lib-common/src/security/noise.ts`, `noise-transport.ts`,
`e2e-ceremony.ts`, `e2e-bounds.ts`, `token-bucket.ts`, `push-seal.ts`,
`pairing-invitation.ts`, `presence.ts` and `acl.ts`;
`remote-lib-common/src/remote/wire.ts` (the frame shapes and their guards);
`lib/src/remote/burrow/burrow-runtime.ts` (both ceremonies, every Burrow bound);
`lib/src/remote/burrow/push-delivery.ts`; `lib/src/remote/client/pocket-client.ts`
and `lib/src/remote/pocket-app/sw.ts` (the phone, and the render sink);
`relay/src/relay.ts` and `relay/src/app.ts` (which must know none of it). The
harnesses that already exercise this are
`lib/src/remote/burrow/burrow-bounds.test.ts`,
`relay/test/malicious-relay.test.mjs`,
`remote-lib-common/test/security-guarantees.test.mjs`,
`remote-lib-common/test/noise.test.mjs`, and `remote-lib-common/test/push-seal.test.mjs`
— read what they *do not* cover, and say so.

For `## Loopback Listeners`, read `lib/src/host/loopback-guard.ts` first — it
states the rule — then each listener it names. Derive the set of listeners by
searching the shipped trees yourself; the section's own list is a description of
today's tree, not the scope.

For the rest of `docs/specs/security-local.md`, read each section's owner first
— `docs/specs/terminal-escapes.md`, `docs/specs/dor-browser.md`,
`docs/specs/dor-cli.md`, `docs/specs/vscode.md` -> "Webview message
authentication", `docs/specs/standalone.md` -> "Persistence" — then the parser,
the iframe shim, the control-socket code, and the persistence path they point
at. The attacker there is a program printing to the terminal, a page in a
browser pane, or another local account, never the network.

## Qualitative pass

Be adversarial, and go past the `FAIL IF` list. Ask specifically:

- **Would public Funnel exposure change any security conclusion?** Assume the
  entire HTTPS origin is reachable from the public internet; reliance on a
  source IP, tailnet membership, or Funnel being off is a finding. Hunt for what
  the `FAIL IF` pass cannot name: an unauthenticated caller that grows a durable
  collection, retains a timer or socket, or amplifies a request. Then trace what
  a stolen bootstrap credential grants — no Client reaches a terminal without
  approval on that Burrow. Availability is out of scope; attacker-grown retained
  state is not.
- **Can an operator choose the bootstrap credential?** Trace first boot from the
  entrypoint through generation and atomic persistence: it must be 32 Relay-CSPRNG
  bytes in owner-only state, never an environment, argument, installer, or weak
  default; `DORMOUSE_SETUP_PASSWORD` must not be a runtime input. A malformed
  existing record must stop startup rather than rotate the credential or fall
  back to configuration.
- Can anything reach a Burrow's ACL without a human approving on that Burrow? Trace
  every writer — including the ACL read filter, anything that rehydrates a
  record from disk, and what a compromised webview or a compromised Relay could
  send. The two-digit confirmation is the whole gate: check that the expected
  code never leaves the Burrow process, that the comparison happens exactly once
  per ceremony and against the ceremony's immutable `pairingId`, and that no
  path lets a mismatch, a timeout, or a superseded request end anywhere but
  spending the invitation.
- **Is the relay actually opaque?** The Relay must be unable to read a pairing
  decision, a Burrow label, a remote-api message, a terminal byte, or a
  notification's text. Look for anywhere plaintext could re-enter: a debug log
  of a decoded frame, a Relay-side type import from the protocol-v1 half of
  `wire.ts`, a route that inspects a sealed payload, a metric derived from
  content rather than size.
- **Can a forged or replayed frame do anything?** Assume the relay is hostile:
  it may invent `clientId`s, reorder, drop `client-gone`, replay old ciphertext,
  and inject frames of its own choosing. What does the Burrow allocate, decrypt,
  or answer before it has authenticated anything? Is every bound enforced on the
  Burrow's own clock, with no Relay gate standing in?
- **Is the presence proof bound to *this* ceremony?** Trace the challenge from
  `presenceChallenge` through `/api/reauth/*` to `verifyPresenceProof`: every
  binding field must equal what the Burrow built from its own state, the Relay
  nonce must be single-use, and a Relay "success" flag must never be evidence.
  Can an assertion captured in one ceremony, one Burrow, or one kind be replayed
  in another?
- **Is authorization the four-field conjunction on one record?** Account, passkey
  credential, that key's hash, and the IK-authenticated Client static, all on the
  same active `BurrowAclRecord`. Halves matching on different records, or a static
  the payload merely claimed rather than one the handshake authenticated, are
  both authorization bypasses.
- **Is an invitation reserved exactly once?** One QR, one Noise message 1 that
  decrypts, one pairing. Check the reservation against concurrency and against
  the cap: can two mints overlap past `MAX_TOKENS_PER_BURROW`, can a code be
  reserved after it was retired, can a failed handshake spend one?
- **Is a push readable by anything but its recipient?** One sealed envelope per
  ACL record, a fresh salt per message, the all-zero nonce spent once per key,
  the Burrow's private half never leaving WebCrypto, and the service worker as the
  only opener *and* the sanitization sink — the Relay can no longer be the
  second pair of eyes it was.
- **Is the Burrow's own static in exactly one place?** Minted locally, never sent,
  imported non-extractably, halves checked to correspond before the Burrow starts,
  and the PKCS#8 in the state file the only copy outside WebCrypto.
- Can a credential (`burrowToken`, setup password, VAPID private key, session
  token, a Client's `deliveryId`, an invitation's private half) reach a process,
  a file mode, a log line, or a wire frame it should not?
- Does any check the Relay performs stand in for one the Burrow must perform
  itself?
- Where does untrusted input enter — relay frames, push endpoints, terminal
  bytes, notification text, state files read back from disk — and what happens
  on a malformed, oversized, or hostile value?
- Does the iframe proxy replace framing controls with exactly `'self'` plus the
  fully validated app ancestor chain, and only when that chain is usable? Treat
  `'self'` as the explicit same-grant nesting relaxation: confirm each grant is
  one origin bound to one upstream, no wildcard or foreign source is admitted,
  and the no-chain path preserves the upstream controls and injects no shim.
  Trace nested shim messages too: each hop must accept only its proxy origin,
  reconstruct and relay only the registered pane-level shapes, never relay a
  nested document's location, and target only that origin plus the validated
  app origin—never a wildcard or foreign origin.
- Does the shipped code still match what the specs and this section claim? Spec
  drift is a finding; say which side is wrong. The newest sections are the ones
  most likely to have drifted: `remote-security-model.md`'s Presence proofs,
  Pairing, Connection, Push sealing, Burrow bounds, Noise suite and Burrow identity,
  and `relay.md`'s Relay and E2E framing. `scripts/e2e-lint.mjs` mechanizes the
  structural half of that ("one suite, no negotiation, no plaintext path, no
  legacy discriminant") — check that each of its rules still names a real
  `docs/specs/security-remote.md` line and that
  `scripts/e2e-lint-selftest.mjs` still proves every rule load-bearing, then
  look for what a *textual* lint cannot see.

You are also the **catch-all** domain, and this is defined by subtraction, not
by a list: you own everything in the repository that `supply-chain.md` and
`ci-and-secrets.md` do not explicitly claim. Run `ls -A` and work out the
remainder rather than trusting any enumeration — an enumeration goes stale the
moment someone adds a directory, which is exactly how `.vscode/` and
`.impeccable/` ended up owned by nobody.

Subtraction is **recursive, not top-level**. Where another domain claims a
subdirectory rather than a whole tree, the rest of that tree is yours — so
check one level down wherever a claim is partial, or the same orphaning
happens inside a directory instead of beside it. `website/` is *not* an
example of this any more: `supply-chain` claims all of it except
`website/public/`, so none of it is yours. That was fixed by stating the claim
as a subtraction rather than as two named subdirectories, which is the shape
to prefer when you find the next one.

Today the remainder is `lib/`, `relay/`, `remote-lib-common/`, `standalone/`,
`vscode-ext/`, `dor/`, `dor-lib-common/`, `canopy/`, `deploy/`, `docs/`,
`.impeccable/`, and the root files — but treat that as a description of the
current tree, not as your scope. Your scope is the remainder.

Remote control is where the depth goes; the rest is a sweep for anything that
would be a security hole in a terminal that runs local shells — command
construction, path handling, deserialization of persisted state, IPC that
crosses a trust boundary.
