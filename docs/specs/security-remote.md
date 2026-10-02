# Remote Control Security

> See `docs/specs/glossary.md` for Pane; this spec uses it bare.
> Owns the boundary the product presents to the network: remote control. Defers the trust model to `docs/specs/remote-security-model.md`, the Relay runtime to `docs/specs/relay.md`, the self-host deployment to `SELF_HOST.md`, and the boundaries a local user has to `docs/specs/security-local.md`.
> Read `docs/specs/security.md` first; `docs/specs/security-audit.md` says how the `FAIL IF` lines here are run.

## Remote Control

Pocket lets a phone attach to a terminal on the user's laptop, so the pairing stack is
the one part of the product that takes input from the network. **An authorized Client
is equivalent to a person at that laptop's keyboard** — `terminal.write` is raw
keystroke injection into a live PTY and protocol-v1 has no restricted session — so the
model exists to make *authorized* hard to reach and impossible to reach by accident.
**A Burrow that never enrolls with a Relay has no relay, pairing, or push**; what
still applies to it is [One-time connection](#one-time-connection) — the one way in
without them, one session confirmed at the Burrow and writing nothing — with the
direct path it runs on and the service→webview checks. Two deployment modes are
defined (`docs/specs/remote-api.md` -> "Transport"). Self-host deployment rules
are scoped below; Hosted's implemented admin-entitled account routing and
one-time rendezvous defer to `docs/specs/security-hosted.md`. Paid activation
remains staged ([Cloud-hosted mode](#cloud-hosted-mode)).

### Trust boundary

**Five layers, none sufficient alone** (`docs/specs/remote-security-model.md` ->
"Trust Model"). A deployment may raise the presence layer to *user verification* with
`DORMOUSE_REQUIRE_USER_VERIFICATION=true`.

**There is exactly one channel and no other path.** One suite
(`Noise_IK_25519_ChaChaPoly_SHA256`) carries both ceremonies, protocol-v1, and the
terminal stream; there is no negotiation, no cipher or pattern selector,
no plaintext relay route, and no reader for any of the pre-cutover frames.

The setup-password and `burrowToken` escalation rows describe the self-host
Relay's passkey account. Hosted login is `docs/specs/security-hosted.md` ->
"Account boundary".

| Compromise | Buys | What still stands |
| --- | --- | --- |
| Relay | account state, routing metadata | **no new authorization and no plaintext**. On an established session, availability only — drop, delay, reorder, or refuse, never read and never inject — and the first invalid ciphertext destroys the session. Web Push holds **confidentiality**, not **freshness**: a kept envelope re-delivers as current, accepted residual (rationale). A session switched to the [direct path](#direct-path) leaves it the lifecycle levers alone — it can still end that session by dropping a socket, but sees, delays, and reorders none of its traffic |
| Setup password | one endpoint, `/api/burrow/enroll`, and thence a `burrowToken` | it registers **no** passkey — `/api/setup/*` takes a Burrow-minted setup token and nothing else — so it reaches an owner passkey only via the next row. `/api/burrow/enroll` accepts one other credential, the installer's enrollment offer: owner-only *at rest*, the whole of what the file mode protects, checked by possession over HTTPS rather than local identity, so a leaked token redeems remotely — bounded single-use, 24-hour expiry, permanently disabled by the first Burrow enrollment. Still **no Burrow access** |
| `burrowToken` | the Burrow's own relay traffic and, transitively, **account takeover**: it mints setup tokens at `/api/burrow/setup-token`, the only thing that registers an owner passkey | bounded three ways — single-use and dead 5 minutes after minting; revoking the Burrow (deleting its row from `burrows.json`) stops minting immediately *and* kills already-minted tokens, re-checked at both setup gates; a signed-in phone retires an unused token at `/api/setup/retire`. Still **no Burrow access** (rationale) |
| Synced or stolen passkey | sign-in, and the ability to *ask* | the paired Client static is missing, so `BurrowAcl` answers `client-not-paired` |
| Client static | use in place; encrypted fallback also permits private-byte extraction by compromised same-origin code | connecting still needs the paired passkey's fresh assertion, and it authorizes exactly one Burrow |

**Must mint an ACL record only after the Burrow accepts one local confirmation
of the phone's two digits.** The webview relays the immutable ceremony id and
typed digits; it cannot read the expected code, choose the record, or fabricate
a pending request. A compromised webview gets one guess at an honest Client's unknown uniform
code: 1/100 success, without proving a person read the phone (rationale). Removal is
[Revocation and the audit trail](#revocation-and-the-audit-trail).

- **FAIL IF** the Burrow stops being the final authority: `BurrowRuntime.#onConnectionTransport` in `lib/src/remote/burrow/burrow-runtime.ts` must consume its own challenge, verify the presence proof with `verifyPresenceProof` against a binding built from the Burrow's own `burrowId`, connection id, challenge and handshake hash, and require one active `BurrowAclRecord` holding the account, the passkey credential, that key's hash, and the IK-authenticated Client static — before any session is established, and with no code path letting a Relay-supplied claim stand in for any of them.
- **FAIL IF** local confirmation stops being the only thing that **mints** an ACL record: `BurrowAcl.approve` must have no caller but `BurrowRuntime.#approvePairing`, the comparison must be constant-time and happen **exactly once** per ceremony, and it must match the immutable `pairingId` of the request that was displayed, never a mutable `clientId` alone.
- **FAIL IF** the expected two-digit code, or an invitation's private key, ever leaves the Burrow process: `PairingQueueItem` in `lib/src/host/remote/service-protocol.ts` carries `{ kind, clientId, pairingId, label, requestedAt }` and nothing else (rationale). An answer is routed by its `kind` — a one-time request's only to the runtime that asked, by the random ticket its modal displayed — and **a missing `kind` is a pairing** (`approvalKind`), so an answer that names none can never reach a one-time request.
- **FAIL IF** the pending-ceremony maps are unbounded, in **both** `BurrowRuntime`'s client map and the service's mirrored queue: pairings capped at `MAX_PENDING_PAIRINGS` on both sides, oldest evicted first; connection handshakes at `MAX_PENDING_CONNECTION_HANDSHAKES`; outstanding invitations at `MAX_TOKENS_PER_BURROW`. `MAX_CLIENT_ID_LENGTH` bounds `clientId` at the frame boundary, before any map is touched, and a handshake that fails to decrypt allocates no entry at all (rationale).
- **FAIL IF** any Burrow bound stops being enforced by the Burrow itself, on its own clock, with no help from the relay. The relay-frame FIFO must enforce its count and cumulative received-string limits before enqueueing, including `client-gone`; overflow synchronously tears down the socket and transient state, and reconnects retain at most one in-flight operation. `MAX_ESTABLISHED_E2E_SESSIONS` is checked **at promotion only** — after the presence proof and the ACL conjunction — and a Client static replaces its own session while any other identity at the cap gets `burrow-busy` and evicts no other entry. A Burrow-global token bucket (`E2E_INIT_BURST` decaying at one per `E2E_INIT_REFILL_INTERVAL_MS`) gates the WebCrypto an accepted `init` buys, and a frame it refuses performs no operation and allocates nothing. One reaper over absolute timestamps — invitation expiry, pairing TTL, challenge TTL, `ESTABLISHED_E2E_IDLE_TIMEOUT_MS`, the last refreshed only by a successfully decrypted Client→Burrow transport message — runs on every init, every local decision, every relay lifecycle event, and a next-expiry timer cleared on `stop()`. Values, and which file declares each: `docs/specs/remote-security-model.md` -> "Burrow bounds". Pinned by `lib/src/remote/burrow/burrow-bounds.test.ts` and `relay/test/malicious-relay.test.mjs` (rationale).
- **FAIL IF** `requireUserVerification` is reachable on one side without being mirrored to the other: the Relay reads `DORMOUSE_REQUIRE_USER_VERIFICATION`, and `BurrowEnrollResponse` must carry it into the Burrow's `ConnectionPolicy` (rationale).
- **FAIL IF** the Burrow accepts an `e2e` frame it has not shape-validated itself with `isE2eRelayToBurrowFrame` — relying instead on the relay's own overlapping guard (`isE2eClientFrame` / `isE2eBurrowFrame` in `relay/src/relay.ts`) — or lets the Client's device label reach any consumer un-reduced by `boundedPairingLabel` (rationale).
- **FAIL IF** a ceremony outcome stops being a fixed-size padded control message, or begins carrying which ACL half failed: success and every denial encrypt to the same length, every ACL miss answers `pairing-required`, and the specific miss is logged owner-locally only.
- **FAIL IF** any **service→webview** message can carry `burrowToken`, **or any other bearer credential the receiving realm has no route that takes** — `deliveryId` most of all, which is why `PushDevicesResult` is labels only. Check the direction, not just the identifier: `BurrowResult`, `BurrowStatusEvent`, `PairingQueueEvent`, `InvitationEvent`, `OneTimeEvent` (its `OneTimeState`, from `lib/src/remote/burrow/one-time-runtime.ts`), `SetupQrResult`, `BurrowConsoleStatus`, and `PushDevicesResult` in `lib/src/host/remote/service-protocol.ts` are the outbound shapes and none may expose one; the test is whether the webview *calls* anything with the value, not whether exposing it is currently exploitable. The credentials that *do* cross outbound are the Relay's **setup token** and the invitation's **public** half, both inside `SetupQrResult.url`, and a one-time link's room id and one-use **public** key, inside `OneTimeState`'s `waiting.url` — each minted only on request, single-use, and short-lived. Inbound differs — `EnrollParams` carries the setup password by design (rationale).
- **FAIL IF** a private key agreement ever leaves WebCrypto. **X25519 stays WebCrypto-only** (`generateKey` / `deriveBits` / `importKey`) and **never a JavaScript curve** (`@noble/curves`, `tweetnacl`, `libsodium`, or any other). The one bundled primitive is ChaCha20-Poly1305, from an exactly-pinned `@noble/ciphers` release; its two import sites and the pin's audit delta are recorded in `remote-lib-common/src/security/noise.ts`'s header, rewritten by any version bump in the same commit (rationale).
- **FAIL IF** the Burrow's Noise static is ever sent to the Relay, or a Burrow runs with halves that do not correspond: it is minted locally *before* the enrollment request and never sent in it, persisted only where `burrowToken` is, and `BurrowService` derives the public point from the private half and compares before starting — a mismatch keeps the Burrow down (rationale).
- **FAIL IF** `remote-lib-common/src/security/` stops being the shared implementation: the Relay, the Burrow, and the Pocket client must verify assertions, presence challenges, handshakes, and transport framing with the same modules. Conformance is proven against an independent implementation's published vector (`remote-lib-common/test/noise.test.mjs`), never against a value the production state machine computed, and this section's properties are driven end to end by `remote-lib-common/test/security-guarantees.test.mjs`.
- **FAIL IF** `scripts/e2e-lint.mjs` and `scripts/e2e-lint-selftest.mjs` stop running in the root `pnpm test`, or a rule is added to the lint without the self-test proving it load-bearing. Each rule in `RULES` names the line above that it enforces, or one in `docs/specs/security-hosted.md` -> "Rendezvous boundary" (rationale).
- **FAIL IF** the self-host Relay (`relay/`) begins admitting an `accountId` other than `SELFHOST_ACCOUNT_ID` (`remote-lib-common/src/remote/wire.ts`), or gains a self-serve signup path. The Hosted Relay's accounts are `docs/specs/security-hosted.md` -> "Relay boundary"; Reserved: paid activation remains subject to `## Future` -> Cloud-hosted mode.

### Relay origin

`docs/specs/relay.md` -> "Relay origin" owns the rule these checks audit.

- **FAIL IF** `DEFAULT_RELAY_ORIGIN` is not exactly `https://relay.dormouse.sh` in **both** `scripts/relay-origin.mjs` and `lib/src/host/relay-origin.ts` (`lib/src/host/relay-origin.test.ts` pins both), or `.github/workflows/release.yml` sets `DORMOUSE_RELAY_ORIGIN` — either changes what every shipped binary talks to.
- **FAIL IF** `HOSTED_VOICE_ORIGIN` in `lib/src/host/relay-origin.ts` is not exactly `https://voice.dormouse.sh` or is read from anything a build or user sets, or `createManagedVoiceHost` in `lib/src/host/managed-voice-host.ts` sends the voice token anywhere but `hostedVoiceOrigin`'s answer. Pinned by `lib/src/host/relay-origin.test.ts` and `lib/src/host/managed-voice-host.test.ts`.
- **FAIL IF** a Hosted build's enrollment opens an account page other than the one `enrollVerificationUrl` in `lib/src/host/remote/service.ts` composes — `HOSTED_ACCOUNT_ORIGIN/enroll#<userCode>` in a release build; in a dev Hosted build (`isDevHostedBuild`) only the origin of the Relay's `verificationUrl`, after the link checks — or `HOSTED_ACCOUNT_ORIGIN` in `lib/src/host/relay-origin.ts` is not exactly `https://hosted.dormouse.sh`, is read from anything a build or user sets, or is requested by the desktop; or the enrollment's device code reaches a webview (`HostedEnrollmentState` in `lib/src/host/remote/service-protocol.ts`). Pinned by `lib/src/host/remote/service.test.ts` and `lib/src/host/relay-origin.test.ts`.
- **FAIL IF** `assertRelayOriginBaked` is no longer called on the built bundle by both `standalone/scripts/build-sidecar-proxy.mjs` and `vscode-ext/scripts/esbuild.mjs` — including the **watch** branch of the VS Code script — or `resolveRelayOrigin` stops failing the build on any case `docs/specs/relay.md` -> "Relay origin" lists (rationale).
- **FAIL IF** a Burrow reaches a Relay at any origin but its `relay` option — `bakedRelay()`, passed by `lib/src/host/remote/sidecar-entry.ts` and `vscode-ext/src/burrow.ts` — taking one from a command, the offer file, or a stored enrollment, connects on an enrollment whose Relay URL or `origin` names another rather than reading it as none (`loadEnrollmentFor`), or saves one whose Relay reports another `origin` (`BurrowService` in `lib/src/host/remote/service.ts`); or if `POST /api/burrow/enroll` in `relay/src/app.ts` reads the credential or touches `burrows.json` for a request naming another origin.
- **FAIL IF** a self-host build can reach `dormouse.sh` or any host under it unless the user clicks a link to it. `hostedOrigin` and `hostedVoiceOrigin` in `lib/src/host/relay-origin.ts` must answer `null` there, and every Hosted-reaching host feature must take one of them and do nothing on `null`: `BurrowService` builds no `OneTimeRuntime`, and `createManagedVoiceHost` in `lib/src/host/managed-voice-host.ts` reads no token and sends no request. In standalone, `standalone/vite.config.ts` must bake the webview through `resolveRelayOrigin`; `startUpdateCheck` in `standalone/src/updater.ts` must return before `check()` unless `bakedRelayMode()` is `'hosted'`; `managedVoicePortForBuild` in `standalone/src/managed-voice-port.ts` must give a self-host webview no port; and `standalone/scripts/tauri.mjs` must overlay a self-host `tauri build` with no updater endpoint. Search the rest of `lib/src/host/`, `standalone/`, and `vscode-ext/src/` for any other request to a `dormouse.sh` host.
- **FAIL IF** an enrollment exchange in `lib/src/remote/burrow/enrollment.ts` — the password's, or the device code's begin and poll — or the shared `burrowFetch` in `lib/src/remote/burrow/burrow-fetch.ts` — the transport behind both push delivery and the setup-token mint — drops `redirect: 'error'`. **Every new Burrow→Relay call goes through `burrowFetch`** (rationale).

### Credentials at rest

**Persistent credentials are a full bypass of some layer if they leak to another
local account.** File-backed credentials use mode `0700`/`0600` on Unix and
owner-only DACLs in the installed Windows Relay and standalone Burrow; Node
modes do not protect Windows files. VS Code uses its own storage mechanisms,
as specified in each row.

| Credential | Where it lives | Protection |
| --- | --- | --- |
| Setup password | `setup-password.json` in the Relay state dir | generated by the Relay on first boot; never accepted from configuration or printed by a routine install |
| Enrollment offer | `run/enroll-offer.json` in the install root, under an owner-only `run/` | mode and DACL both applied before the token is written; one-time (`docs/specs/relay.md` -> "Configuration"); never printed, the service definition and wrapper carrying only its path |
| `burrowToken` (the `/ws/burrow` bearer) and the Burrow's Noise static private key | Relay `burrows.json` (the token only); Burrow side both in the enrollment record, the Noise static minted locally and never sent to the Relay (`docs/specs/remote-security-model.md` -> "Burrow identity") | the Relay state dir and every file in it; on Windows the files inherit the installer's DACL on `state`, so `manage verify` checks them individually. Burrow side a `0600` file in standalone (on Windows the app-data-dir DACL the Rust side applies), `SecretStorage` (the OS keychain) in VS Code — never a webview realm |
| VAPID private key | Relay `vapid.json` | nothing additional |
| Burrow ACL | `BurrowStateStore`, keyed per `burrowId` | a `0600` file in standalone; VS Code `globalState`, protected by VS Code's storage permissions rather than a Dormouse-applied DACL. Mostly public keys, with one exception: each record's `deliveryId` is a bearer capability for that Client's push rows, so a reader could delete or hijack a subscription — not reach a terminal. Neither store provides *integrity* against a same-user process and nothing here claims otherwise; standalone's private storage stops another local **account** adding a record (rationale). Deliberately never on the Relay |

**Must apply explicit private permissions to file-backed credentials rather
than rely on the ambient umask.** The Client's
per-Burrow browser storage follows `docs/specs/remote-security-model.md` ->
"Client statics".

- **FAIL IF** Pocket persists plaintext Client private bytes, uses an extractable
  AES wrapping key, selects encrypted storage without a failed native probe and
  a passing encrypted reopen/use probe, or treats a corrupt encrypted record as
  permission to generate a replacement identity. Read
  `lib/src/remote/client/pocket-private-key.ts` and
  `lib/src/remote/client/pocket-db.ts`; pinned by
  `lib/src/remote/client/pocket-encrypted-storage.test.ts`.
- **FAIL IF** AES-GCM appears in production source under `remote-lib-common/src/`,
  `lib/src/`, or `relay/src/` outside the local at-rest
  wrapper `lib/src/remote/client/pocket-private-key.ts` and the Web Push sender
  `remote-lib-common/src/remote/web-push.ts`, whose `aes128gcm` record RFC 8291
  fixes. The wire cipher is unchanged; `scripts/e2e-lint.mjs` and
  `scripts/e2e-lint-selftest.mjs` pin these exceptions.

- **FAIL IF** `relay/src/state.ts` stops creating `$DORMOUSE_STATE_DIR` mode `0o700`, or stops writing every file through `writeAtomic` at mode `0o600`. The "every file" clause is a negative search over `relay/src/`: no `writeFile`, `appendFile`, or `createWriteStream` may target the state directory outside `writeAtomic`. A cheap default, not a cross-platform guarantee; the installer's directory permissions below protect the installed Relay's state (rationale).
- **FAIL IF** `FileBurrowStateStore` (`lib/src/host/remote/burrow-state-store.ts`) stops creating its directory `0o700` and writing `0o600` on non-Windows platforms, or if `VsCodeBurrowStateStore` stops keeping the **enrollment** in `SecretStorage`. The ACL's home in `globalState` is deliberate and is not a finding; the enrollment's is what carries `burrowToken`.
- **FAIL IF** the Relay stops deleting `state/hosts.json` unread at boot (`forgetRetiredState` in `relay/src/state.ts`, called from `relay/src/start.ts`): the v1.0–v1.1 `server/` Relay kept a live `hostToken` per row there, under a name the Host→Burrow rename retired, and nothing else reads or removes it. Pinned by `relay/test/state-records.test.mjs`.
- **FAIL IF** `burrow_state_dir` in `standalone/src-tauri/src/lib.rs` passes the sidecar a state directory `restrict_to_owner` did not lock — on Windows those Node modes are no-ops and Node cannot set an ACL, so the guarantee is held one layer down; a refusal keeps the Burrow in memory (`burrow_directory_permission_failure_disables_durable_state`). That call carries both legs: a newly written enrollment file *inherits* the owner-only entry, and one a prior version already left under the `%LOCALAPPDATA%` ACL — with a live `burrowToken` in it — has that entry *propagated* onto it, the half `restrict_to_owner_leaves_one_owner_only_ace` covers with its pre-existing `before.json`.
- **FAIL IF** `relay/src/start.ts` stops obtaining the setup password from `SetupPasswordStore.loadOrCreate(generateSetupPassword)`, `generateSetupPassword` stops using `crypto.randomBytes(32)`, `readConfig` reads `DORMOUSE_SETUP_PASSWORD` or any other setup-password input, or `SetupPasswordStore` stops refusing a persisted or generated value outside 64 lowercase hexadecimal characters. Pinned by `relay/test/config.test.mjs` and `relay/test/setup-password-store.test.mjs`.
- **FAIL IF** `createApp` accepts anything but 64 lowercase hexadecimal characters as the setup password injected by the entrypoint; pinned by `relay/test/app.test.mjs`.
- **FAIL IF** any installer stops making `config/`, `state/`, and `config/relay.env` reachable only by the installing user — the effective property `manage verify` tests: no principal other than that user may appear in the effective permissions. macOS and Linux achieve it with `0700`/`0600` under `umask 077`; Windows with a single owner-only ACE, whether the path carries it directly or inherits it from an already-locked parent. The Windows and Linux installers create `relay.env` and lock it before writing its contents (rationale).
- **FAIL IF** `manage verify` stops checking mode **and** owner on `config/`, `state/`, `run/`, `config/relay.env`, and an unspent enrollment offer on macOS or Linux, or Windows `Test-OwnerOnly` stops checking the owner SID alongside the DACL, or accepts an empty access-rule set. A NULL DACL grants everyone access. `scripts/installer-verify-test.mjs` exercises the unix checks; `scripts/deploy-lint.mjs` and its self-test pin all three platforms (rationale).
- **FAIL IF** `manage verify` stops walking the files inside `state/` on Windows, where `relay/src/state.ts`'s `0o600` is a no-op and they are covered by what they inherit from the directory. An enumeration that fails fails verify, because that walk is the only thing holding the property there (rationale).
- **FAIL IF** any installer stops preserving an existing `config/relay.env` byte-for-byte across an update. Each installer names the installer-owned keys a preserved file lacks and stops; nothing is rewritten or regenerated over it (rationale).
- **FAIL IF** any installer mints the enrollment offer's token from anything but its named CSPRNG or drops its length guard — 64 hex characters, not 32. The offer redeems for a Burrow enrollment, so its entropy is the password's.
- **FAIL IF** the offer's publication file, **or `run/` itself**, is reachable by any principal other than the installing user, or becomes so only *after* the token is written. Each installer creates an owner-only temporary file inside `run/`, writes the complete offer, then atomically renames it over the well-known path: redemption sees one complete generation or the other, never a truncate/chmod/write window. `run/` is `0700` (a single-ACE DACL on Windows) alongside `config/` and `state/`, and `manage verify` asserts it (rationale).
- **FAIL IF** any installer prints the offer's token, or writes it anywhere but that owner-only same-directory publication file. There is no `manage show-password` counterpart: the reader is a Burrow process, not a human.
- **FAIL IF** any installer writes the offer anywhere but `<install root>/run/`, stops re-minting it on runs before the first Burrow enrollment, mints one after `state/burrows.json` exists, or mints it before the switched release, HTTPS Serve mapping, and pruning have succeeded. `burrows.json` is the durable "bootstrap completed" marker even when every row is later removed; the Relay serializes that decision with the Burrow-store write and consumes the offer when either credential path wins (rationale).
- **FAIL IF** an installer accepts or supplies the setup password as configuration, prints it during routine installation, or `manage show-password` reads anywhere but the Relay's `state/setup-password.json`. `scripts/deploy-lint.mjs` and its self-test pin all three installers.

### The setup password

**One password bootstraps everything the Relay can grant.** Enrolling Burrows is its
only endpoint, but an enrolled Burrow mints setup tokens and a setup token registers an
owner passkey, so the account is one step behind it rather than beside it.

**The Relay generates it, never the operator** (`docs/specs/relay.md` ->
"Configuration").

**Online guessing is bounded without trusting network identity.** Every
Burrow-enrollment POST spends from one process-global bucket before its body is read,
answering 429 with `Retry-After` when empty ([relay.md](./relay.md#http-api) holds
the burst and refill). The comparison is constant-time and a rejected credential pays
a fixed delay (rationale).

- **FAIL IF** the setup password comparison stops being constant-time, its rate-limited rejection loses the fixed delay, or a random setup/Burrow bearer rejection gains that delay and lets public traffic retain requests. `secretEquals` in `relay/src/secrets.ts` compares SHA-256 digests with `timingSafeEqual`; `CREDENTIAL_FAILURE_DELAY_MS` in `relay/src/app.ts` is the 250 ms, and `relay/test/burrows.test.mjs` pins which rejections pay it.
- **FAIL IF** `POST /api/burrow/enroll` stops spending from one process-global `TokenBucket` before body parsing, admits more than `BURROW_ENROLL_ATTEMPT_BURST` at once, refills faster than one per `BURROW_ENROLL_ATTEMPT_REFILL_MS`, or allocates state per caller. Every POST counts; OPTIONS does not. `relay/test/token-bucket.test.mjs` pins ordering, concurrency and 429 `Retry-After`; `remote-lib-common/test/token-bucket.test.mjs` pins the refill arithmetic the Burrow's crypto budget shares.

### Cross-origin access

**Never grant cross-origin browser reads or authenticate from a cookie.**
Pocket uses relative API URLs at the configured origin; Burrow HTTP runs in
Node. The Relay grants no preflight or CORS response; it does not reject every
request carrying a foreign `Origin` (rationale).

- **FAIL IF** the Relay installs CORS middleware, emits `Access-Control-Allow-Origin`, or accepts authentication from a cookie (rationale). Pinned by `relay/test/cors.test.mjs`.

### Network posture (self-hosted)

**`scripts/deploy-lint.mjs` (`pnpm test`) makes the cheap half of this section and of
"Credentials at rest" deterministic**: every installer must still contain the control
each `FAIL IF` names, so a control deleted from one of the three fails a build. It is
textual and cannot tell whether a control is *correct* — the audit owns that — and on
Windows, which nothing in CI can execute, it is the only automated signal about those
controls; `scripts/ps1-cmdlet-lint.mjs` reads the same file for cmdlet syntax alone.
`scripts/deploy-lint-selftest.mjs` deletes each matched control in turn and requires
the lint to fail (rationale).

**The shipped self-host deployment is a per-login user agent bound to loopback** — a
macOS LaunchAgent, a Windows Scheduled Task, or a Linux systemd user service — with
`tailscale serve` terminating HTTPS on the node's own MagicDNS name. Two invariants
follow, the same on all three:

- **The Relay always speaks plain HTTP, so the listen interface *is* a security boundary when the TLS proxy is local.** An unbound socket publishes the plaintext port to the LAN and to the tailnet itself, so the install pins `DORMOUSE_BIND_HOST=127.0.0.1` and refuses to proceed without it.
- **`DORMOUSE_ORIGIN` is durable WebAuthn identity.** Rewriting it silently invalidates the registered passkey and every enrolled Burrow, so the installer stops rather than rewriting a mismatch.

**May publish the HTTPS origin publicly.** Tailnet-only Serve is the installer default and
network-layer defense-in-depth, never an authentication premise. Enabling Tailscale
Funnel publishes the same TLS origin and stays inside this analysis: public admission
is owned by [The setup password](#the-setup-password), and a Client still reaches no
Burrow without the Burrow-local authorization above.

**A direct path opens the one listener no loopback rule covers.** ICE gathering
binds a UDP socket per local address, so while an attempt is live the machine
answers UDP from anyone routing to it on any of those networks.
`docs/specs/security-local.md` -> "Loopback Listeners" is about loopback TCP and
`scripts/loopback-lint.mjs` reads bind spellings in our own source, so neither
reaches a socket the browser or the addon binds. It exists only between an
offer and that session's disposal, and what answers on it is
`docs/specs/remote-security-model.md` -> "Direct path"; Local networks may
narrow it (`docs/specs/remote-network.md` -> "Local networks").

**Must not make Funnel state an install or health verdict.** The installers configure
Serve but neither inspect, warn about, enable, nor disable Funnel; `manage verify`
checks the local TLS-to-loopback path, while CI and this audit check application
controls.

- **FAIL IF** `deploy/local/install-macos.sh`, `deploy/local/install-windows.ps1`, or `deploy/local/install-linux.sh` stops requiring the effective `DORMOUSE_BIND_HOST` in `config/relay.env` to be `127.0.0.1`, or if any `manage verify` stops asserting that the plaintext port is unreachable on the node's Tailscale IP.
- **FAIL IF** the unset default of `DORMOUSE_BIND_HOST` in `relay/src/config.ts` stops being `undefined` — listen on every interface, what a container wants, where the namespace is the boundary — or if `relay/test/bind-host.test.mjs` stops spawning the real entrypoint to prove the plaintext port is unreachable off-loopback when it *is* set.
- **FAIL IF** any installer stops refusing to rewrite a `DORMOUSE_ORIGIN` that no longer matches the node's DNS name.
- **FAIL IF** any installer stops refusing to run with elevated privileges — `id -u` on macOS and Linux, the `Administrator` role check on Windows (rationale).
- **FAIL IF** an installer or `manage` names `tailscale funnel` or `AllowFunnel` at all — invoking it, judging its state, or changing it all begin there, and public reachability must exercise the application controls rather than become a forbidden deployment state. Held by `scripts/deploy-lint.mjs` (rationale).
- **FAIL IF** any decision taken on Tailscale CLI or listener output is reached by piping that output into `grep -q`, or into a `head -1` that exits first; every such search is over text captured first, in a helper as much as inline (rationale).
- **FAIL IF** any decision about whether Serve maps `/` to us — the install-time conflict gate, `manage verify`, and the uninstall that turns Serve off — is not additionally scoped to the root line with the port right-bounded. The post-mutation `SERVE_AFTER` assertion is the one deliberate exception (rationale).
- **FAIL IF** `scripts/installer-verify-test.mjs` stops driving `has_off_loopback` and `serve_state` over inputs larger than the pipe buffer, or stops pinning `serve_proxies_root`'s root scoping and port bound. `scripts/deploy-lint.mjs` holds that helper's `<<<` pattern and counts its consumers; `serve_root_target` is held by neither on purpose (rationale).

### What crosses the boundary

**The relay is a dumb ciphertext pipe**: it routes `e2e` envelopes within one
Client↔Burrow binding and decodes nothing. Both directions carry untrusted bytes once a
Burrow has decrypted them — inbound, `terminal.write` is keystrokes into a real shell and
the ACL is the entire gate; outbound, terminal bytes reach a phone and notification text
originates in a renderer and is Pane-derived, so it is **bounded on the Burrow before
sealing and re-bounded at the render sink** (below; rationale).

**Web Push is the one path where the Relay makes an outbound request to an address a
Client supplied**, which on a Relay *inside* a tailnet is a live SSRF concern:
`100.64/10` is exactly the range a push endpoint must not be allowed to reach.
Registration rejects credentials, localhost, and non-public IP literals; delivery goes
through a dedicated agent whose connection-time DNS lookup rejects loopback, private,
CGNAT, link-local, documentation, benchmark, multicast, reserved, IPv4-mapped,
unique-local, and site-local ranges — rejecting a hostname wholesale if *any* answer is
blocked, and handing the socket the exact address it checked so rebinding cannot create
a second unchecked resolution.
The Hosted Relay, which cannot pin a resolution, admits only known push services' hosts
instead (`docs/specs/security-hosted.md` -> "Relay boundary").

- **FAIL IF** `relay/src/push-endpoint.ts` stops rejecting non-public push endpoints at registration, stops applying `createPublicLookup` / `createPublicPushAgent` to delivery, or stops rejecting a hostname whose DNS answers are mixed public and blocked.
- **FAIL IF** `/api/push/send` stops taking the `burrowId` from the Burrow's own token, begins selecting recipients when `recipients` is absent or empty, stops clamping them at `MAX_PUSH_QUERY_DELIVERY_IDS`, or if any read endpoint begins reporting on a delivery id the caller did not present. Possession of the 256-bit `deliveryId` is the whole authorization for the Client-facing push routes, so the Relay must never *list* one to a session.
- **FAIL IF** the send route reads, rewrites, or logs notification text, or forwards anything but the sealed envelope plus the token's own `burrowId`. The Relay holds no key for it (`docs/specs/remote-security-model.md` -> "Push sealing"), so a route that could read a payload is one that was handed plaintext. The envelope's three fields must be copied individually rather than spread, since a spread would let a sending Burrow override its own token's `burrowId`.
- **FAIL IF** a push stops being sealed per recipient, to that ACL record's own Client static, under a fresh salt — the construction is `docs/specs/remote-security-model.md` -> "Push sealing", `sealPush` / `openPush` in `remote-lib-common/src/security/push-seal.ts`, proven by `remote-lib-common/test/push-seal.test.mjs`. A Noise `CipherState`, a shared group key, or a reused salt each break it. `BurrowRuntime.sealPushForClient` hands `lib/src/remote/burrow/push-delivery.ts` a seal *capability* and never the Burrow's private key, and the worker in `lib/src/remote/pocket-app/sw.ts` is the only thing that opens one.
- **FAIL IF** push text stops being bounded with the shared `boundedPushText` on the Burrow before sealing, or re-bounded with it in `lib/src/remote/pocket-app/sw.ts` before `showNotification`. The worker is the sanitization sink (rationale).
- **FAIL IF** the relay routes a Burrow-originated frame from a socket that is not the Client's current Burrow binding, or begins decoding, remembering, or acting on an `e2e` ciphertext. `relay/src/relay.ts` must route the `e2e` envelope and nothing else: it holds no gate, no challenge memory, and no notion of an authorized session (rationale). A Relay-side type import from the protocol-v1 half of `remote-lib-common/src/remote/wire.ts` is the leading indicator and fails the same way, as does one under `hosted/server/`.

### Direct path

**An authorized session may leave the Relay for a WebRTC data channel, carrying
what it already carried**: the same Noise session, the same counters, the same
bounds. `docs/specs/remote-api.md` -> "Direct path" owns the design and
`docs/specs/remote-security-model.md` -> "Direct path" owns why it adds no trust
layer; neither is restated below.

- **FAIL IF** a `direct-offer` is accepted or sent before promotion, or a session runs a second attempt. Both halves of `DirectEndpoint` in `lib/src/remote/direct/direct-endpoint.ts` must pass `DirectCutover.begin`, which answers `true` once per session, before their first `await`; and the endpoint holding it must be built only at promotion — `EstablishedE2eSession` in `lib/src/remote/burrow/established-session.ts`, built by `BurrowRuntime.#promoteConnection` in `lib/src/remote/burrow/burrow-runtime.ts` and by `OneTimeRuntime.#promote` in `lib/src/remote/burrow/one-time-runtime.ts`, reached only from a matching confirmation; `ClientSessionCore.establish` in `lib/src/remote/client/session-core.ts`, called only from the `ok: true` branches of `PocketClient.connect` in `lib/src/remote/client/pocket-client.ts` and `OneTimeClient.connectOnce` in `lib/src/remote/client/one-time-client.ts` — since a peer connection built earlier is one an unauthorized party steered.
- **FAIL IF** a byte crosses the channel that is not a Noise transport message of the promoted session: one message per frame, raw bytes, no second handshake, no plaintext, and no framing of ours beside it. **Every inbound frame is bounded at `NOISE_MAX_MESSAGE_LENGTH` before it reaches a cipher** — `DirectPeer` in `lib/src/remote/direct/direct-peer.ts` must refuse an over-cap frame and a non-binary message as violations rather than parse either.
- **FAIL IF** any signaling leaves the ciphertext. The four signals and the Burrow's goodbye (`SessionEndV1`, exact keys) are `control` messages on the established session, so no relay route, frame type, or Relay-side guard may carry, name, or validate an SDP, a candidate, or the goodbye: a negative search over `relay/src/` and `hosted/server/` for `sdp`, the four signal names, `session-end`, and `RTCPeerConnection` must find nothing. `scripts/e2e-lint.mjs` holds it textually.
- **FAIL IF** shipped source names an ICE server but Cloudflare's STUN, or hands it to a Burrow's peer at any level but `anywhere` or to a page a self-host Relay serves; a STUN server learns the address of each end that asks it. Under `remote-lib-common/src/`, `lib/src/`, `relay/src/`, and `hosted/server/`, the only `stun:`, `stuns:`, `turn:`, or `turns:` URL is exactly `stun:stun.cloudflare.com:3478`, spelled only as `CLOUDFLARE_STUN_URL` in `lib/src/remote/direct/ice-servers.ts` and listed only by `stunServers` there, which only the two peer factories call, the native one never with a literal `true`; and `iceServers` appears only in the two peer factories: `createNativeDirectPeerFactory` in `lib/src/host/remote/native-direct-peer.ts`, and `hostedDirectPeer` (the one-time page's, and Pocket's where Hosted serves it) and `selfHostDirectPeer` (Pocket's elsewhere) in `lib/src/remote/client/browser-direct-peer.ts`, Pocket choosing by `deploymentDirectPeer` in `lib/src/remote/pocket-app/deployment.ts`, which reads Hosted only from the exact `deployment.json` Hosted's staging writes. `directPeeringFor` in `lib/src/host/remote/direct-peering.ts` must bind the native factory's `stun` true only where `burrowUsesStun` holds for the policy a runtime opens or starts under, beside its path policy. `scripts/e2e-lint.mjs` holds the spelling textually; pinned by `lib/src/host/remote/service.test.ts`, `lib/src/remote/client/browser-direct-peer.test.ts`, and `lib/src/host/remote/native-direct-peer.test.ts`.
- **FAIL IF** a peer connection can outlive its session by more than the goodbye's flush. `DirectEndpoint.dispose` closes it and must run on every path that ends one — or, once `EstablishedE2eSession.end` has put the goodbye on a switched channel, `DirectEndpoint.disposeAfterFlush`, which sends and delivers nothing more and closes it once the goodbye has left or after `SESSION_END_FLUSH_MS`: in `lib/src/remote/burrow/burrow-runtime.ts` `#disposeEstablished` — which `#disposeClient` reaches from `client-gone` and socket loss — and the session `#promoteConnection` replaces, each through `EstablishedE2eSession.dispose`, and `stop()`, its goodbye unflushed to leave no timer; in `lib/src/remote/burrow/one-time-runtime.ts` `#end`, which every ending of a one-time connection runs through; in `lib/src/remote/client/session-core.ts` `disposeSession`, on every ending — `establish` replacing a session, `PocketClient`'s intentional `close()` and dropped relay socket, and every ending of a `OneTimeClient` included.
- **FAIL IF** the direct path stops bounding what it holds, or stops disposing on a violation. Held frames are capped by `MAX_DIRECT_PENDING_FRAMES` **and** `MAX_DIRECT_PENDING_BYTES`, and a sender's queue by that same pair — neither direction may hand the implementation unbounded data instead, and overflow disposes the session rather than dropping a frame; a relay `transport` frame arriving after inbound has switched disposes it before any decrypt; the channel closing or erroring after either direction has switched disposes it at both ends. `DirectCutover` in `remote-lib-common/src/security/direct-path.ts` decides all three, and through `onSwitchDecrypted` that a switch onto a channel this end abandoned ends the session; `DirectEndpoint`, which both ends run, must act on every outcome it returns, and must be both ends' only entry for a relay frame: `onRelayFrame` decodes the `ct` there, so an undecodable one ends the session rather than escaping a socket handler. Pinned by `remote-lib-common/test/direct-path.test.mjs`, `lib/src/remote/direct/direct-endpoint.test.ts`, and the direct cases in `lib/src/remote/burrow/burrow-bounds.test.ts` and `lib/src/remote/client/pocket-client.test.ts`.
- **FAIL IF** either Burrow's native peer addon is loaded at host startup rather than at the first offer, or its absence changes anything but a decline. `createNativeDirectPeerFactory` in `lib/src/host/remote/` must reach `node-datachannel` — declared in `standalone/sidecar/package.json` and `vscode-ext/package.json` — only through a bare `require` performed inside an authorized session's first offer, and a load failure must answer `direct-decline` and leave that session relayed rather than fail the Burrow's start.
- **FAIL IF** a switched end waits on its peer without a deadline, or a channel this protocol did not ask for is adopted. `DirectPeer` in `lib/src/remote/direct/direct-peer.ts` must refuse a channel that is not `DIRECT_CHANNEL_LABEL`, one reported unordered or partially reliable, and one whose association reports a per-message limit below `NOISE_MAX_MESSAGE_LENGTH` — all before it reports the open, so each abandons the attempt while the relay still carries the session. **The reliability half is defence in depth against a paired Client, not a boundary control**, and reaches only as far as the implementation reports those flags: on either Burrow it does not, which `lib/src/host/remote/native-direct-peer.test.ts` pins so a version that changes it is noticed (`docs/specs/remote-api.md` -> Transport -> "Direct path"). `DirectEndpoint` must arm `DIRECT_HANDOFF_TIMEOUT_MS` on its own switch, since from there it sends only on the channel. Pinned by `lib/src/remote/direct/direct-peer.test.ts` and `lib/src/remote/direct/direct-endpoint.test.ts`.
- **FAIL IF** under Local networks a paired phone's application message is read off the Relay, or its session outlives a given-up attempt or a missed `DIRECT_ONLY_DEADLINE_MS`. `BurrowRuntime.#promoteConnection` in `lib/src/remote/burrow/burrow-runtime.ts` must derive `directOnly` from the path policy alone, say so in the outcome (`ConnectionOutcomeV1.directOnly`), and hand that flag to `EstablishedE2eSession` in `lib/src/remote/burrow/established-session.ts`, which owns the rule for both runtimes: no relayed application message reaches the handler; it and a given-up attempt report through `onDirectOnlyBroken`; `directDeadlineAt` stays set until both directions are direct. Each ends with the goodbye, but for a refused path. `BurrowService` in `lib/src/host/remote/service.ts` must start a `local` Burrow on `localNetworksPath` over the policy's `allowed`, and restart it on any change `samePaths` sees. `scripts/e2e-lint.mjs` holds the derivation and its hand-off textually; pinned by `lib/src/remote/burrow/burrow-direct-only.test.ts`, `lib/src/remote/burrow/established-session.test.ts`, and `lib/src/host/remote/service.test.ts`; `hosted/server/tests/relay-room.test.ts` pins only Relay interop.
- **FAIL IF** a direct path survives `client-gone`, `burrow-gone`, or a lost relay socket: the Relay stays the lifecycle authority on both paths of any session it carries ([One-time connection](#one-time-connection) is the one carve-out). Every Burrow bound is path-agnostic, and the idle deadline still moves only on a decrypted Client→Burrow transport message, whichever path carried it (`docs/specs/remote-security-model.md` -> "Burrow bounds").

### One-time connection

`docs/specs/one-time.md` owns the link and the rendezvous wire, its own frame
family ("Wire contract"); `docs/specs/remote-security-model.md` -> "One-time
connection" owns the ceremony.

- **FAIL IF** the Relay or `BurrowRuntime` can accept a one-time frame: `E2eKind` and `isE2eKind` in `remote-lib-common/src/remote/wire.ts` must admit exactly `pairing` and `connection`, and no one-time name may appear under `relay/src/`, in `remote-lib-common/src/remote/wire.ts`, or in `lib/src/remote/burrow/burrow-runtime.ts`. `scripts/e2e-lint.mjs` holds both textually.
- **FAIL IF** the one-time prologue stops binding every link field under its own kind: `oneTimeLinkPrologue` in `remote-lib-common/src/security/one-time-link.ts` must hash, through `e2eOneTimePrologue` in `remote-lib-common/src/security/noise-transport.ts`, the E2E domain, `one-time`, the room id, then the link's version, expiry, and one-use key in link order. Pinned by `remote-lib-common/test/one-time-link.test.mjs`.
- **FAIL IF** a one-time connection grants or writes anything that outlives it. `OneTimeRuntime` in `lib/src/remote/burrow/one-time-runtime.ts` must name no ACL, ACL store, delivery id, or presence verifier, persist nothing, and send a success outcome carrying the Burrow label alone. `scripts/e2e-lint.mjs` holds the naming textually.
- **FAIL IF** a link can admit a second phone or a second guess. The first handshake whose message 1, message 2, and Split succeed against the link's key must reserve the link and erase that key; every later `init` is dropped before any WebCrypto, and one that fails leaves the link open. `OneTimeRuntime.#approve` must set `attempted` before its expiry check and `constantTimeEqual`, and every outcome — success and each denial — is one padded control message sealed with `sealControl` in `lib/src/remote/burrow/established-session.ts`.
- **FAIL IF** the one-time approval modal can show text the phone chose, which could tell the person which digits to type. `OneTimeRuntime` in `lib/src/remote/burrow/one-time-runtime.ts` must pass the request's label through `knownOneTimeDeviceLabel` in `remote-lib-common/src/security/e2e-ceremony.ts` before `requestApproval` or any `OneTimeState` carries it, so a label that is not exactly a member of `ONE_TIME_DEVICE_LABELS` reaches the modal, the panel, and the Baseboard as `Phone browser`; the page's `oneTimeDeviceLabel` in `lib/src/remote/one-time-app/OneTimeApp.tsx` returns only members. Pinned by `lib/src/remote/burrow/one-time-runtime.test.ts` and `remote-lib-common/test/e2e-ceremony.test.mjs`.
- **FAIL IF** an application message crosses the rendezvous, or a one-time session outlives a missed direct deadline. `OneTimeRuntime` in `lib/src/remote/burrow/one-time-runtime.ts` must make its one session `directOnly` on `EstablishedE2eSession`: after the outcome an application message decrypted off the rendezvous ends the session unread, and a decline, an abandoned attempt, or no switch by `DIRECT_ONLY_DEADLINE_MS` ends it — no relayed fallback. `scripts/e2e-lint.mjs` holds the flag textually. After the switch the direct channel is the lifecycle authority: the runtime closes the rendezvous, and channel loss or `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` idle ends the session.
- **FAIL IF** the phone can reach the room unasked or put protocol-v1 on it. `OneTimeClient` in `lib/src/remote/client/one-time-client.ts` must open its socket only inside `connectOnce`, refuse every protocol-v1 method until both directions are direct, and close the rendezvous normally at the switch; a decline, an abandoned attempt, or no switch by `DIRECT_ONLY_DEADLINE_MS` fails the attempt. It reads every frame through `parseOneTimeFrame` in `lib/src/remote/one-time-rendezvous.ts`, which measures it against `MAX_ONE_TIME_FRAME_LENGTH` before `JSON.parse`, and runs `isOneTimeBurrowFrame` on it. Pinned by `lib/src/remote/client/one-time-client.test.ts` and `lib/src/remote/client/one-time-e2e.test.ts`.
- **FAIL IF** a one-time phone keeps anything past its session. `OneTimeClient` must mint its static with `generateNoiseKeyPair`, nonextractable, for the one handshake, and it, `ClientSessionCore` in `lib/src/remote/client/session-core.ts`, and every module of the page in `lib/src/remote/one-time-app/` may name no browser store or service worker, nor import Pocket's records, key wrapping, passkeys, push, or `PocketClient`; the page's theme goes through `applyPocketTheme`, which writes nothing. `scripts/e2e-lint.mjs` holds the naming textually.
- **FAIL IF** the rendezvous origin is anything but the Burrow's `hostedOrigin` (Relay origin, above), comes from a command (`oneTimeOpen` takes no parameters), or is used by a socket opened before it is checked. `BurrowService` in `lib/src/host/remote/service.ts` holds at most one runtime, ending the one a new link replaces, and refuses a new link while a phone is connecting or connected; the socket carries no `Origin` header. Pinned by `lib/src/host/remote/service.test.ts`.
- **FAIL IF** under Local networks a one-time session's channel can report open, or stay open past a state change or `DIRECT_PATH_RECHECK_MS`, on a selected pair whose two ends are not both IP literals inside the allowed networks; the Burrow's answer carries, or the offer it applies keeps, a candidate outside them; or the attempt's socket is not bound to the one allowed address where exactly one is present. `BurrowService` in `lib/src/host/remote/service.ts` must hand a `local` runtime `localNetworksPath` over the policy's `allowed`, which `DirectEndpoint` in `lib/src/remote/direct/direct-endpoint.ts` hands to the peer factory, and `createNativeDirectPeerFactory` in `lib/src/host/remote/native-direct-peer.ts` must bind the address its `bindAddress` names; `DirectPeer` in `lib/src/remote/direct/direct-peer.ts` must apply only the offer the policy accepts, and consult the policy before `onOpen`, on each state change and every `DIRECT_PATH_RECHECK_MS` while open, `connected`, and reporting a pair, and before an unopened channel's frame, ending the session on refusal; `localNetworksPath` in `lib/src/host/remote/local-networks.ts` reads only the Burrow's own selected pair, refusing a name or no pair. Pinned by `lib/src/host/remote/local-networks.test.ts`, `lib/src/remote/direct/direct-peer.test.ts`, `lib/src/remote/burrow/one-time-runtime.test.ts`, and `lib/src/host/remote/native-direct-peer.test.ts`.
- **FAIL IF** the one-time runtime relies on the rendezvous for any bound. It must read every message through `parseOneTimeFrame`, which measures it against `MAX_ONE_TIME_FRAME_LENGTH` before `JSON.parse`, shape-guard every frame, stop reading a room past `MAX_ONE_TIME_FORWARDED` messages, gate each `init`'s WebCrypto on its own `TokenBucket` of `E2E_INIT_BURST`, and end on its own clock — a link not yet promoted at its expiry, claimed or not, and a promoted one by `DIRECT_ONLY_DEADLINE_MS` — never after the room would. Pinned by `lib/src/remote/burrow/one-time-runtime.test.ts`.

### Revocation and the audit trail

These are the two real gaps in the shipped model, and they are gaps rather than
accepted risks — we intend to close them (rationale).

**Revocation has no mechanism.** `BurrowAcl.revokeClient` / `revokePasskey` exist and
have no production callers — only `remote-lib-common/test/acl.test.mjs` and
`security-guarantees.test.mjs` reach them; no relay frame carries a revocation; there is
no management UI.
Revoking a lost phone means hand-editing JSON on the Burrow **and restarting it**:
`BurrowService.#startBurrow` reads the store once and hands the `BurrowRuntime` a
snapshot for its whole lifetime, so an edit alone changes nothing that is running. The
restart is the whole lever — it reloads the ACL and, by dropping the relay socket, ends
every established session. Relay-pushed propagation is staged in
`docs/specs/remote-security-model.md` -> "Future" (Revocation propagation).

**There is no structured audit trail covering connects, attaches, denials, or
writes.** The ACL records `approvedAt` / `approvedBy`; owner-local logs report
some rejections, without recording a complete session history. A self-hoster cannot answer
"did anyone connect to my laptop last night".

## Auxiliary helpers

**Must exclude unpromoted helpers from both remote directory discovery and direct attachment/resize resolution.** Promotion enables ordinary terminal access; hidden helper output and input are unavailable before that ownership change.

Source of truth: `collectDirectorySnapshot` in `lib/src/remote/burrow/directory-collect.ts`; `driveOwnSurface` in `lib/src/remote/burrow/peer-surfaces.ts`.

## Future

### Cloud-hosted mode

Hosted's admin-entitled routing is implemented (`docs/specs/security-hosted.md`
-> "Relay boundary"). Broad paid activation remains staged; its review must
cover these operator responsibilities:

- **Must review Hosted operator handling of residual metadata before paid activation.** The visible metadata is `docs/specs/remote-security-model.md` -> "Residual metadata"; the trust boundary above still excludes plaintext and new Burrow authorization.
- **An independent cryptographic review is a precondition** of claiming this model for a paid service (`docs/specs/remote-security-model.md` -> "Security Guarantees").
- **Never rely on tailnet reachability for paid Hosted admission.** Review public admission and the multi-tenant account boundary before activation (`docs/specs/hosted.md` -> "Burrow enrollment"); the self-host setup password supplies no Hosted identity.
