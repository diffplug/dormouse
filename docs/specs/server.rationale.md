# Server (selfhost) — Rationale

> Informative companion to [server.md](server.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative — every rule it explains is stated in the spec.

## Guardrails

**Why the pruning matters.** Transient state is cheap to mint: `POST /api/signin/begin` needs no auth, and a `connect` frame needs only a session — not a pairing — yet issues a challenge in the Host process on the user's laptop. Unpruned, single-use/TTL stores grow from traffic nobody had to earn authority to send, on laptop as on server.

**Why the presence-nonce cap is per session.** A presence nonce is minted *before* its WebAuthn prompt, so it waits out human latency; under a global cap, any other session's flood evicted it mid-prompt and failed every pairing and connection ceremony for as long as the flood ran.

## Configuration

**Loopback-lint scope.** The lint covers browser-reachable proxies whose loopback literal appears in source; the Server binds from `DORMOUSE_BIND_HOST`, never a literal, so the spec's containment argument covers what text matching cannot.

**Why `hosts.json` existence closes bootstrap.** Its first atomic write commits the first enrollment. Row count would reopen bootstrap after documented revocation removes the last row; a separate marker would duplicate the transition.

**Why a relative path is a `ConfigError`.** `DORMOUSE_RUNTIME_FILE` and `DORMOUSE_ENROLL_TOKEN_FILE` come from the installer's `run-server` wrapper, which a service manager launches with a working directory that is not the installer's — a relative value lands where neither side can predict. The same drift is why `DORMOUSE_POCKET_DIR` resolves from the compiled server's own location: a service manager could otherwise change what is served.

**Why the runtime file sits outside the state dir.** It is runtime truth about one process — pid, port, release — not durable state a backup should capture and a restore replay.

**Why a blank `PORT` is not zero.** `Number('')` is 0, which asks the OS for an ephemeral port and moves the server out from under whatever proxy is pointed at it — the same reason an explicit `PORT=0` is refused.

**Why only the exact string `true` turns user verification on.** Enabling it without UV-capable authenticators locks the account out of its own server: the cost of reading a misspelling as on.

**Why the origin is normalized rather than compared as typed.** A trailing slash reads as correct in an `.env` file and then fails every compare it reaches, unless every compare site re-parses it first.

## Where a Host may reach a relay server (self-host builds)

**The two build-time guards.** A lost esbuild `define` compiles fine, surfacing only as a Host quietly using the shipped `*.dormouse.sh` default instead of the selfhoster's origins — a build that looks correct and refuses the only server it was meant for, so `assertConnectSrcBaked` greps the emitted bundle for the value. An override outside the grammar (trailing slash, path, bare host, foreign scheme, out-of-range port) matches nothing at runtime, so without `resolveRemoteConnectSrc`'s check the build goes green and ships the same silent refusal.

## State files

**What an unguarded row costs.** A `hosts.json` row with a null `hostToken` makes `findByToken`'s digest compare throw, and that lookup runs on every relay upgrade and every push route — so one typo during the *documented* hand-edit revocation becomes a 500 on `/ws/host` and on every push endpoint until the file is repaired; dropping the row degrades exactly one host's access instead.

**Where `0600` earns its place, and where it does not.** It matters on a multi-user unix host: home-directory permissions vary by distro, so without an explicit mode whether a second local account can read `hosts.json` depends on which distro the selfhoster picked. It buys nothing where file modes are not the mechanism — Windows, a container, a database-backed deployment.

**Why `hostId` has one pinned shape.** Every `e2e` envelope routes on it and the QR fragment carries it at a fixed width: another shape is a Host the relay admits, no Client can address, and whose codes no phone can parse — un-enrolled is what the person hand-editing the file was reaching for.

**Why a fresh `deliveryId` cannot close the endpoint gap.** Linking a new delivery id to its scope's previous address would take cross-Host device identity on the Server, which the model does not have; until the push service 404/410s them, the stale rows are the price.

**Why the subscription store gets per-field bounds and row caps.** A `deliveryId` is the caller's own choice and no Server can check one against a Host's ACL, and every push route re-parses the whole file, so unchecked growth is paid on every request. An evicted Client reads as un-registered and repairs by pressing Enable, the recovery a dropped row already has.

## WebAuthn without a WebAuthn library

**Two facts made the dependency unnecessary.** The browser hands the new credential's public key back as SPKI DER, and `server-lib-common` already carried a full assertion verifier — written for the Host — that works against an SPKI key. Nothing was left for a library to do.

**Why the challenge issuers are capped as well as swept.** The mint is unauthenticated (Guardrails), so expiry alone lets the map plateau at request-rate × TTL rather than at a bound the process chose. A flood evicts abandoned challenges of its own making, the ceremony that loses one retries, and single use is untouched.

## HTTP API

**Why the body bound runs before the credential gate.** The routes carrying their credential in the body read it first, so an unbounded reader lets any page on the tailnet make the process buffer whatever it likes — no auth, no rate limit, no delay.

**What three route answers are protecting.** `POST /api/setup/retire` exists so a QR a phone scanned but will not register with cannot stay redeemable in a photograph. `/api/host/enroll` checks its `MAX_ENROLLED_HOSTS` cap after the credential so a caller that proved nothing cannot learn the server is full. `/api/push/subscribe` 404s an unknown `hostId` so no subscription row strands where no Host can read or prune it.

**Why a rejected host token pays the failure delay and a session token does not.** `requireHost` and the `/ws/host` upgrade both run unauthenticated over the most expensive lookup here — a read, a parse, and two SHA-256 per row — so answering instantly made probing cheaper for the caller than for the server. A session token is an in-memory `Map` lookup costing nothing; a delay there would only buy an attacker held connections.

## Setup tokens and the pairing QR

**Why the enroll credential is counted by presence, not tried in turn.** Trying the password and then the enroll token — or the reverse — would let a spent token fall through to the other credential, turning a one-shot offer into a second guess at the password.

**Why the localhost exception is a list, not a rule.** Each of `localhost`, `127.0.0.1` and `[::1]` is a secure context by the platform's own rule, but that rule is broader than these three; admitting exactly them parses the documented `http://localhost:3000` dev loop with nothing wider along for the ride.

## Web Push

**Why the log carries the service's reason body.** A status alone does not separate a bad subject from a bad key from a bad payload, and the service's own explanation is visible nowhere else — the route answers 200 either way and the Host sees only a `failed` count.

**The outer deadline protects the handler, not the socket.** `web-push` accepts no `AbortSignal`: a request that loses the race keeps running under its own inactivity timeout. The route-level deadline stops a wedged push service from holding the handler open while successive alarms stack sends behind it, and catches what socket inactivity cannot — trickled bytes or a stall mid-handshake reset that timer forever. Every send in a fan-out starts at once, so one wall-clock bound covers the route at any device count.

**Why a stale-VAPID row is hidden rather than reported.** Such an endpoint cannot receive a send signed by the current key, so listing it would let the Host name and retry an unreachable device; omitting it surfaces Pocket's re-registration action instead.

**A loopback VAPID subject: measured, not guessed.** Apple answers `403 {"reason":"BadJwtToken"}` — verified against `web.push.apple.com` (2026-08) for `mailto:admin@localhost` and `https://localhost:3000`, while `mailto:admin@example.com` and an ordinary https origin were accepted; the rule is loopback specifically, not reachability of the contact. `web-push` warns only about the https form, at send time, and nothing at all about `mailto:` at `localhost`. The previous default, `mailto:admin@localhost`, let a Server boot clean, answer 200 on send, and deliver to no iPhone — the one platform the feature targets.

## Relay

**Why the Host cannot lean on the server's shape guard.** Trusting the relay's own `isE2eClientFrame` would take a relay-supplied object on faith where that is least acceptable: the routing values it uses as map keys, and the ciphertext it is about to spend WebCrypto on. The relay's copy keeps a bad frame off the wire; the Host's exists because the model does not trust the relay.

## E2E framing

**Why reassembled bodies compact into one buffer.** A peer may legally split one application message into single-byte bodies, so a queue of bodies is bounded in bytes but unbounded in entries, and concatenating each body onto the accumulated bytes as it arrives would be quadratic. A geometrically-grown buffer is neither.

## Host side (`lib` + the two Node hosts)

**Why two rapid ACL writes are serialized.** Two pairing approvals in quick succession each write a whole ACL snapshot, the second larger; out of order, the older lands last and erases the device the newer one had just added.

**Why `WS_CLOSE_HOST_REPLACED` is terminal rather than retried.** Reconnecting on it would evict the newer Host, which would reconnect and evict this one, forever; an explicit `reconnect()` breaks the loop.

**Where a bad enrollment record would surface.** A record minted with an `undefined` in its `ConnectionPolicy` fails at no point during enrollment; it fails at the *next* read, where the store rejects it, so the machine silently un-enrolls at the next launch — an app-restart away from the response that caused it. Failing the exchange on the spot names the missing fields instead.

**Why the enrollment request's 10 s timeout is the shorter one.** It runs on the service's lifecycle chain, where every later start/stop command queues behind it, so an enrollment hanging past the webview's own 15 s command budget would replace the real error with a timeout and stall every command queued after it.

**What losing the `hostToken` costs.** The alternative ordering — stop the running Host, then save — strands the machine with no Host, a status that says otherwise, and a credential that cannot be re-minted from the same password exchange; the only recovery is a fresh enrollment against the server.

## Remote control, in the Settings dialog

**What the offer read is bounded to.** The un-enrolled state, not the dialog: the 2 s poll is the loudest reader, but the enrolled-gate seeds itself from `status` too, so an un-enrolled machine pays roughly two ENOENT opens per webview activation on top of it. An enrolled machine, left running for days, pays nothing.

**Why the connection is polled, and its answer compared field-wise.** Without the 2 s poll, a machine that finished connecting a moment after the dialog opened would read as permanently "Connecting…"; and since the service returns a fresh object every poll, an identity comparison publishes a change every 2 s, re-rendering the section twice a minute to paint identical text.

**Why losing the last subscriber drops the read in flight.** A reopened dialog answered with a status fetched for the closed one would sit on "Checking…" until that stale read settled. The same holds for `enroll`, `reconnect` and `clearEnrollment`: an answer fetched before the command is no longer the question anyone asked.

**Why the QR panel names the decision that ended a code.** Every outcome — approval, denial, mismatch — spends the invitation and dismisses the modal, so with one attempt and no retry a mismatch would look exactly like a success, the paired-device count being absolute rather than a delta.
