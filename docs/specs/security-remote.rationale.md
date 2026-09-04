# Remote Control Security — rationale

## Trust boundary

**Why a Server compromise buys no authorization.** A forged account, a forged presence
stamp, and an injected ceremony frame all arrive in front of a Host that decrypts the
request itself, recomputes the WebAuthn challenge from its *own* transcript, and checks
its own ACL under the `ConnectionPolicy` recorded at enrollment. It cannot make the
Host trust a Client the user never approved. On an established session every frame is
authenticated under a `CipherState` from a handshake the Server does not hold a key
for, and the first invalid ciphertext destroys the session rather than resynchronizing.
Web Push is no exception for confidentiality — the Host seals every notification to the
recipient's own static and the Server forwards ciphertext it holds no key for — and is
one for freshness, which is accepted residual rather than a gap the seal closes.

**Why the host-token edge exists.** A `hostToken` mints setup tokens and a setup token
is the only thing that registers an owner passkey, so account takeover is transitive
rather than direct. That is deliberate: the QR *is* the credential, so whatever can
mint one can be set up by one. It still buys no Host access for a structural reason —
pairing runs Noise IK against an invitation keypair the Host generated locally and
never sent anywhere, so the Host has no invitation to match a stolen setup token
against.

**Why `requireUserVerification` is mirrored.** The Host is the final authority, so a
Server demanding user verification while the Host did not would leave the weaker
verifier deciding.

**Why the webview can relay a confirmation safely.** Reading the two digits requires
holding the device — a relayed or injected request has no screen to read from. The
confirmation arrives as a bridge command carrying the displayed ceremony's immutable
`pairingId` and the typed digits; the service, not the webview, holds the expected code
and decides whether that ceremony is still confirmable, which is what leaves the webview
unable to choose what is authorized, to satisfy a confirmation without the phone, or to
fabricate a request. A mirrored code would make the confirmation something anything in
the webview realm could satisfy, and a leaked invitation key would let a photographed QR
be completed by whoever holds it.

**Why the pending maps need caps on both sides.** Every `e2e` frame allocates under a
`clientId` the relay chooses, in both `RemoteHost`'s client map and the service's
mirrored queue, and the only thing that removes one is a `client-gone` a hostile relay
simply never sends. Oldest-first eviction runs on both because either can be fed
independently, and a cap only one side honors is not a cap. The whole surface is
reachable by anything that can sign in — a synced or stolen passkey buys "the ability
to ask" — and these caps are what stop asking from being a denial of service.

**Why the bounds are Host-local.** A bound that needs the relay to send `client-gone`,
or a Server gate, is not a bound: the relay is the party this model assumes is hostile.
`lib/src/remote/host/remote-host-bounds.test.ts` counts the crypto a rejected frame
buys and drives every deadline off an injected clock, and
`server/test/malicious-relay.test.mjs` shows a relay holding no guards of its own
weakening none of the frame refusals those bounds sit behind.

**Why the Host revalidates a frame the relay already checked.** The relay runs its own
overlapping guard, and that is exactly why the Host cannot rely on it: the routing
values become map keys and the ciphertext becomes WebCrypto work in the process that
owns every PTY. The Client's device label gets the same treatment because it is
attacker-chosen text rendered in the one dialog the ACL rests on.

**Why the QR credentials cross outbound.** A QR that is never displayed sets up
nothing, so the Server's setup token and the invitation's public half ride out inside
`SetupQrResult.url` on purpose — which is why they are minted only on request,
single-use, and short-lived. `deliveryId` is the counter-example: it addresses a
Client's push rows, so `PushDevicesResult` carries labels only. Inbound is a different
matter because enrolling is initiated from the webview — the Settings dialog or the
`window.dormouseRemoteHost` console hook — which is why `EnrollParams` carries the
setup password by design.

