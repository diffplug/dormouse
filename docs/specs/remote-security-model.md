# Remote Security Model

Our security model is based on two independent security primitives between the Client (Dormouse Pocket), Host (Dormouse Terminal), and coordinating Server:

* Passkeys verify fresh user presence.

  * Fresh user presence is required by both the coordinating server and the host.
  * Passkeys authenticate the user, but do not independently grant host access.

* Each client device must complete an explicit one-to-one pairing ceremony with each host device.

  * The host maintains its own local ACL of approved clients.
  * Approved clients are identified by an asymmetric device keypair generated in the browser and stored locally as a non-extractable WebCrypto key.

This separation ensures that account-level compromise is insufficient for host access. Adding a new passkey to an account, or compromising the coordinating server, does not authorize a new client: the host will reject any client that has not been locally paired.

# Goals

Dormouse enables a user to control a Host (Dormouse Terminal) from a Client (Dormouse Pocket) using only web technologies.

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

---

# Terminology

## Client (Dormouse Pocket)

A browser or installed PWA used to initiate remote-control sessions.

Responsibilities:

* Authenticate using passkeys
* Maintain a local device keypair
* Establish connections to Hosts
* Sign Host challenges

## Host (Dormouse Terminal)

The machine being remotely controlled.

Responsibilities:

* Maintain a local ACL of approved Clients
* Verify Client authorization
* Verify fresh user presence
* Establish and terminate control sessions

The Host is the final authority for access decisions.

## Server

The coordinating service used for accounts, authentication, signaling, and session establishment.

Responsibilities:

* Account management
* Passkey registration
* WebAuthn challenge generation
* Signaling and rendezvous
* Revocation propagation

The Server is not the final authority for Host access.

---

# Trust Model

Dormouse intentionally separates:

| Layer      | Responsibility             |
| ---------- | -------------------------- |
| Passkey    | Fresh user presence        |
| Device Key | Long-lived client identity |
| Host ACL   | Authorization              |
| Host       | Final access decision      |

No single layer is sufficient to gain access.

A successful connection requires all layers to agree.

---

# Passkeys

## Purpose

Passkeys verify fresh user presence.

Every connection requires a fresh WebAuthn assertion.

Fresh user presence is validated by:

* The Server
* The Host

A passkey authenticates a user account but does not grant access to any Host.

## Important Property

Passkeys are frequently synchronized credentials.

Examples include:

* iCloud Keychain
* Google Password Manager
* Platform authenticators
* Hardware security keys

A single passkey may appear on multiple physical devices.

Therefore:

> Passkeys are treated as user credentials, not device identities.

---

# Device Keys

## Purpose

Device keys establish long-lived Client identity.

They provide the capability being authorized by the Host.

This prevents:

* Newly-added passkeys from inheriting Host access
* Synced passkeys from automatically becoming trusted devices
* Server-only compromise from granting Host access

## Generation

Each Client generates an asymmetric keypair:

* Signing keypair
* Non-extractable private key
* Generated using WebCrypto

The public key is used as the Client identifier.

## Storage

Recommended implementation:

* WebCrypto
* IndexedDB
* `extractable: false`
* `navigator.storage.persist()`

The private key never leaves browser storage under normal operation.

## Security Properties

Strengths:

* Durable across browser restarts
* Durable across page reloads
* Non-extractable through normal browser APIs
* Fully web-native

Limitations:

* Active XSS can use the key
* Browser compromise defeats the model
* OS compromise defeats the model
* Clearing browser data destroys the key

Device-key loss is considered a recoverable event.

---

# Host Authorization

## Host ACL

Each Host maintains a local authorization list.

The ACL is authoritative.

The Server cannot unilaterally grant access.

Example:

```text
Dormouse Terminal

Authorized Clients:

- iPhone Safari
  Passkey A
  Device Key 1

- Android Chrome
  Passkey A
  Device Key 2

- MacBook Chrome
  Passkey B
  Device Key 3
```

## ACL Record

Recommended fields:

```text
host_id
account_id
passkey_credential_id
passkey_public_key_hash
device_public_key
approved_at
approved_by
label
revoked_at
```

The exact schema may evolve.

---

# Pairing Ceremony

## Purpose

Establish trust between one Client and one Host.

Pairing requires physical access to the Host.

## Security Property

A newly-added passkey is not automatically trusted.

The Client must still complete Host pairing.

## Flow

1. Client authenticates using a passkey.
2. Client presents its device public key.
3. Host displays local approval UI.
4. User approves locally on the Host.
5. Host stores:

   * passkey credential identity
   * device public key
   * authorization metadata
6. Pairing completes.

The Client is now trusted by that Host.

No other Hosts are affected.

---

# Connection Establishment

## Requirements

A connection succeeds only if:

1. The passkey successfully proves fresh user presence.
2. The Server recognizes the account.
3. The Host recognizes the passkey credential.
4. The Host recognizes the device key.
5. The Client signs a fresh Host challenge.

All requirements are mandatory.

## Flow

1. Client requests connection.
2. Server validates account state.
3. Host issues a fresh challenge.
4. Client performs WebAuthn authentication.
5. Client signs the Host challenge using its device key.
6. Server validates WebAuthn.
7. Host validates:

   * passkey authorization
   * device authorization
   * challenge signature
8. Session is established.

The Host makes the final decision.

---

# Storage Durability

## iOS

### Browser Tab

Durability is limited.

Browser-managed storage may be removed after periods of inactivity.

Do not treat browser-tab storage as permanent.

### Installed PWA

Preferred mode.

Dormouse should encourage installation before pairing.

Recommended behavior:

* Generate device key only while running as an installed PWA.
* Pair only after installation.

## Android

### Browser Tab

Generally durable.

Suitable for casual use.

### Installed PWA

Preferred mode.

Provides the strongest web-only durability guarantees.

---

# Installed PWA Detection

Dormouse can detect whether it is currently running as an installed application:

```ts
const isInstalledRuntime =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  window.matchMedia('(display-mode: minimal-ui)').matches ||
  window.navigator.standalone === true;
```

This indicates that the application is currently running in standalone mode.

It does not indicate whether the application was previously installed.

---

# Device Key Loss

Device-key loss is expected.

Causes include:

* Browser reset
* Site-data clearing
* Device replacement
* Browser corruption
* PWA removal

Recovery process:

1. User authenticates with a passkey.
2. Client generates a new device key.
3. Host performs a new pairing ceremony.
4. Previous device key may be revoked.

No security compromise occurs.

---

# Future: WebAuthn PRF

WebAuthn PRF is a future enhancement.

Potential uses include:

* End-to-end session key derivation
* Reduced trust in the Server
* Stronger cryptographic channel binding
* Offline operation
* Noise-style authenticated key exchange

PRF is not required for the core Dormouse security model.

The MVP relies only on standard WebAuthn assertions and device-key authorization.

---

# Security Guarantees

Dormouse is designed so that:

* Adding a new passkey does not grant Host access.
* Compromising the Server does not grant Host access.
* Passkey synchronization does not automatically create trusted Clients.
* Every trusted Client must be explicitly paired with every Host.
* Every connection requires fresh user presence.
* Every access decision is ultimately made by the Host.

The Host remains the final authority throughout the system.
