# Remote Security Model — rationale

> Informative companion to [remote-security-model.md](remote-security-model.md):
> the evidence, measurements, and dead-approach history behind its rules, keyed
> by that spec's headings. Nothing here is normative.

## Passkeys

**Why passkey synchronization changes nothing.** iCloud Keychain and Google
Password Manager put the same passkey on every device in the user's account, so
a credential that granted Host access would grant it to all of them at once, and
to whoever compromises the account later. The model spends the passkey on
*presence* only; the thing a Host authorizes is the per-Host Client static,
which never syncs because it never leaves the browser that generated it.

**Why both verifiers must demand the same user-presence level.** The Server and
the Host evaluate the *same* assertion. A Server demanding user verification
while the Host settles for presence leaves the weaker verifier deciding —
inverting "the Host is the final authority" through a configuration difference
rather than an attack — which is why the Server mirrors the flag into enrollment
instead of each side reading its own environment.

## Client statics

**Why possession is proven by the handshake rather than by a signature.** The
device key this replaced was an ECDSA P-256 key that signed a Host challenge in
a separate, domain-separated construction, checked as one term of a decision
that also verified an assertion. Folding the same proof into Noise IK removes
the construction entirely: `-> e, es, s, ss` cannot complete unless the
initiator holds the private half of the static it encrypted, so a Client that
reaches the authorization step has *already* proven possession, and there is no
second signature scheme to get the domain separation wrong in.

**Why per-Host rather than one key per browser.** A single browser key is a
cross-Host correlator: two Hosts comparing ACLs could tell they were looking at
the same phone. Per-Host keys cost one `generateKey` at scan time and remove
that link. The Host side is unchanged either way — it only ever sees one key.

## Host Authorization

**Why the read filter is hygiene rather than authorization.** Every field in a
persisted record is attacker-choosable by anything that can write the store at
all, so length and `hostId` checks buy nothing against that attacker; what
authorizes a record is the local approval that minted it. The filter exists to
keep malformed and foreign rows out of the conjunction, and it doubles as the
pre-cutover reader: those records carry neither E2E field, so they are dropped
rather than migrated, and the phone pairs again.