**Why WebCrypto and not a JavaScript curve.** WebCrypto-only X25519 is what lets a Host
static and a Client static exist as non-extractable `CryptoKey`s rather than as bytes
in a process that owns every PTY, so a JavaScript curve is a downgrade even where it
computes the same point. ChaCha20-Poly1305 is the one bundled primitive because no
shipping WebCrypto has an interoperable one.

**Why a Noise static mismatch keeps the Host down.** Starting anyway would present a
changed Host identity to every paired Client, rather than the corrupt state file it
actually is.

**Why the lint and its self-test both run.** The lint is what makes "one suite, no
negotiation, no plaintext path, no legacy discriminant" a build failure rather than a
reading; the self-test is what keeps a rule from passing for the wrong reason, which is
a textual lint's characteristic failure.

## Where a Host may reach a relay server

**Why the build asserts the define landed.** A lost esbuild define compiles green and
shows up only as a Host silently using the shipped default instead of the selfhoster's
origins. The watch branch of the VS Code script is named explicitly because it is the
build people iterate in, and therefore where a lost define most plausibly survives.

**Why `redirect: 'error'`.** A Node process does not re-check a redirect target the way
a browser re-applies CSP, so a followed redirect could carry the setup password or the
`hostToken` outside the allowlist. That is also why any new Host→Server call goes
through `hostFetch`.

## Credentials at rest

**Where the `0o700` state directory earns its place.** On a multi-user unix host,
home-directory permissions vary by distro — `0700` on RHEL, `0755` historically on
Debian, `0750` on Ubuntu since 21.04 — so without an explicit mode, whether a second
account can read `hosts.json` depends on which distro the selfhoster happened to pick.
It buys nothing on Windows, where modes are a no-op and the profile ACL already
excludes other accounts; nothing in a container, where the namespace is the boundary;
and nothing on a serverless deployment backed by a database, where this file never
runs.

**What the Host ACL's file mode does not buy.** Neither store defends its records
against a process running as the same user, and nothing in the table claims it does — a
same-user compromise already reads the terminals.

**Why `manage verify` walks `state/` on Windows.** `server/src/state.ts`'s `0o600` is a
no-op there, so the files are covered only by what they inherit from the directory. An
enumeration that fails has to fail verify, because a directory the walk could not read
would otherwise report as one with no account in it yet.

**Why an existing `config/server.env` is preserved rather than repaired.** A file that
exists is not necessarily one an install finished writing, and a half-written file and
a hand-edited one are indistinguishable — while their repairs are opposite: `rm` for
the first, and never for the second, whose `DORMOUSE_ORIGIN` is durable WebAuthn
identity. Before this check the bind-host guard told the operator to *fix* a zero-byte
file, on every run, forever.

**Why the enrollment-offer length guards count 64.** They are stated in hex characters, so a guard
reading `-ge 32` passes a regression to half the entropy.

**Why the enrollment offer lives in `run/`.** A credential that expires in 24 hours and
is unlinked on redemption belongs in neither `config/` nor `state/`. The directory is
owner-only because it governs who may replace or delete the credential, not only who
may read it.

## The setup password

**Why the Server owns generation.** A format check can reject a short password, but cannot
distinguish 32 random bytes from 64 zeroes. Accepting the value from configuration
therefore made manual and container deployments weaker than installer deployments.
The state directory already has to persist for accounts and enrolled Hosts, so making
the credential another server-generated state record removes that choice without a
new durability requirement.

**Why the admission bucket is global.** An IP-keyed limiter would make the reverse
proxy's forwarding policy part of authentication and lets a distributed caller buy one
burst per address. One allocation-free bucket keeps the bound independent of network
topology. It gates only rare Host enrollment, so an exhausted bucket cannot interrupt
an enrolled Host, a signed-in phone, or an existing relay session.

## Cross-origin access

**What the old permissive grant rested on, and why it went.** `cors({ origin: '*' })`
was safe against CSRF — every credential is a header or body field, so no cookie
existed for a foreign origin to ride — but it left the guessing surface reachable from
any page in any browser rather than from a deliberate client, which the tailnet-only
origin was silently covering. The compatibility it bought was already stale: the
standalone webview's enrollment moved to the Node host service, and dev Pocket builds
are served from the same origin as the API.

