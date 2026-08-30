# Server (selfhost) — Rationale

> Informative companion to [server.md](server.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative — every rule it explains is stated in the spec.

## Guardrails

**Why the pruning matters.** The frames that mint transient state are cheap for an attacker to produce: `POST /api/signin/begin` needs no auth at all, and a `connect` frame needs only a session — not a pairing — yet issues a challenge in the Host process on the user's laptop. Unpruned single-use/TTL stores would therefore grow from traffic nobody had to earn much authority to send — on the laptop as well as on the server.

## Configuration

**Loopback-lint scope.** `SECURITY.md` -> "Loopback Listeners" carries a guard-module rule, enforced by `scripts/loopback-lint.mjs`, that covers the app's browser-reachable local proxies — listeners that bind from a loopback literal in the source. The server's socket binds from `DORMOUSE_BIND_HOST` instead, so the textual lint cannot see it; the containment argument in the spec is what stands in for the lint here.

## Where a Host may reach a relay server (self-host builds)

**The two build-time guards.** Both exist because their failure mode is silent rather than loud.

- A lost esbuild `define` compiles fine. It would surface only as a Host quietly using the shipped `*.dormouse.sh` default instead of the selfhoster's origins — a build that looks correct and refuses the only server it was meant for. Hence `assertConnectSrcBaked` greps the emitted bundle for the value.
- An override outside the grammar (trailing slash, path, bare host, foreign scheme, out-of-range port) matches nothing at runtime, so without `resolveRemoteConnectSrc`'s check the build goes green and ships a binary that refuses the very server it was built for.

## State files

**What an unguarded row costs.** A `hosts.json` row with a null `hostToken` makes `findByToken`'s digest compare throw. Because that lookup runs on every relay upgrade and every push route, a single hand-edit typo — during the *documented* revocation procedure — turns into a 500 on `/ws/host` and on every push endpoint until the file is repaired. Dropping the malformed row instead degrades exactly one host's access.

**Where `0600` earns its place, and where it does not.** It matters on a multi-user unix host: home-directory permissions vary by distro, so without an explicit mode whether a second local account can read `hosts.json` depends on which distro the selfhoster happened to pick. It buys nothing where file modes are not the mechanism — Windows, a container, a database-backed deployment — which is why the spec refuses to let anything rest on it.

## WebAuthn without a WebAuthn library

**Two facts made the dependency unnecessary.** Browsers hand back a new credential's public key directly (`response.getPublicKey()` returns SPKI DER), so registration needs no CBOR decoder and no attestation parser. And `server-lib-common` already carried a full assertion verifier, written for the Host, that works against an SPKI key. Between them there was nothing left for a library to do — hence the section title, and hence the Server and Host sharing one verifier rather than each importing their own.

## Web Push

**Why the log carries the service's reason body.** A status alone does not separate a bad subject from a bad key from a bad payload, and the push service's own explanation is visible nowhere else — the route answers 200 either way and the Host only sees a `failed` count.

**The outer deadline protects the handler, not the socket.** `web-push` accepts no `AbortSignal`, so a request that loses the race keeps running under its own inactivity timeout. What the route-level deadline prevents is a wedged push service holding the handler open while successive alarms stack concurrent sends behind it.

**A loopback VAPID subject: measured, not guessed.** Apple answers `403 {"reason":"BadJwtToken"}` for one — verified against `web.push.apple.com` (2026-08) for both `mailto:admin@localhost` and `https://localhost:3000`, while `mailto:admin@example.com` and an ordinary https origin were accepted. So the rule is loopback specifically, not reachability of the contact. `web-push` only warns about the https form, at send time, and says nothing at all about `mailto:` at `localhost`. This mattered in practice: the previous default (`mailto:admin@localhost`) let a Server boot clean, answer 200 on send, and deliver nothing to any iPhone — the one platform the feature targets.

## Pairing (phone ↔ laptop, first time)

**Why the Host cannot lean on the server's shape guard.** A Host that trusted `isPairingRequest` on the relay's side would be taking a relayed object on faith in the one place where that is least acceptable: the approval UI a human reads, and the ACL record that approval writes.

## Host side (`lib` + the two Node hosts)

**Where a bad enrollment record would surface.** A record minted with an `undefined` in its `ConnectionPolicy` would not fail at enrollment time. It would fail at the *next* read — the store rejects it, so the machine silently un-enrolls at the next launch, an app-restart away from the response that caused it. Failing the exchange on the spot names the missing fields instead.

**Why the enrollment request's 10 s timeout has to be the shorter one.** It runs on the service's lifecycle chain, where every later start/stop command queues behind it, so an enrollment left to hang past the webview's own 15 s command budget would replace the real error with a timeout — and stall every command queued after it.

**What losing the `hostToken` costs.** The alternative ordering — stop the running Host, then save — strands the machine with no Host, a status that says otherwise, and a credential that cannot be re-minted from the same password exchange. The user's only recovery is a fresh enrollment against the server.

## Remote control, in the Settings dialog

**Why the connection is polled.** Without the 2 s poll, a machine that finished connecting a moment after the dialog opened would read as permanently "Connecting…" — the Host service emits no event for connection changes, only for `{ enrolled }`.

**Why the poll's answer is compared field-wise.** The service returns a fresh object on every poll, so an identity comparison publishes a change every 2 s and the section re-renders twice a minute to paint identical text.

**Why losing the last subscriber drops the read in flight.** A reopened dialog answered with a status fetched for the closed one would sit on "Checking…" until that stale read settled.