**Why a delivery id is possession-only, and why that is not anonymity.** The
Client-facing push routes have no session-scoped alternative: a session is
authenticated to an *account*, and an account may hold several Clients, so a
route keyed on the session would let one phone read or delete another's rows. A
256-bit id the Host mints at approval and hands to exactly one Client makes that
capability the only thing the route consults; listing one would turn a
capability into a directory. What it buys is access control and nothing else:
the Server still sees which endpoint each id registers, when, and against which
Host, so it hides nothing about who a subscription belongs to. Treating it as an
anonymity mechanism would be a category error, and the shared-endpoint
correlation under [Residual metadata](#residual-metadata) is the concrete shape
of that.

## Presence proofs

**Why an unbound `begin`, or a `finish` with no nonce, is refused outright.**
Either arm would be answering a challenge that nothing ties to a ceremony — a
signature the caller could then replay into a pairing or a connection it never
participated in. Refusing at the route means no code path exists that mints
presence for an unspecified purpose.

**Why the Host-side verifier never throws.** Its input is attacker-supplied
plaintext, decrypted inside the process that owns every PTY, so an exception
escaping it is a denial-of-service surface at best and an unhandled rejection
that takes the Host down at worst. A rejection is an ordinary denial with an
ordinary outcome message; nothing about the failure needs to travel as an
exception.

**Why a first run costs three authenticator prompts, and every ceremony after it
exactly one.** The three are distinct facts, each proved to a different party:
`navigator.credentials.create` mints the passkey, sign-in proves it to the
Server so a session token exists to open a relay socket with, and the presence
proof proves it to the *Host* over a challenge derived from that ceremony's own
handshake. Collapsing any pair means one party trusting another's attestation of
freshness — which is exactly the substitution "the Host is the final authority"
forbids. A Server-attested presence window would remove two prompts and hand the
Server the ability to mint presence, so the prompts are the price of the
property rather than an onboarding defect.

**Why there is no app-session signing key beside the bearer token.** A second
key would sign requests already carried over TLS to an origin the passkey is
bound to, against an attacker who by assumption cannot read that channel — no
threat in scope moves. It would also be a long-lived secret in browser storage,
which is the thing the model spends the most effort *not* having: the Client
static authorizes nothing without a fresh assertion, and a session-signing key
would authorize a Server request without one.

## Pairing

**Why the QR carries no Host static, no label, and no signature.** A first-time
Client holds nothing to check a signature against, so a signature would be
decoration. The Host static is unnecessary for the same reason the invitation
key exists: IK proves the responder holds the private half of the *scanned* key,
which is a stronger statement than matching a long-term key the Client has no
prior reason to trust. And the label is a name a person reads — putting it in a
code that a camera, a screenshot, and a photograph can all reach names the
machine to anyone who glances at the screen, while the encrypted outcome
delivers it to the one phone that completed the ceremony.

**Why a mint whose keygen straddles a teardown is refused.** `generateKey` is
async, so a relay socket can drop between the call and its resolution. Inserting
the result would leave a one-use invitation key alive for a socket that no
longer exists — a code on screen that nothing can complete, and material outside
the disposal path that tears down everything else the socket owned.

**Why the confirmation runs phone-to-Host, and why one attempt.** The person is
looking at the Host, so the Host must be the one *checking* rather than
displaying: a code the Host showed could be read by anyone who can see the
screen or a screenshot of it, while a code only the phone shows proves the
person holding the phone is the person at the keyboard. Two digits is what a
person will actually retype, and the whole 1-in-100 guess bound evaporates with
retries — a hundred attempts against a two-digit secret is not a secret. Spending
the invitation on the first wrong answer costs a QR re-render.

**Why every outcome is reported in fixed local copy.** The wire carries a
discriminant, not a message. Rendering text a peer supplied would let a hostile
Client paint "paired" on a Host that denied it, or a hostile relay paint success
on a phone whose code never matched; local copy per outcome means a mismatch
cannot be made to read as a success in either direction.

**Why an unparseable first control spends the code.** The alternative is a
retry, and a retry is what turns a single-use invitation into an oracle a peer
can probe. The step expects exactly one message shape; a peer that cannot
produce it is either broken or hostile, and in both cases the person at the Host
is about to be interrupted by a modal. Spending the code costs a re-render of a
QR and closes the loop.

**Why a resumed handshake re-checks its invitation.** Minting runs off the frame
chain and reaps synchronously, so a code can be retired — by TTL, by the cap, or
by a lost relay socket — while message 1 is still mid-flight. Reserving it
afterwards would announce a state change for an entry that is already gone,
which the QR panel would render as a scan that never happened.

## Connection

**Why a failure before `Split` gets only a generic outer error.** There is no
session to encrypt a denial on: everything before `Split` is handshake state,
and any reply would necessarily be plaintext the relay can read and a stranger
can provoke. A generic outer error tells the Server's pipe that this ceremony is
over without telling anyone which of the handshake, the challenge, or the ACL
was the reason — and without letting a flood of `init` frames buy a reply each.

## Push sealing

**Why a push needs a construction of its own.** It is the only message the two
endpoints exchange with no live session between them: the Host is awake, the
phone is asleep, and the Server holds the envelope until the push service
delivers it. Nothing in the Noise session survives that gap, and reconstructing
one would mean waking the phone to run a handshake before it could show a
notification.

**Why never a Noise `CipherState` and never Noise's HKDF.** A transport state is
a shared counter between two live speakers. A phone may receive one push, none,
or three, days apart and out of order, so a counter-based state would either
desynchronize permanently or have to tolerate gaps — which is the property Noise
transport deliberately refuses. A fresh salt-derived key per message has no
ordering to lose, and deriving it outside Noise's own HKDF keeps the push
construction from sharing a chaining key with a session it must never affect.

## Host bounds

**Why the eight-invitation cap is shared with the Server's token cap.** The two
credentials ride in one QR and die together: an invitation whose setup token has
been evicted is a code that cannot register a passkey, and a token whose
invitation is gone is a code that cannot pair. Capping both at
`MAX_TOKENS_PER_HOST` from one constant is what keeps live-on-one-side and
spent-on-the-other from drifting. A human scans one at a time, so eight is far
above any real use; what it actually bounds is a Host re-rendering its QR in a
loop, or a hostile relay provoking one.

**Why the per-`clientId` maps are capped at all.** Every ceremony frame
allocates under a `clientId` the *relay* chooses, and only a `client-gone` — a
frame a hostile relay simply never sends — removes one. Unbounded, 5000 frames
retain 5000 entries holding relay-chosen strings in the process that owns every
PTY, and the service re-serializes its whole pairing queue to the webview on
each one, so the traffic is quadratic rather than linear. Reachable by anything
that can sign in: a synced or stolen passkey is documented as buying only "the
ability to ask", and the caps are what stop asking from being a denial of
service.

**Why a pending pairing gets the pairing TTL and a pending connection the
challenge TTL.** A pairing is waiting on a human to read two digits off a phone
and type them, so its deadline is the one a person can meet; a connection is
waiting on nothing but software, so it dies with the Host challenge it was
issued against and buys no extra window.

**Why an eviction is answered, and a refused handshake is not.** Evicting a
pending pairing drops something a person may be looking at, so it sends
`superseded` and dismisses the modal. A connection `init` that never decrypted
gets nothing at all: there is no session to encrypt a denial on, and answering
would let a flood of `init` frames buy a reply each. The token bucket is
answered with silence for the same reason.

**Why one entry per relay `clientId`, even for an established session.** A
relay that reuses a `clientId` therefore takes down the session it reuses — but
that is availability the relay already holds, since it decides what is delivered
at all, and the alternative (refusing the promotion) lets the same relay lock a
phone *out* instead. Neither reaches authorization; the Client that lost its
session recovers on its own idle deadline.

**Why the session cap is checked at promotion rather than at the handshake.** A
cap applied earlier would let unauthenticated traffic decide who gets in: anyone
who can reach the relay could fill it and lock out the phones that are actually
paired. Applied after the presence proof and the ACL conjunction, the only thing
that can fill it is authorized phones.

**Why the first invalid ciphertext destroys the session.** A stream cipher has
no resynchronization point: once a nonce is in doubt there is no later frame
that can be trusted to re-anchor it, so "skip the bad one and continue" would
mean accepting an attacker's choice of where the stream resumes. Tearing down
costs the phone one reconnection.

**Why the raw frame is bounded before `JSON.parse`, and the socket gets the same
number.** Every other guard reads a value the parse already produced, so the
parse itself is the first thing an oversized frame reaches — bounding the
received string is the only check that runs ahead of it. Handing the same
number to the socket implementation's `maxPayload`, where it takes one, means an
oversized frame is refused before it is ever buffered rather than after.

**Why the reaper is armed by a timer and not only by traffic.** A Host whose
relay never delivers another frame — a hostile relay's simplest move — would
otherwise hold invitations, pending ceremonies, and idle sessions forever, since
every other trigger is an inbound event that relay controls. The timer runs on
the Host's own clock over absolute timestamps, so nothing the relay does or
withholds changes when state is reclaimed.

**Why so little refreshes the idle deadline.** Everything the spec excludes is
something a Client that has gone silent still produces — a phone in a pocket, a
relay replaying, a socket a proxy is keeping warm. Only a message this Host
decrypted on the session's own cipher is evidence the paired phone is there.

**Why losing the relay socket disposes invitations too.** The one-use key behind
a displayed code belongs to the socket it was minted over: the Client that scans
it will arrive on a *new* socket, against a Host that no longer holds the
private half, and there is no path that completes. Keeping the entry would leave
a code on screen that cannot pair and material alive that nothing will consume.

## Noise suite

**Why X25519 is WebCrypto and ChaChaPoly is bundled.** Measured 2026-06 across
the runtimes this ships to:

- **X25519** is `SubtleCrypto`-native in Safari 17+, Chrome 133+, Firefox 132+,
  and Node 18+. That matters more than convenience: only WebCrypto can hold a
  private key as a nonextractable `CryptoKey`, which is the whole reason a Host
  static survives a restart without ever existing as bytes in the process again.
- **ChaCha20-Poly1305** is in no shipping WebCrypto. `AES-GCM` is, but the Noise
  protocol name is part of the transcript, so substituting the cipher is a
  different protocol rather than a configuration choice. A pinned, audited
  JavaScript implementation was the smaller risk.

**Why a failed decrypt must not advance the counter.** The counter is shared
state between two speakers that never renegotiate it. If a rejected frame
advanced it, one injected ciphertext would put the receiver a nonce ahead of the
real sender, and every subsequent genuine frame would fail — an unauthenticated
peer locking out an authenticated one for the cost of a single packet.

**Why the vector comes from Cacophony.** An expected value computed by the
implementation under test proves only that it is self-consistent. Cacophony is
an independent Haskell implementation, so a mistake anywhere in the mixing order
fails against its published vector rather than propagating into the
expectation.

**Why the `@noble/ciphers` pin is exact, and why the note lives in the module.**
The pin's audit status is a property of one release, not of the package, so the
delta between the audited release and the pinned one is what a reader actually
needs — and they need it at the import, where a version bump is written. Keeping
the delta here as well would give a bump two places to update and one to forget,
so `server-lib-common/src/security/noise.ts`'s header is the single copy.

## Host identity

**Why the mint runs before the enrollment request.** A successful
`POST /api/host/enroll` appends a `hosts.json` row on the Server and spends the
installer's single-use token, and the Host can undo neither. Minting afterwards
means a runtime that turns out to lack X25519 has already consumed the operator's
one-shot credential and left a row nothing can use.

**Why a missing static is backfilled at start rather than gated on.** Minting
runs once, before enrollment, and is never retried afterwards — so a transient
WebCrypto failure during that one attempt would leave an enrollment the Server
has already committed and the Host can never complete. A gate with no backfill
turns that into a permanently un-enrolled machine over a moment's failure, and
the operator's only recovery is deleting `hosts.json` on the Server. The
backfill persists before the Host runs, so the alternative it replaces — a Host
running on a static it has not yet written — cannot occur either.

**Why a halves mismatch keeps the Host down.** A private half that does not
derive its recorded public half is a corrupt state file, but starting anyway
would not present it as one: the Host would come up under a *different* identity
than every paired Client has pinned, and each of those Clients would read the
change as the Host-impersonation signal it is designed to raise. Failing loudly
at boot is the only outcome that names the real fault.

**Why the probe answers `false` instead of throwing.** Its callers are boot-path
and pre-ceremony gates — the Host's start and Pocket's sign-in, setup, pairing
and connection screens — where an exception is an unhandled rejection in a
context with no error boundary. A missing WebCrypto (an insecure context, an old
runtime) must read as "unsupported, show the upgrade requirement", which is the
same answer as a curve the runtime rejects.

## Client static loss

**Where a Client static survives.** Dated platform behavior, last surveyed
2026-08:

- **iOS, browser tab.** WebKit's seven-day cap on script-writable storage
  applies to a Safari tab with no user engagement, and IndexedDB goes with it.
  A phone that pairs and is not opened for a week can come back with no static.
- **iOS, Home Screen web app.** Installed contexts are exempt from that cap and
  are also a separate storage partition — which is why a phone set up in a tab
  and then installed has to pair again, and why the install advice precedes the
  passkey rather than following it.
- **Android, Chrome.** Storage is evicted only under real pressure, and
  `navigator.storage.persist()` is granted on engagement rather than by prompt.

None of this changes the model, because loss is recoverable by re-pairing. It
changes the advice.

## Residual metadata

**Why keystroke timing is accepted rather than closed.** Closing it needs
batching or cover traffic on the Client→Host direction, which means either
holding keystrokes for a fixed quantum — latency a terminal user feels
immediately, on the one interaction the product exists for — or sending padding
frames forever, which a phone pays for in battery and a relay in bandwidth. The
leak is inter-keystroke *timing*, not values, and the party that observes it is
the one the user chose to run. A deployment that considers timing part of its
threat model needs a different transport, not a different padding policy.

**Why a shared push endpoint correlates across Hosts.** One service-worker scope
holds exactly one `PushSubscription`, and the Server stores one row per
`(hostId, deliveryId)` against the endpoint that phone presented. So every
`deliveryId` a Pocket profile registers lands on the same endpoint string, and
the Server can read off the set of Hosts one phone is paired with — which is
information the ACL deliberately keeps on each Host. Per-Host endpoints are not
available: the browser mints subscriptions per scope, and a scope per Host would
mean a service worker per Host.