**Why the cookie clause travels with the grant.** Either one alone is recoverable and
the pair is not: a cookie with no grant still rides a cross-site POST, and a grant with
no cookie still lets a foreign page read what a stolen bearer provokes. Auditing them
apart is how a future route reintroduces one on the reasoning that the other is absent.

## Network posture (self-hosted)

**Why the deploy lint carries a self-test.** A textual rule's characteristic failure is
passing for the wrong reason: review of the first version found three rules satisfied
by an unrelated occurrence, one of them the entropy guard's own explanatory comment.

**Why an elevated install is refused.** The install belongs to one user account and its
whole credential posture is that account owning the files; an elevated run would write
them owned by another principal and register the service for it.

**Why Funnel is not a health verdict.** Tailnet privacy is useful defense in depth, but
making it load-bearing left the setup endpoint safe only while a separate CLI reported
the intended configuration. Auditing the credential, admission, browser, and
Host-authorization boundaries directly makes accidental public exposure fail safe.

**Why `grep -q` and `head -1` are banned on these decisions.** The installers and
`manage` run under `set -o pipefail`; `grep -q` exits at the first match, and the
writer's SIGPIPE makes the pipeline 141, which an `if` reads as "no match" and an
assignment turns into an abort. Past the pipe buffer that reported an off-loopback bind
as loopback-only and — the one that mutates rather than reports — a `serve status`
carrying a foreign root mapping as no conflict at all, so
the `confirm` guarding the operator's existing Serve config never ran.

**Why the Serve checks are scoped to the root line with the port right-bounded.** `/api`
on this port is not `/` on it, and `127.0.0.1:31000` contains `127.0.0.1:3100` — either
of which skipped the conflict `confirm`, green-ticked `manage verify` on an origin
serving someone else at `/`, or made uninstall reset a root mapping this install never
owned. `SERVE_AFTER` is exempt because it asserts our own `serve --bg` landed rather
than auditing a foreign config.

**Why `serve_root_target` is held by neither enforcement.** A `| head -1` in there
raises 141 that nothing propagates: `printf` runs last, and its one caller is a `$( )`,
which bash carries no `errexit` into without `inherit_errexit` — absent from bash 3.2 —
so the parameter expansion is hygiene rather than a control. Neither fact is a property
of being in a helper: the `head -1` half of the rule binds every site whose 141 can
still reach an `if` or an assignment, which is an inline substitution always, and a
helper the moment the failing assignment is its last command or a caller invokes it
outside `$( )`.

**Why enforcement splits between two scripts.** Only
`scripts/installer-verify-test.mjs` runs installer code, so reverting
`has_off_loopback` or `serve_state` to a pipe goes red there; it cannot see
`serve_proxies_root`'s `<<<`, which only `scripts/deploy-lint.mjs`'s pattern holds.
That lint also counts the decisions consulting these helpers, since a helper whose
answer is right survives a caller that stops asking.

## What crosses the boundary

**Why the worker is the second sanitizer.** The Server used to be a second pair of eyes
on notification text and cannot be one on ciphertext — it cannot sanitize what it
cannot read — so a worker that renders what it decrypted without re-bounding it would
leave the property with one enforcer instead of two.

**Why the relay holds no state.** Only the Host knows whether a ceremony succeeded, so
a gate, a challenge memory, or a notion of an authorized session on the Server would be
a second opinion nobody asked for. Routing an opaque envelope needs no notion of what a
`DirectoryEntry` is, which is what makes a Server-side protocol-v1 type import the
leading indicator.

## Revocation and the audit trail

Both gaps are stated in this spec rather than left in a Future list for two reasons:
the audit's qualitative pass should not keep rediscovering them as findings, and a
reader deciding whether to run this needs to know that "revoke a device" is not
currently something they can do quickly.
