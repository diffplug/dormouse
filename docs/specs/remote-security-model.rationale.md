# Remote Security Model — rationale

> Informative companion to [remote-security-model.md](remote-security-model.md):
> the evidence, measurements, and dead-approach history behind its rules, keyed
> by that spec's headings. Nothing here is normative.

## Passkeys

**Why passkey synchronization changes nothing.** iCloud Keychain and Google
Password Manager put the same passkey on every device in the user's account, so
a credential that granted Host access would grant it to all of them at once, and
to whoever compromises the account later. What a Host authorizes instead never
syncs: the per-Host Client static never leaves the browser that generated it.

**Why both verifiers must demand the same user-presence level.** Both evaluate
the *same* assertion, so a Server demanding user verification while the Host
settles for presence leaves the weaker verifier deciding — inverting "the Host
is the final authority" through a configuration difference rather than an
attack. Mirroring the flag into enrollment stops each side reading its own
environment.

## Client statics

**Why possession is proven by the handshake rather than by a signature.** The
dead approach was an ECDSA P-256 device key signing a Host challenge in a
separate, domain-separated construction, checked as one term of a decision that
also verified an assertion. Noise IK removes the construction entirely:
`-> e, es, s, ss` cannot complete unless the initiator holds the private half of
the static it encrypted, leaving no second signature scheme to get the domain
separation wrong in.

**Why per-Host rather than one key per browser.** A single browser key is a
cross-Host correlator: two Hosts comparing ACLs could tell they were looking at
the same phone. Per-Host keys cost one `generateKey` at scan time and remove
that link. The Host side is unchanged either way — it only ever sees one key.

## Host Authorization

**Why the read filter is hygiene rather than authorization.** Every field in a
persisted record is attacker-choosable by anything that can write the store at
all, so length and `hostId` checks buy nothing against that attacker; what
authorizes a record is the local approval that minted it. The filter doubles as
the pre-cutover reader: those records carry neither E2E field, so they are
dropped rather than migrated, and the phone pairs again.

