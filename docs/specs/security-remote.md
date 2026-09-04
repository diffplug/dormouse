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
**Nothing here applies to a Burrow that never enrolls with a Relay**: enrollment is
where the relay, the phone, and push begin, and a Burrow that never enrolls has none
of them. Two deployment modes are defined (`docs/specs/remote-api.md` -> "Transport"); all of
the below is **self-hosted**, the only one that ships. Cloud-hosted is staged
([Cloud-hosted mode](#cloud-hosted-mode)).

### Trust boundary

**Five layers, none sufficient alone** (`docs/specs/remote-security-model.md` ->
"Trust Model"). A deployment may raise the presence layer to *user verification* with
`DORMOUSE_REQUIRE_USER_VERIFICATION=true`.

**There is exactly one channel and no other path.** One suite
(`Noise_IK_25519_ChaChaPoly_SHA256`) carries both ceremonies, protocol-v1, and the
terminal stream; there is no negotiation, no cipher or pattern selector,
no plaintext relay route, and no reader for any of the pre-cutover frames.

| Compromise | Buys | What still stands |
| --- | --- | --- |
| Relay | account state, routing metadata | **no new authorization and no plaintext**. On an established session, availability only — drop, delay, reorder, or refuse, never read and never inject — and the first invalid ciphertext destroys the session. Web Push holds **confidentiality**, not **freshness**: a kept envelope re-delivers as current, accepted residual (rationale) |
| Setup password | one endpoint, `/api/burrow/enroll`, and thence a `burrowToken` | it registers **no** passkey — `/api/setup/*` takes a Burrow-minted setup token and nothing else — so it reaches an owner passkey only via the next row. `/api/burrow/enroll` accepts one other credential, the installer's enrollment offer: owner-only *at rest*, the whole of what the file mode protects, checked by possession over HTTPS rather than local identity, so a leaked token redeems remotely — bounded single-use, 24-hour expiry, permanently disabled by the first Burrow enrollment. Still **no Burrow access** |
| `burrowToken` | the Burrow's own relay traffic and, transitively, **account takeover**: it mints setup tokens at `/api/burrow/setup-token`, the only thing that registers an owner passkey | bounded three ways — single-use and dead 5 minutes after minting; revoking the Burrow (deleting its row from `burrows.json`) stops minting immediately *and* kills already-minted tokens, re-checked at both setup gates; a signed-in phone retires an unused token at `/api/setup/retire`. Still **no Burrow access**: pairing runs Noise IK against an invitation keypair the Burrow never sent anywhere (rationale) |
| Synced or stolen passkey | sign-in, and the ability to *ask* | the paired Client static is missing, so `BurrowAcl` answers `client-not-paired` |
| Client static | use of the key in place, and only through a compromised browser or OS, or XSS in the Pocket origin | the key is not extractable, connecting still needs a fresh passkey assertion, and it authorizes exactly one Burrow |

**The only path into a Burrow's ACL is a human typing, on that Burrow, two digits displayed
on the phone that is asking**, and the Burrow gets the comparison exactly once. **The
webview is inside the trust boundary for *relaying* a confirmation and for nothing
else** — it cannot choose what is authorized, satisfy the confirmation without the
phone, or fabricate a request (rationale). The only path back out is
[Revocation and the audit trail](#revocation-and-the-audit-trail).

- **FAIL IF** the Burrow stops being the final authority: `BurrowRuntime.#onConnectionTransport` in `lib/src/remote/burrow/burrow-runtime.ts` must consume its own challenge, verify the presence proof with `verifyPresenceProof` against a binding built from the Burrow's own `burrowId`, connection id, challenge and handshake hash, and require one active `BurrowAclRecord` holding the account, the passkey credential, that key's hash, and the IK-authenticated Client static — before any session is established, and with no code path letting a Relay-supplied claim stand in for any of them.
- **FAIL IF** local confirmation stops being the only thing that **mints** an ACL record: `BurrowAcl.approve` must have no caller but `BurrowRuntime.#approvePairing`, the comparison must be constant-time and happen **exactly once** per ceremony, and it must match the immutable `pairingId` of the request that was displayed, never a mutable `clientId` alone.
- **FAIL IF** the expected two-digit code, or an invitation's private key, ever leaves the Burrow process: `PairingQueueItem` in `lib/src/host/remote/service-protocol.ts` carries `{ clientId, pairingId, label, requestedAt }` and nothing else (rationale).
- **FAIL IF** the pending-ceremony maps are unbounded, in **both** `BurrowRuntime`'s client map and the service's mirrored queue: pairings capped at `MAX_PENDING_PAIRINGS` on both sides, oldest evicted first; connection handshakes at `MAX_PENDING_CONNECTION_HANDSHAKES`; outstanding invitations at `MAX_TOKENS_PER_BURROW`. `MAX_CLIENT_ID_LENGTH` bounds `clientId` at the frame boundary, before any map is touched, and a handshake that fails to decrypt allocates no entry at all (rationale).
- **FAIL IF** any Burrow bound stops being enforced by the Burrow itself, on its own clock, with no help from the relay. `MAX_ESTABLISHED_E2E_SESSIONS` is checked **at promotion only** — after the presence proof and the ACL conjunction — and a Client static replaces its own session while any other identity at the cap gets `burrow-busy` and evicts no other entry. A Burrow-global token bucket (`E2E_INIT_BURST` decaying at one per `E2E_INIT_REFILL_INTERVAL_MS`) gates the WebCrypto an accepted `init` buys, and a frame it refuses performs no operation and allocates nothing. One reaper over absolute timestamps — invitation expiry, pairing TTL, challenge TTL, `ESTABLISHED_E2E_IDLE_TIMEOUT_MS`, the last refreshed only by a successfully decrypted Client→Burrow transport message — runs on every init, every local decision, every relay lifecycle event, and a next-expiry timer cleared on `stop()`. Values, and which file declares each: `docs/specs/remote-security-model.md` -> "Burrow bounds". Pinned by `lib/src/remote/burrow/burrow-bounds.test.ts` and `relay/test/malicious-relay.test.mjs` (rationale).
- **FAIL IF** `requireUserVerification` is reachable on one side without being mirrored to the other: the Relay reads `DORMOUSE_REQUIRE_USER_VERIFICATION`, and `BurrowEnrollResponse` must carry it into the Burrow's `ConnectionPolicy` (rationale).
- **FAIL IF** the Burrow accepts an `e2e` frame it has not shape-validated itself with `isE2eRelayToBurrowFrame` — relying instead on the relay's own overlapping guard (`isE2eClientFrame` / `isE2eBurrowFrame` in `relay/src/relay.ts`) — or lets the Client's device label reach any consumer un-reduced by `boundedPairingLabel` (rationale).
- **FAIL IF** a ceremony outcome stops being a fixed-size padded control message, or begins carrying which ACL half failed: success and every denial encrypt to the same length, every ACL miss answers `pairing-required`, and the specific miss is logged owner-locally only.
- **FAIL IF** any **service→webview** message can carry `burrowToken`, **or any other bearer credential the receiving realm has no route that takes** — `deliveryId` most of all, which is why `PushDevicesResult` is labels only. Check the direction, not just the identifier: `BurrowResult`, `BurrowStatusEvent`, `PairingQueueEvent`, `InvitationEvent`, `SetupQrResult`, `BurrowConsoleStatus`, and `PushDevicesResult` in `lib/src/host/remote/service-protocol.ts` are the outbound shapes and none may expose one; the test is whether the webview *calls* anything with the value, not whether exposing it is currently exploitable. The credentials that *do* cross outbound are the Relay's **setup token** and the invitation's **public** half, both inside `SetupQrResult.url`, minted only on request, single-use, and short-lived. Inbound differs — `EnrollParams` carries the setup password by design (rationale).
- **FAIL IF** a private key agreement ever leaves WebCrypto. **X25519 stays WebCrypto-only** (`generateKey` / `deriveBits` / `importKey`) and **never a JavaScript curve** (`@noble/curves`, `tweetnacl`, `libsodium`, or any other). The one bundled primitive is ChaCha20-Poly1305, from an exactly-pinned `@noble/ciphers` release; its two import sites and the pin's audit delta are recorded in `remote-lib-common/src/security/noise.ts`'s header, rewritten by any version bump in the same commit (rationale).
- **FAIL IF** the Burrow's Noise static is ever sent to the Relay, or a Burrow runs with halves that do not correspond: it is minted locally *before* the enrollment request and never sent in it, persisted only where `burrowToken` is, and `BurrowService` derives the public point from the private half and compares before starting — a mismatch keeps the Burrow down (rationale).
- **FAIL IF** `remote-lib-common/src/security/` stops being the shared implementation: the Relay, the Burrow, and the Pocket client must verify assertions, presence challenges, handshakes, and transport framing with the same modules. Conformance is proven against an independent implementation's published vector (`remote-lib-common/test/noise.test.mjs`), never against a value the production state machine computed, and this section's properties are driven end to end by `remote-lib-common/test/security-guarantees.test.mjs`.
- **FAIL IF** `scripts/e2e-lint.mjs` and `scripts/e2e-lint-selftest.mjs` stop running in the root `pnpm test`, or a rule is added to the lint without the self-test proving it load-bearing. Each rule in `RULES` names the line above that it enforces (rationale).
- **FAIL IF** the Relay begins admitting an `accountId` other than `SELFHOST_ACCOUNT_ID` (`remote-lib-common/src/remote/wire.ts`), or gains a self-serve signup path, while cloud-hosted mode is staged. Reserved: the cloud boundary is analyzed in `## Future` -> Cloud-hosted mode before the code that needs it ships.

### Where a Burrow may reach a Relay

**The baked relay-origin allowlist is what stops an install from enrolling against, or
connecting to, a relay the build was never pointed at.** `DORMOUSE_REMOTE_CONNECT_SRC`
is a build-time constant compiled into the Node bundle that holds the socket — the
Tauri sidecar and the VS Code extension host — enforced at two points: `enroll`,
*before the setup password leaves the machine*, and Burrow start-up from a persisted
enrollment naming an outside origin. Full semantics: `docs/specs/relay.md` -> "Where a
Burrow may reach a Relay (self-host builds)".

- **FAIL IF** `DEFAULT_REMOTE_CONNECT_SRC` is not exactly `https://*.dormouse.sh wss://*.dormouse.sh` in **both** `scripts/csp-defaults.mjs` and `lib/src/host/remote/connect-src.ts`, or if `CONNECT_SRC_SOURCE_PATTERN` differs between them. The shipped default admits the SaaS origin only, so widening it — a localhost entry, an `http`/`ws` scheme, a bare `*`, or the apex `dormouse.sh` — is a per-build opt-in that changes what every shipped binary will talk to.
- **FAIL IF** `assertConnectSrcBaked` is no longer called on the built bundle by both `standalone/scripts/build-sidecar-proxy.mjs` and `vscode-ext/scripts/esbuild.mjs` — including the **watch** branch of the VS Code script — or if `resolveRemoteConnectSrc` stops rejecting an override the runtime matcher cannot parse. The value is duplicated (a `.mjs` build script cannot import TypeScript) and `resolveRemoteConnectSrc` validates with the build script's *copy* of the grammar, so this bullet is only as strong as the previous one's identical-copies requirement; `lib/src/host/remote/connect-src.test.ts` pins them (rationale).
- **FAIL IF** `originAllowedByConnectSrc` stops gating both `enroll` and Burrow start-up in `lib/src/host/remote/service.ts`, or fails open on an unparseable origin or source.
- **FAIL IF** the enrollment exchange in `lib/src/remote/burrow/enrollment.ts` or the shared `burrowFetch` in `lib/src/remote/burrow/burrow-fetch.ts` — the transport behind both push delivery and the setup-token mint — drops `redirect: 'error'`. **Every new Burrow→Relay call goes through `burrowFetch`** (rationale).

### Credentials at rest

**Persistent credentials are a full bypass of some layer if they leak to another
local account.** Protection states the *property* — reachable only by
the owning user account — and every row reaches it the same way, the caption of the
column: mode `0700`/`0600` on unix, a one-ACE DACL on Windows, where Node's file modes
are a silent no-op. Rows carry only what is additional.

| Credential | Where it lives | Protection |
| --- | --- | --- |
| Setup password | `setup-password.json` in the Relay state dir | generated by the Relay on first boot; never accepted from configuration or printed by a routine install |
| Enrollment offer | `run/enroll-offer.json` in the install root, under an owner-only `run/` | mode and DACL both applied before the token is written; one-time (`docs/specs/relay.md` -> "Configuration"); never printed, the service definition and wrapper carrying only its path |
| `burrowToken` (the `/ws/burrow` bearer) and the Burrow's Noise static private key | Relay `burrows.json` (the token only); Burrow side both in the enrollment record, the Noise static minted locally and never sent to the Relay (`docs/specs/remote-security-model.md` -> "Burrow identity") | the Relay state dir and every file in it; on Windows the files inherit the installer's DACL on `state`, so `manage verify` checks them individually. Burrow side a `0600` file in standalone (on Windows the app-data-dir DACL the Rust side applies), `SecretStorage` (the OS keychain) in VS Code — never a webview realm |
| VAPID private key | Relay `vapid.json` | nothing additional |
| Burrow ACL | `BurrowStateStore`, keyed per `burrowId` | a `0600` file in standalone; VS Code `globalState`. Mostly public keys, with one exception: each record's `deliveryId` is a bearer capability for that Client's push rows, so a reader could delete or hijack a subscription — not reach a terminal. Neither store provides *integrity* against a same-user process and nothing here claims otherwise; the mode only stops another local **account** adding a record (rationale). Deliberately never on the Relay |

**Without explicit modes these files inherit the umask and end up world-readable**,
handing live burrow tokens to any other local account on a shared machine. The Client's
per-Burrow statics are the exception that needs no file protection: non-extractable
`CryptoKey`s in IndexedDB, never exported.

- **FAIL IF** `relay/src/state.ts` stops creating `$DORMOUSE_STATE_DIR` mode `0o700`, or stops writing every file through `writeAtomic` at mode `0o600`. The "every file" clause is a negative search over `relay/src/`: no `writeFile`, `appendFile`, or `createWriteStream` may target the state directory outside `writeAtomic`. A cheap default, not a cross-platform guarantee; the installer's directory permissions below protect the installed Relay's state (rationale).
- **FAIL IF** `FileBurrowStateStore` (`lib/src/host/remote/burrow-state-store.ts`) stops creating its directory `0o700` and writing `0o600` on non-Windows platforms, or if `VsCodeBurrowStateStore` stops keeping the **enrollment** in `SecretStorage`. The ACL's home in `globalState` is deliberate and is not a finding; the enrollment's is what carries `burrowToken`.
- **FAIL IF** a credential the Host→Burrow rename retired stops being deleted unread at boot: `remote-host.json` (`forgetRetiredState` in `lib/src/host/remote/burrow-state-store.ts`, called from `sidecar-entry.ts`), and `dormouse.remote-host.enrollment`, `dormouse.remote-host.acl.*`, `remote-host.peer-token` (`vscode-ext/src/retired-state.ts`, called from `activate()`). Each held a live `burrowToken` or peer secret, and `SecretStorage` cannot be enumerated — a key nothing removes *by name* outlives every build that knew it. Pinned by `lib/src/host/remote/burrow-state-store.test.ts` and `vscode-ext/test/retired-state.test.ts`.
- **FAIL IF** `burrow_state_dir` in `standalone/src-tauri/src/lib.rs` stops calling `restrict_to_owner` on the state directory **before** spawning the sidecar — on Windows those Node modes are no-ops and Node cannot set an ACL, so the guarantee is held one layer down. That call carries both legs: a newly written enrollment file *inherits* the owner-only entry, and one a prior version already left under the `%LOCALAPPDATA%` ACL — with a live `burrowToken` in it — has that entry *propagated* onto it, the half `restrict_to_owner_leaves_one_owner_only_ace` covers with its pre-existing `before.json`.
- **FAIL IF** `relay/src/index.ts` stops obtaining the setup password from `SetupPasswordStore.loadOrCreate(generateSetupPassword)`, `generateSetupPassword` stops using `crypto.randomBytes(32)`, `readConfig` reads `DORMOUSE_SETUP_PASSWORD` or any other setup-password input, or `SetupPasswordStore` stops refusing a persisted or generated value outside 64 lowercase hexadecimal characters. Pinned by `relay/test/config.test.mjs` and `relay/test/setup-password-store.test.mjs`.
- **FAIL IF** `createApp` accepts anything but 64 lowercase hexadecimal characters as the setup password injected by the entrypoint; pinned by `relay/test/app.test.mjs`.
- **FAIL IF** any installer stops making `config/`, `state/`, and `config/relay.env` reachable only by the installing user — the effective property `manage verify` tests: no principal other than that user may appear in the effective permissions. macOS and Linux achieve it with `0700`/`0600` under `umask 077`; Windows with a DACL protected from inheritance carrying exactly one ACE, which is how `Protect-Path` does it today but is not itself the invariant — a path that inherits that single ACE from an already-locked parent satisfies the property, and `Test-OwnerOnly` deliberately accepts it. The Windows and Linux installers create `relay.env` and lock it before writing its contents (rationale).
- **FAIL IF** `manage verify` stops asserting **both** legs of the unix property — mode **and** owner — on `config/`, `state/`, `run/`, `config/relay.env`, and, while it is there, the enrollment offer; a `0700` directory owned by another principal satisfies the mode and inverts the property. Linux does. **Two known gaps, in those installers rather than accepted limits:** macOS checks the modes only and not yet the owner, on every one of those paths, and Windows `Test-OwnerOnly` reads the DACL and never `$acl.Owner`, so a path another principal owns passes while that owner keeps implicit `WRITE_DAC` over it.
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

**No browser origin but the configured one may drive the API.** Pocket is served
with the API at that origin and calls it with relative URLs; a Burrow's HTTP client runs
in its Node service, not a webview. No supported caller is a cross-origin browser, so
a grant would widen the guessing surface and buy no compatibility (rationale).

- **FAIL IF** the Relay installs CORS middleware, emits `Access-Control-Allow-Origin`, or accepts authentication from a cookie — the two clauses hold each other up (rationale). Pinned by `relay/test/cors.test.mjs`.

### Network posture (self-hosted)

**`scripts/deploy-lint.mjs` (`pnpm test`) makes the cheap half of this section and of
"Credentials at rest" deterministic**: every installer must still contain the control
each `FAIL IF` names, so a control deleted from one of the three fails a build. It is
textual and cannot tell whether a control is *correct* — the audit owns that — and on
Windows, which nothing in CI can execute, it is the only automated signal at all.
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

**Must not make Funnel state an install or health verdict.** The installers configure
Serve but neither inspect, warn about, enable, nor disable Funnel; `manage verify`
checks the local TLS-to-loopback path, while CI and this audit check application
controls.

- **FAIL IF** `deploy/local/install-macos.sh`, `deploy/local/install-windows.ps1`, or `deploy/local/install-linux.sh` stops requiring `DORMOUSE_BIND_HOST=127.0.0.1` in `config/relay.env`, or if any `manage verify` stops asserting that the plaintext port is unreachable on the node's Tailscale IP.
- **FAIL IF** the unset default of `DORMOUSE_BIND_HOST` in `relay/src/config.ts` stops being `undefined` — listen on every interface, what a container wants, where the namespace is the boundary — or if `relay/test/bind-host.test.mjs` stops spawning the real entrypoint to prove the plaintext port is unreachable off-loopback when it *is* set.
- **FAIL IF** any installer stops refusing to rewrite a `DORMOUSE_ORIGIN` that no longer matches the node's DNS name.
- **FAIL IF** any installer stops refusing to run with elevated privileges — `id -u` on macOS and Linux, the `Administrator` role check on Windows (rationale).
- **FAIL IF** an installer or `manage` names `tailscale funnel` or `AllowFunnel` at all — invoking it, judging its state, or changing it all begin there, and public reachability must exercise the application controls rather than become a forbidden deployment state. Held by `scripts/deploy-lint.mjs` as its one `forbidden` rule (rationale).
- **FAIL IF** any decision taken on Tailscale CLI or listener output is reached by piping that output into `grep -q`, or into a `head -1` that exits first; every such search is over text captured first. The `head -1` half binds every site whose 141 can still reach an `if` or an assignment — an inline substitution always, and a helper the moment the failing assignment is its last command or a caller invokes it outside `$( )` (rationale).
- **FAIL IF** any decision about whether Serve maps `/` to us — the install-time conflict gate, `manage verify`, and the uninstall that turns Serve off — is not additionally scoped to the root line with the port right-bounded: `/api` on this port is not `/` on it, and `127.0.0.1:31000` contains `127.0.0.1:3100`. The post-mutation `SERVE_AFTER` assertion is the one deliberate exception, since it asserts our own `serve --bg` landed rather than auditing a foreign config (rationale).
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

- **FAIL IF** `relay/src/push-endpoint.ts` stops rejecting non-public push endpoints at registration, stops applying `createPublicLookup` / `createPublicPushAgent` to delivery, or stops rejecting a hostname whose DNS answers are mixed public and blocked.
- **FAIL IF** `/api/push/send` stops taking the `burrowId` from the Burrow's own token, begins selecting recipients when `recipients` is absent or empty, stops clamping them at `MAX_PUSH_QUERY_DELIVERY_IDS`, or if any read endpoint begins reporting on a delivery id the caller did not present. Possession of the 256-bit `deliveryId` is the whole authorization for the Client-facing push routes, so the Relay must never *list* one to a session.
- **FAIL IF** the send route reads, rewrites, or logs notification text, or forwards anything but the sealed envelope plus the token's own `burrowId`. The Relay holds no key for it (`docs/specs/remote-security-model.md` -> "Push sealing"), so a route that could read a payload is one that was handed plaintext. The envelope's three fields must be copied individually rather than spread, since a spread would let a sending Burrow override its own token's `burrowId`.
- **FAIL IF** a push stops being sealed per recipient, to that ACL record's own Client static, under a fresh salt — the construction is `docs/specs/remote-security-model.md` -> "Push sealing", `sealPush` / `openPush` in `remote-lib-common/src/security/push-seal.ts`, proven by `remote-lib-common/test/push-seal.test.mjs`. A Noise `CipherState`, a shared group key, or a reused salt each break it. `BurrowRuntime.sealPushForClient` hands `lib/src/remote/burrow/push-delivery.ts` a seal *capability* and never the Burrow's private key, and the worker in `lib/src/remote/pocket-app/sw.ts` is the only thing that opens one.
- **FAIL IF** push text stops being bounded with the shared `boundedPushText` on the Burrow before sealing, or re-bounded with it in `lib/src/remote/pocket-app/sw.ts` before `showNotification`. The worker is the sanitization sink: a worker that renders what it decrypted without re-bounding it leaves the property with one enforcer instead of two (rationale).
- **FAIL IF** the relay routes a Burrow-originated frame from a socket that is not the Client's current Burrow binding, or begins decoding, remembering, or acting on an `e2e` ciphertext. `relay/src/relay.ts` must route the `e2e` envelope and nothing else: it holds no gate, no challenge memory, and no notion of an authorized session (rationale). A Relay-side type import from the protocol-v1 half of `remote-lib-common/src/remote/wire.ts` is the leading indicator and fails the same way.

### Revocation and the audit trail

These are the two real gaps in the shipped model, and they are gaps rather than
accepted risks — we intend to close them (rationale).

**Revocation has no mechanism.** `BurrowAcl.revokeClient` / `revokePasskey` exist and
have no callers; no relay frame carries a revocation; there is no management UI.
Revoking a lost phone means hand-editing JSON on the Burrow **and restarting it**:
`BurrowService.#startBurrow` reads the store once and hands the `BurrowRuntime` a
snapshot for its whole lifetime, so an edit alone changes nothing that is running. The
restart is the whole lever — it reloads the ACL and, by dropping the relay socket, ends
every established session. Relay-pushed propagation is staged in
`docs/specs/remote-security-model.md` -> "Future" (Revocation propagation).

**There is no audit trail.** The ACL records `approvedAt` / `approvedBy` for a pairing,
and nothing records connects, attaches, denials, or writes. A self-hoster cannot answer
"did anyone connect to my laptop last night", which also means an ACL entry added by
any of the paths above would be invisible after the fact.

## Future

### Cloud-hosted mode

Nothing here is implemented; it exists so the boundary is stated before the code
arrives. When Dormouse operates the coordinating Relay, "Relay compromise buys no
Burrow access" is unchanged, but two things change character and must be re-analyzed here
rather than inherited:

- **We become the operator** of the relay. The end-to-end protocol keeps ceremony, terminal, remote-api, and notification content out of that operator's reach; what stays visible is exactly the metadata in `docs/specs/remote-security-model.md` -> "Residual metadata".
- **An independent cryptographic review is a precondition** of claiming this model for a paid service (`docs/specs/remote-security-model.md` -> "Security Guarantees").
- **The tailnet stops carrying load.** Every argument above that leans on "the origin is reachable only from the user's tailnet" has no cloud equivalent, and the multi-tenant account model replaces the single-owner setup password entirely (`docs/specs/relay.md` -> "Future", the **saas-multitenant** scope).
