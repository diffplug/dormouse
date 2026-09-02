# Remote Security Model — rationale

Evidence behind [remote-security-model.md](./remote-security-model.md), keyed by
its headings. Informative, not normative: the rules themselves live in the spec.

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

**Why the old sign-in public-key argument no longer appears.** Sign-in used to
return the asserted passkey's public key so a browser that had not *registered*
the passkey could still build pair and connect requests, and the spec argued at
length that handing out a public key costs nothing. The presence proof carries
that key inside the encrypted channel and the Host checks it against a stored
hash, so the argument is now about a field nobody asks the Server for.

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

**Why an eviction is answered, and a refused handshake is not.** Evicting a
pending pairing drops something a person may be looking at, so it sends
`superseded` and dismisses the modal. A connection `init` that never decrypted
gets nothing at all: there is no session to encrypt a denial on, and answering
would let a flood of `init` frames buy a reply each. The token bucket is
answered with silence for the same reason.

**Why the session cap is checked at promotion rather than at the handshake.** A
cap applied earlier would let unauthenticated traffic decide who gets in: anyone
who can reach the relay could fill it and lock out the phones that are actually
paired. Applied after the presence proof and the ACL conjunction, the only thing
that can fill it is authorized phones.

**Why so little refreshes the idle deadline.** Host output, a relay envelope, a
socket ping, and a frame that failed to decrypt are all things a Client that has
gone silent still produces — a phone in a pocket, a relay replaying, a socket a
proxy is keeping warm. Only a message this Host decrypted on the session's own
cipher is evidence the paired phone is still there.

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

**Why the vector comes from Cacophony.** An expected value computed by the
implementation under test proves only that it is self-consistent. Cacophony is
an independent Haskell implementation; its published `IK_25519_ChaChaPoly_SHA256`
vector pins both handshake messages, every transport message in both
directions, and the final handshake hash, so a mistake anywhere in the mixing
order fails the test rather than propagating into the expectation.