**Why a delivery id is possession-only, and why that is not anonymity.** The
Client-facing push routes have no session-scoped alternative: a session is
authenticated to an *account*, and an account may hold several Clients, so a
route keyed on the session would let one phone read or delete another's rows;
listing one would turn a capability into a directory. What the id buys is access
control and nothing else — the Server still sees which endpoint each id
registers, when, and against which Host. The shared-endpoint correlation under
[Residual metadata](#residual-metadata) is the concrete shape of that.

## Presence proofs

**Why an unbound `begin`, or a `finish` with no nonce, is refused outright.**
Either arm answers a challenge that nothing ties to a ceremony — a signature the
caller could replay into a pairing or a connection it never participated in.
Refusing at the route leaves no code path that mints presence for an unspecified
purpose.

**Why the Host-side verifier never throws.** Its input is attacker-supplied
plaintext, decrypted inside the process that owns every PTY, so an exception
escaping it is a denial-of-service surface at best and an unhandled rejection
that takes the Host down at worst.

**Why a first run costs three authenticator prompts, and every ceremony after it
exactly one.** The three are distinct facts, each proved to a different party:
`navigator.credentials.create` mints the passkey, sign-in proves it to the
Server for the session token a relay socket needs, and the presence proof proves
it to the *Host* over that ceremony's own handshake. Collapsing any pair means
one party trusting another's attestation of freshness — the substitution "the
Host is the final authority" forbids. The rejected alternative, a
Server-attested presence window, removes two prompts by handing the Server the
ability to mint presence.

**Why there is no app-session signing key beside the bearer token.** A second
key would sign requests already carried over TLS to an origin the passkey is
bound to, against an attacker who by assumption cannot read that channel — no
threat in scope moves. It would also be a long-lived secret in browser storage
that authorizes a Server request with no fresh assertion behind it, where the
Client static authorizes nothing without one.

## Pairing

**Why the QR carries no Host static, no label, and no signature.** A first-time
Client holds nothing to check a signature against. The Host static is
unnecessary for the same reason the invitation key exists: IK proves the
responder holds the private half of the *scanned* key, a stronger statement than
matching a long-term key the Client has no prior reason to trust. The label
names the machine to anyone who glances at a code a camera, a screenshot, and a
photograph can all reach; the encrypted outcome delivers it to the one phone
that completed the ceremony.

**Why a mint whose keygen straddles a teardown is refused.** `generateKey` is
async, so a relay socket can drop between the call and its resolution. Inserting
the result would leave a one-use invitation key alive for a socket that no
longer exists — a code on screen that nothing can complete, and material outside
the disposal path that tears down everything else the socket owned.

**Why the confirmation runs phone-to-Host, and why one attempt.** The person is
looking at the Host, so the Host must be the one *checking*: a code the Host
showed could be read by anyone who can see the screen or a screenshot of it,
while a code only the phone shows proves the person holding the phone is the
person at the keyboard. Two digits is what a person will actually retype, and
the 1-in-100 guess bound evaporates with retries — a hundred attempts against a
two-digit secret is not a secret. Spending the invitation on a wrong answer
costs a QR re-render.

**Why every outcome is reported in fixed local copy.** Rendering text a peer
supplied would let a hostile Client paint "paired" on a Host that denied it, or
a hostile relay paint success on a phone whose code never matched — a mismatch
made to read as a success in either direction.

**Why an unparseable first control spends the code.** The rejected alternative
is a retry, and a retry turns a single-use invitation into an oracle a peer can
probe. A peer that cannot produce the one message shape the step expects is
either broken or hostile, and in both cases the person at the Host is about to
be interrupted by a modal.

**Why a resumed handshake re-checks its invitation.** Minting runs off the frame
chain and reaps synchronously, so a code can be retired — by TTL, by the cap, or
by a lost relay socket — while message 1 is still mid-flight. Reserving it
afterwards would announce a state change for an entry that is already gone,
which the QR panel would render as a scan that never happened.

## Connection

**Why a failure before `Split` gets only a generic outer error.** There is no
session to encrypt a denial on: everything before `Split` is handshake state,
and any reply would be plaintext the relay can read and a stranger can provoke.
A generic outer error ends the ceremony on the Server's pipe without naming
which of the handshake, the challenge, or the ACL was the reason — and without
letting a flood of `init` frames buy a reply each.

## Push sealing

**Why a push needs a construction of its own.** The Host is awake, the phone is
asleep, and the Server holds the envelope until the push service delivers it.
Nothing in the Noise session survives that gap, and reconstructing one would
mean waking the phone to run a handshake before it could show a notification.

**Why never a Noise `CipherState` and never Noise's HKDF.** A transport state is
a shared counter between two live speakers. A phone may receive one push, none,
or three, days apart and out of order, so a counter-based state would either
desynchronize permanently or tolerate gaps — the property Noise transport
refuses. A fresh salt-derived key per message has no ordering to lose, and
deriving it outside Noise's own HKDF keeps the push construction from sharing a
chaining key with a session it must never affect.

## Host bounds

**Why the eight-invitation cap is shared with the Server's token cap.** The two
credentials ride in one QR and die together: an invitation whose setup token has
been evicted is a code that cannot register a passkey, and a token whose
invitation is gone is a code that cannot pair. One `MAX_TOKENS_PER_HOST` keeps
live-on-one-side and spent-on-the-other from drifting. A human scans one at a
time, so eight is far above any real use; what it bounds is a Host re-rendering
its QR in a loop, or a hostile relay provoking one.

**Why the per-`clientId` maps are capped at all.** Every ceremony frame
allocates under a `clientId` the *relay* chooses, and only a `client-gone` — a
frame a hostile relay simply never sends — removes one. Unbounded, 5000 frames
retain 5000 entries holding relay-chosen strings in the process that owns every
PTY, and the service re-serializes its whole pairing queue to the webview on
each one, so the traffic is quadratic rather than linear. Anything that can sign
in reaches it: a synced or stolen passkey buys only "the ability to ask", which
the caps keep from becoming a denial of service.

**Why a pending pairing gets the pairing TTL and a pending connection the
challenge TTL.** A pairing is waiting on a human to read and retype two digits,
so its deadline is the one a person can meet; a connection is waiting on nothing
but software, so it dies with the Host challenge it was issued against and buys
no extra window.

**Why an eviction is answered, and a refused handshake is not.** Evicting a
pending pairing drops something a person may be looking at, so it sends
`superseded` and dismisses the modal. A connection `init` that never decrypted,
and a frame the token bucket refused, get nothing at all, for the reason under
[Connection](#connection).

**Why one entry per relay `clientId`, even for an established session.** A relay
that reuses a `clientId` takes down the session it reuses — availability the
relay already holds, since it decides what is delivered at all — and the
rejected alternative, refusing the promotion, lets the same relay lock a phone
*out* instead. Neither reaches authorization; the Client that lost its session
recovers on its own idle deadline.

**Why the session cap is checked at promotion rather than at the handshake.** A
cap applied earlier would let unauthenticated traffic decide who gets in: anyone
who can reach the relay could fill it and lock out the phones that are actually
paired.

**Why the first invalid ciphertext destroys the session.** A stream cipher has
no resynchronization point: once a nonce is in doubt there is no later frame
that can be trusted to re-anchor it, so "skip the bad one and continue" would
mean accepting an attacker's choice of where the stream resumes. Tearing down
costs the phone one reconnection.

**Why the raw frame is bounded before `JSON.parse`, and the socket gets the same
number.** Every other guard reads a value the parse already produced, so the
parse is the first thing an oversized frame reaches and bounding the received
string is the only check ahead of it. The same number at the socket
implementation's `maxPayload` refuses an oversized frame before it is buffered
rather than after.

**Why the reaper is armed by a timer and not only by traffic.** A Host whose
relay never delivers another frame — a hostile relay's simplest move — would
otherwise hold invitations, pending ceremonies, and idle sessions forever, since
every other trigger is an inbound event that relay controls. On the Host's own
clock, nothing the relay does or withholds changes when state is reclaimed.

**Why so little refreshes the idle deadline.** Each excluded trigger is
something a Client that has gone silent still produces — a phone in a pocket, a
relay replaying, a socket a proxy is keeping warm. Only a message this Host
decrypted on the session's own cipher is evidence the paired phone is there.

**Why losing the relay socket disposes invitations too.** The one-use key behind
a displayed code belongs to the socket it was minted over: the Client that scans
it arrives on a *new* socket, against a Host that no longer holds the private
half, so no path completes. Keeping the entry leaves the same dead code on
screen as the mint-straddle case under [Pairing](#pairing).

## Noise suite

**Why X25519 is WebCrypto and ChaChaPoly is bundled.** Measured 2026-06 across
the runtimes this ships to:

- **X25519** is `SubtleCrypto`-native in Safari 17+, Chrome 133+, Firefox 132+,
  and Node 18+. More than convenience: only WebCrypto can hold a private key as
  a nonextractable `CryptoKey`, the whole reason a Host static survives a
  restart without ever existing as bytes in the process again.
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
needs — at the import, where a version bump is written. Keeping the delta here
as well would give a bump two places to update and one to forget.

## Host identity

**Why the mint runs before the enrollment request.** A successful
`POST /api/host/enroll` appends a `hosts.json` row on the Server and spends the
installer's single-use token, and the Host can undo neither. Minting afterwards
means a runtime that turns out to lack X25519 has already consumed the operator's
one-shot credential and left a row nothing can use.

**Why a missing static is backfilled at start rather than gated on.** Minting
runs once, before enrollment, and is never retried afterwards, so a transient
WebCrypto failure during that one attempt would leave an enrollment the Server
has already committed and the Host can never complete. A gate with no backfill
turns that into a permanently un-enrolled machine over a moment's failure, whose
only operator recovery is deleting `hosts.json` on the Server. Persisting before
the Host runs rules out the other alternative, a Host running on a static it has
not yet written.

**Why a halves mismatch keeps the Host down.** A private half that does not
derive its recorded public half is a corrupt state file, but starting anyway
would not present it as one: the Host would come up under a *different* identity
than every paired Client has pinned, and each of those Clients would read the
change as the Host-impersonation signal it is designed to raise. Only failing
loudly at boot names the real fault.

**Why the probe answers `false` instead of throwing.** Its callers are boot-path
and pre-ceremony gates — the Host's start and Pocket's sign-in, setup, pairing
and connection screens — where an exception is an unhandled rejection in a
context with no error boundary. A missing WebCrypto (an insecure context, an old
runtime) reads as "unsupported, show the upgrade requirement", the same answer
as a curve the runtime rejects.

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

Loss stays recoverable by re-pairing, so this changes the advice, not the model.

## Residual metadata

**Why keystroke timing is accepted rather than closed.** Closing it needs
batching or cover traffic on the Client→Host direction: either holding
keystrokes for a fixed quantum — latency a terminal user feels immediately, on
the one interaction the product exists for — or sending padding frames forever,
which a phone pays for in battery and a relay in bandwidth. The party that
observes the timing is the one the user chose to run. A deployment that
considers timing part of its threat model needs a different transport, not a
different padding policy.

**Why a shared push endpoint correlates across Hosts.** One service-worker scope
holds exactly one `PushSubscription`, and the Server stores one row per
`(hostId, deliveryId)` against the endpoint that phone presented, so every
`deliveryId` a Pocket profile registers lands on the same endpoint string and
the Server can read off the set of Hosts one phone is paired with — information
the ACL deliberately keeps on each Host. Per-Host endpoints are not available:
the browser mints subscriptions per scope, and a scope per Host would mean a
service worker per Host.
