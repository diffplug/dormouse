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

This separation ensures that account-level compromise is insufficient for host
access. Adding a new passkey to an account, or compromising the coordinating
Server, does not authorize a new client: the Host rejects any client that has
not been locally paired.

Everything in this spec is implemented in `server-lib-common/src/security/` —
runtime-agnostic modules shared verbatim by the Server, the Host module in
`lib`, and the Pocket client, so the three sides cannot disagree on what a
valid credential is. The concrete pairing and connect message sequences live
in `docs/specs/server.md` (Relay); this spec defines what those sequences must
establish.

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
  local state editing — see `docs/specs/server.md` Guardrails; Server-pushed
  revocation propagation is staged in [Future](#future).)

## Trust Model

Dormouse intentionally separates:

| Layer      | Responsibility             |
| ---------- | -------------------------- |
| Passkey    | Fresh user presence        |
| Device Key | Long-lived client identity |
| Host ACL   | Authorization              |
| Host       | Final access decision      |

No single layer is sufficient to gain access. A successful connection requires
all layers to agree.

## Passkeys

Passkeys verify fresh user presence: every connection requires a fresh
WebAuthn assertion, validated by **both** the Server and the Host.

Passkeys are frequently *synchronized* credentials — iCloud Keychain, Google
Password Manager, platform authenticators — so a single passkey may appear on
multiple physical devices. Therefore:

> Passkeys are treated as user credentials, not device identities.

A passkey authenticates a user account but does not grant access to any Host.

Source of truth: `verifyPasskeyAssertion` / `hashPasskeyPublicKey` in
`server-lib-common/src/security/passkey.ts` — the same assertion verifier runs
on the Server and the Host (`docs/specs/server.md`, "WebAuthn without a
WebAuthn library").

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

## Host Authorization

Each Host maintains a local authorization list. **The ACL is authoritative**;
the Server cannot unilaterally grant access.

The record schema (source of truth: `HostAclRecord` / `HostAcl` in
`server-lib-common/src/security/acl.ts`; persisted on the Host in webview
`localStorage` via `lib/src/lib/local-json-store.ts`, `docs/specs/server.md`):

```ts
interface HostAclRecord {
  hostId: string;
  accountId: string;
  passkeyCredentialId: string;
  /** SHA-256 of the passkey's SPKI public key, base64url. */
  passkeyPublicKeyHash: string;
  /** Base64url raw P-256 point — the Client's identity. */
  devicePublicKey: string;
  approvedAt: number;            // epoch ms
  approvedBy: string;            // who approved locally, e.g. `host-user`
  label: string;                 // client name shown in Host UI, e.g. `iPhone Safari`
  revokedAt: number | null;      // null while active
}
```

A record authorizes the *pair* of a passkey credential and a device key:
`HostAcl` reports a miss (`passkey-not-paired`, `device-not-paired`,
`pairing-mismatch`) unless both halves match one active record.

## Pairing Ceremony

Pairing establishes trust between one Client and one Host, and local approval
on the Host is the only path into the ACL. A newly-added passkey is *not*
automatically trusted — the Client must still complete Host pairing.

What the ceremony establishes: the Client authenticates with a passkey and
presents its device public key; the Host displays local approval UI (the
pairing modal, same pattern as KillConfirm — `docs/specs/server.md`, Host
side); the user approves locally on the Host; the Host writes the
`HostAclRecord` binding the passkey credential identity to the device public
key. The Client is now trusted by that Host and no other.

Source of truth: `PairingRequest` / `PairingTicket` / `PairingCeremony` in
`server-lib-common/src/security/pairing.ts` (tickets are single-use with a
`DEFAULT_PAIRING_TTL_MS` = 5-minute TTL; approval after expiry fails without
touching the ACL). The wire sequence — who relays what — is the pairing
diagram in `docs/specs/server.md`.

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
(origin/rpId), and returns a `ConnectionDecision` regardless of what the
Server claims to have already checked. Host challenges are 32-byte,
single-use, TTL-bounded values from `HostChallengeIssuer`
(`server-lib-common/src/security/challenge.ts`, default 2-minute TTL).

One host challenge feeds both the passkey assertion and the device-key
signature, so connecting costs the user a single biometric prompt per
connection. The concrete sequence is the connect diagram in
`docs/specs/server.md`.

## Storage Durability

Where the device key lives is browser-managed storage, and durability differs
by platform:

* **iOS browser tab** — durability is limited: browser-managed storage may be
  evicted after periods of inactivity. Do not treat it as permanent.
* **iOS installed PWA** — the preferred mode; meaningfully stronger retention.
* **Android browser tab** — generally durable; suitable for casual use.
* **Android installed PWA** — the preferred mode; the strongest web-only
  durability guarantee.

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

Dormouse is designed so that:

* Adding a new passkey does not grant Host access.
* Compromising the Server does not grant Host access.
* Passkey synchronization does not automatically create trusted Clients.
* Every trusted Client must be explicitly paired with every Host.
* Every connection requires fresh user presence.
* Every access decision is ultimately made by the Host.

The Host remains the final authority throughout the system.

## Future

### Revocation propagation

The Server pushing revocations to Hosts. Today `HostAcl.revokeDevice` /
`revokePasskey` exist but have no callers, and no relay frame carries a
revocation — revoking is hand-editing state (`docs/specs/server.md`,
Guardrails) and takes effect at the Host's next `authorizeConnection`.

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
