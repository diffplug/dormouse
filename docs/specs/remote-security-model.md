# Remote Security Model

The trust model for remote control, built on two independent security
primitives between the Client (Dormouse Pocket), Host (Dormouse Terminal), and
coordinating Server:

* **Passkeys verify fresh user presence.** Fresh presence is required by both
  the Server and the Host. A passkey authenticates the user; it never
  independently grants host access.
* **Each Client device completes an explicit one-to-one pairing ceremony with
  each Host.** The Host maintains its own local ACL of approved Clients,
  identified by an asymmetric device keypair generated in the browser and
  stored locally as a non-extractable WebCrypto key.

The separation is what makes account-level compromise insufficient for host
access: the Host rejects any client that has not been locally paired (see
[Security Guarantees](#security-guarantees) for the full list and its one
qualification).

`SECURITY.md` -> "Remote Control" is this model's audited face: it names the
subset of the properties below that are load-bearing enough to be checked
nightly, and states plainly which risks are accepted (the setup password's
minimal hardening) and which gaps are open (revocation, the audit trail).

The primitives — assertion verification, device signatures, challenges, the
ACL, the ceremony — live in `server-lib-common/src/security/`: runtime-agnostic
modules shared verbatim by the Server, the Host module in `lib`, and the Pocket
client, so the three sides cannot disagree on what a valid credential is. The
concrete pairing and connect message sequences live in `docs/specs/server.md`
(Relay); this spec defines what those sequences must establish.

## Goals

Dormouse enables a user to control a Host (Dormouse Terminal) from a Client
(Dormouse Pocket) using only web technologies.

Primary goals:

* No native mobile application required
* Strong protection against account compromise
* Strong protection against newly-added credentials
* Strong protection against server compromise
* Explicit host-controlled authorization
* Long-lived trusted client devices
* Modern passkey-based authentication

Non-goals:

* Defending against a fully compromised browser runtime
* Defending against a compromised operating system
* Preventing users from intentionally clearing browser data
* Providing permanent device identity guarantees across browser resets
* **End-to-end confidentiality from the Server.** The relay terminates TLS and
  forwards cleartext terminal bytes, so whoever operates the Server can read
  every keystroke and every byte of output. Self-hosted ships first precisely
  because that operator is the user. (The PRF-derived session key that would
  change this is in [Future](#future).)
* **Availability.** The shipped self-host deployment is a per-login user agent,
  so the relay is down whenever the machine is (`docs/specs/server.md`).

## Terminology

* **Client (Dormouse Pocket)** — a browser or installed PWA used to initiate
  remote-control sessions. It authenticates with passkeys, maintains a local
  device keypair, and signs Host challenges.
* **Host (Dormouse Terminal)** — the machine being remotely controlled. It
  maintains the local ACL, verifies Client authorization and fresh user
  presence, and establishes/terminates control sessions. **The Host is the
  final authority for access decisions.**
* **Server** — the coordinating service: account management, passkey
  registration, WebAuthn challenge generation, and signaling/rendezvous. The
  Server is not the final authority for Host access. (Revocation today is
  local state editing plus a Host restart — see `docs/specs/server.md`
  Guardrails; Server-pushed revocation propagation is staged in
  [Future](#future).)

## Trust Model

Dormouse separates:

| Layer      | Responsibility             |
| ---------- | -------------------------- |
| Passkey    | Fresh user presence        |
| Device Key | Long-lived client identity |
| Host ACL   | Authorization              |
| Host       | Final access decision      |

**No single layer is sufficient to gain access** — a successful connection
requires all four to agree.

## Passkeys

Passkeys verify fresh user presence: every connection requires a fresh
WebAuthn assertion, validated by **both** the Server and the Host.

Passkeys are frequently *synchronized* credentials — iCloud Keychain, Google
Password Manager, platform authenticators — so a single passkey may appear on
multiple physical devices:

> Passkeys are treated as user credentials, not device identities. A passkey
> authenticates a user account; it grants access to no Host.

**Presence, or verification.** The default demand is the authenticator's
user-*presence* flag. A deployment raises it to user *verification* (biometric
or PIN) with `DORMOUSE_REQUIRE_USER_VERIFICATION=true`; the Server mirrors the
flag into every Host's enrollment response, and the Host copies it into its
`ConnectionPolicy`. **Both verifiers must demand the same thing** — they
evaluate the same assertion, so a Server demanding UV while the Host does not
leaves the weaker verifier deciding, which inverts "the Host is the final
authority". Pocket asks for `userVerification: 'preferred'` either way, so
platform authenticators prompt for biometrics in practice even where neither
side requires it; that is convention, not a guarantee, which is why the flag
exists.

**The Host stores only a hash of each paired passkey's public key.** The Client
presents the full key at connection time and the Host checks it against the
stored hash, so a compromised Server cannot substitute a different passkey; the
Server likewise verifies against its own *stored* key, never against the one
the request carries.

Source of truth: `verifyPasskeyAssertion` / `hashPasskeyPublicKey` in
`server-lib-common/src/security/passkey.ts` — the same assertion verifier runs
on the Server (`Handshake.checkConnect2` in `server/src/handshake.ts`) and the
Host (`authorizeConnection`); `HostEnrollment.requireUserVerification` in
`lib/src/remote/host/enrollment.ts` carries the mirrored flag. Only ES256
(ECDSA P-256 / SHA-256) is accepted, the mandatory-to-implement WebAuthn
algorithm.

## Device Keys

Device keys establish long-lived Client identity — the capability the Host
actually authorizes. This prevents newly-added passkeys from inheriting Host
access, synced passkeys from automatically becoming trusted devices, and
Server-only compromise from granting Host access.

Implementation: each Client generates a non-extractable ECDSA P-256 signing
keypair with WebCrypto (`DEVICE_KEY_ALGORITHM` / `generateDeviceKeyPair` in
`server-lib-common/src/security/deviceKey.ts`). The base64url raw public
point is the Client identifier. Device signatures are domain-separated
(`DEVICE_AUTH_DOMAIN`) so a signed challenge cannot be replayed in another
protocol context. The `CryptoKey` objects are persisted directly in IndexedDB
— never exported — by `getOrCreateDeviceKey` /
`indexedDbDeviceKeyStore` in `lib/src/remote/client/device-key.ts` (the
IndexedDB wrapper is DOM-dependent, so it lives in `lib`, not
`server-lib-common`).

Security properties — strengths: durable across browser restarts and page
reloads, non-extractable through normal browser APIs, fully web-native.
Limitations: active XSS can *use* the key, browser or OS compromise defeats
the model, and clearing browser data destroys the key. Device-key loss is a
recoverable event (see [Device Key Loss](#device-key-loss)).

Sign-in returns the asserted passkey's **public** key, so any browser profile
holding a synced passkey can build pair and connect requests rather than only
the one that registered it. Not a weakening: the key is public, the Host
receives it in every `ConnectionRequest` regardless, and a Client that signs in
has merely asked — it reaches nothing until the Host's local approval adds *its
own device key* to the ACL.

The device key has one use outside connection establishment: a Client signs its
Web Push subscription with it, binding that subscription to the same identity
the Host's ACL records ([server.md](./server.md) -> Web Push). That signature
carries its own domain tag (`PUSH_SUBSCRIBE_DOMAIN` in
`server-lib-common/src/security/push.ts`) rather than `DEVICE_AUTH_DOMAIN`,
because the Server sees Host-issued challenges in transit during `connect` —
sharing one domain would let a challenge captured in one protocol be presented
to the other. **A push subscription authorizes nothing:** it is a delivery
address, and losing or forging one cannot move a Client across the ACL
boundary.

## Host Authorization

Each Host maintains a local authorization list. **The ACL is authoritative**;
the Server cannot unilaterally grant access.

`HostAclRecord` binds the Host and account to one passkey credential and public
key hash, one device public key, approval metadata, and nullable revocation
time. Its canonical schema and behavior live in
`server-lib-common/src/security/acl.ts`; the Host service persists it through
`HostStateStore` — a 0600 file in standalone, `globalState` in VS Code — never
on the Server (`docs/specs/server.md`).

A record authorizes the *pair* of a passkey credential and a device key:
`HostAcl` reports a miss (`passkey-not-paired`, `device-not-paired`,
`pairing-mismatch`) unless both halves match one active record.

Every store reads its records back as `unknown[]`, so `isHostAclRecord` +
`filterAclRecords` (`lib/src/remote/host/acl.ts`) drop anything malformed or
belonging to another `hostId` before it can reach `authorizeConnection`. That
is hygiene, not authorization — every field is attacker-choosable by anything
that can write the store at all; the local approval that minted the record is
the authorization.

## Pairing Ceremony

Pairing establishes trust between one Client and one Host, and local approval
on the Host is the only path that *mints* an ACL record. A newly-added passkey
is *not* automatically trusted — the Client must still complete Host pairing.
(Records can be *carried* rather than minted, by the one-shot `adopt` migration
from builds that kept the Host in webview `localStorage`; that path is bounded
separately — `SECURITY.md` -> "Remote Control".)

What the ceremony establishes, in order:

1. The Client authenticates with a passkey and presents its device public key.
2. The Host displays local approval UI (the pairing modal, same pattern as
   KillConfirm — `docs/specs/server.md`, Host side).
3. The user approves locally on the Host.
4. The Host writes the `HostAclRecord` binding the passkey credential identity
   to the device public key.

The Client is now trusted by that Host and no other.

**The approval is only as good as what the modal lets a human check.** The
ceremony verifies no assertion, so the person at the Host *is* the control —
and every field of a `PairingRequest` is chosen by whoever composed it. The one
checkable field is the device-key fingerprint: the Host's modal and Pocket's
Hosts screen both render `pairingFingerprint` from
`server-lib-common/src/security/pairing.ts` — the same helper on both ends,
precisely so they cannot drift into showing different slices of the same key —
so a substituted or injected request, the thing a compromised Server could
otherwise time to arrive exactly when one is expected, shows the wrong eight
characters. Without that comparison the prompt asks the user to recognize a key
they have never seen. `requestedLabel` and `accountId` are attacker-chosen free
text, reduced by `boundedPairingLabel` / `boundedPairingAccount` before display,
so neither can overflow the dialog or carry bidi overrides that make it read as
something else.

**The Host validates the request's shape itself** (`isPairingRequest`), never
relying on the Server having done so: the Server is not trusted, and an
unvalidated relayed object reaching the approval UI is both a crash surface and
a route to a malformed ACL record.

**Each displayed approval is bound to the ceremony ticket's immutable
`pairingId`.** If a Client replaces its pending request while the old modal or
its click command is still in flight, the Host rejects that stale action; it
never selects a request by mutable `clientId` alone. Source of truth:
`RemoteHostService.#pendingPairing` in `lib/src/host/remote/service.ts` and the
service/webview contract in `lib/src/host/remote/service-protocol.ts`.

**Presence for pairing is server-attested plus Host-approved.** The Server
relays a pairing request only while the session's last server-verified
passkey assertion is within `PAIRING_PRESENCE_WINDOW_MS` (30 seconds; sign-in,
re-auth, and a verified `connect2` all refresh the stamp — `checkPair` /
`checkConnect2` in `server/src/handshake.ts`). A stale session is answered with
`PAIRING_STALE_PRESENCE_ERROR`; the Client re-asserts with one WebAuthn prompt
(`/api/reauth/begin` + `/api/reauth/finish`, refreshing the same session and
relay socket) and retries. The Host does not re-verify an assertion at pairing
time — its stronger control is the mandatory local approval, which connect
lacks (there `authorizeConnection` verifies presence itself). Under Server
compromise, a forged freshness stamp gets an attacker no further than the
human staring at the approval modal.

**Pending pairings are bounded.** A `pair` frame allocates in three places —
the ceremony's ticket map, the Host's per-`clientId` client map, and the
service's queue mirrored to the webview — under a `clientId` the relay chooses,
and only a `client-gone` removes one. All three are capped
(`MAX_PENDING_TICKETS`, `MAX_PENDING_PAIRINGS`), oldest evicted first, because
anything that can sign in can send these and a queue that only grows wedges the
process that owns every PTY. The controller answers its own eviction with a
`pair-result` denial and drops the whole client *record*, not just the request
it held — clearing the payload while keeping the map slot would bound only what
`PAIRING_FIELD_LIMIT` already bounds and leave the relay-chosen key, which is
why `MAX_CLIENT_ID_LENGTH` also caps `clientId` at the frame boundary, before
any map is touched.

That bounds the *pairing* path only. `connect` creates a client entry by
another route (`#resetAuthorization`); those carry no pending request, and the
pairing counter neither sees nor evicts them, since dropping an entry that may
be `established` is a different act from denying a pending request. They are
cleared wholesale when the relay socket drops.

Source of truth: `PairingRequest` / `PairingTicket` / `PairingCeremony` /
`PAIRING_PRESENCE_WINDOW_MS` / `PAIRING_FIELD_LIMIT` / `MAX_PENDING_PAIRINGS`
in `server-lib-common/src/security/pairing.ts`, and `MAX_CLIENT_ID_LENGTH` /
`RemoteHost.#evictOldestPairingIfFull` in
`lib/src/remote/host/remote-host.ts`
(tickets are single-use with a `DEFAULT_PAIRING_TTL_MS` = 5-minute TTL;
approval after expiry fails without touching the ACL — the presence window
gates the *request*, not the approver's deliberation). The wire sequence —
who relays what — is the pairing diagram in `docs/specs/server.md`.

## Connection Establishment

A connection succeeds only if **all** of the following hold:

1. The passkey proves fresh user presence.
2. The Server recognizes the account.
3. The Host recognizes the passkey credential.
4. The Host recognizes the device key.
5. The Client signs a fresh Host challenge with its device key.

The Host makes the final decision — `authorizeConnection` in
`server-lib-common/src/security/connection.ts` evaluates the assertion, the
device signature, and the ACL against the Host's `ConnectionPolicy`
(origin/rpId/UV), and returns a `ConnectionDecision` regardless of what the
Server claims to have already checked. It never short-circuits: every layer is
evaluated and every failure is reported.

Host challenges are 32-byte, single-use, TTL-bounded values from
`HostChallengeIssuer` (`server-lib-common/src/security/challenge.ts`, default
2-minute TTL). `authorizeConnection` consumes the challenge *before* any other
work, so it can never be presented twice whatever the rest of the decision
does. Minting one also reclaims the expired challenges ahead of it, so a flow
that mints before it can authenticate the caller — `POST /api/signin/begin` —
retains only what a caller can mint inside one TTL window, rather than
accumulating for the process's lifetime.

**Every new `connect` / `connect2` closes that Client's established message
gate** and disposes its prior control session before this evaluation, and only
the newest evaluation may re-open that gate: each attempt carries an
authorization generation, and one superseded while it awaited verification sends
no decision at all — otherwise an older `allowed` landing last would re-open the
gate its successor had just closed. A structurally malformed request from the
relay is contained as a denied decision rather than an async failure in the Node
Host process. Source of truth: `RemoteHost.#onConnect` / `RemoteHost.#onConnect2`
in `lib/src/remote/host/remote-host.ts`.

One host challenge feeds both the passkey assertion and the device-key
signature, so connecting costs the user a single biometric prompt per
connection. The concrete sequence is the connect diagram in
`docs/specs/server.md`.

## Storage Durability

The device key lives in browser-managed storage, and durability differs by
platform:

* **iOS browser tab** — weakest; storage may be evicted after inactivity.
  **Never treat it as permanent.**
* **Android browser tab** — generally durable.
* **Installed PWA** — the preferred mode on both, strongest on Android.

Today Pocket generates the device key in whatever context it runs — the
install-before-pairing guidance and storage-persistence hardening are staged
(see [Future](#future)). Eviction is recoverable, not catastrophic: see
[Device Key Loss](#device-key-loss).

## Device Key Loss

Device-key loss is expected — browser reset, site-data clearing, device
replacement, PWA removal. Recovery is a re-run of the normal flows:

1. User authenticates with a passkey.
2. Client generates a new device key.
3. Host performs a new pairing ceremony.
4. The previous device key's record may be revoked (`revokedAt`).

No security compromise occurs: the lost key authorized nothing without its
paired passkey, and the new key starts unauthorized everywhere.

## Security Guarantees

Each property below is established in its own section above; this is the
enumeration the section heading promises — the checklist an auditor or a
change reviewer verifies against:

* Adding a new passkey does not grant Host access.
* Compromising the Server does not let it *create* an authorized Client.
* Passkey synchronization does not automatically create trusted Clients.
* Every trusted Client must be explicitly paired with every Host.
* Every connection requires fresh user presence.
* Every access decision is ultimately made by the Host.

**Server compromise cannot create an authorized Client, but it can act through
an authorized session already open.** After a decision the Host gates `msg` frames on
`established` for a `clientId` the relay itself minted, and there is no
per-frame authentication, so a compromised Server can fabricate frames on a
session an authorized Client already has open — reaching `terminal.write`,
which is keystroke injection into a live PTY — as well as suppress or rewrite
frames in either direction. That follows from the relay being a dumb pipe with
no end-to-end authentication (see Non-goals); the PRF-derived session key in
[Future](#future) is what would close it.

## Future

### Revocation propagation

The Server pushing revocations to Hosts. Today `HostAcl.revokeDevice` /
`revokePasskey` exist but have no callers, and no relay frame carries a
revocation — revoking is hand-editing state (`docs/specs/server.md`,
Guardrails). Note what that costs an operator: `RemoteHostService.#startHost`
reads the store once and hands the `RemoteHost` a snapshot for its whole
lifetime, so an edited record is not observed until the Host is restarted.
Restarting is therefore the entire lever — it reloads the ACL *and*, by
dropping the relay socket, ends every established session. Editing alone
changes nothing that is running.

### Storage-durability hardening

* Call `navigator.storage.persist()` when creating the device key, so the
  browser treats the Client's IndexedDB as persistent rather than
  best-effort.
* On iOS, encourage PWA installation *before* pairing — generate the device
  key only while running as an installed app. Detection recipe:

  ```ts
  const isInstalledRuntime =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    window.navigator.standalone === true;
  ```

  (This detects the *current* run mode only; it cannot tell whether the app
  was previously installed.)

### WebAuthn PRF

A future enhancement; potential uses include end-to-end session key
derivation, reduced trust in the Server, stronger cryptographic channel
binding, offline operation, and a Noise-style authenticated key exchange. PRF
is not required for the core model — the shipped system relies only on
standard WebAuthn assertions and device-key authorization.
