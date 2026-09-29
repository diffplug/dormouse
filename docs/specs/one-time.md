# One-time connection

> See `docs/specs/glossary.md` for Burrow, Client, Relay, Pane, and Baseboard vocabulary; this spec uses them bare.
> Owns the one-time connection: the link a Burrow shows, the Hosted rendezvous that carries only its handshake, and the direct-only session that follows. Defers the ceremony's trust rules to `docs/specs/remote-security-model.md` -> "One-time connection" and the audited checks to `docs/specs/security-remote.md` -> "One-time connection".
> The shared contract and the Burrow runtime are built; the phone client, the service commands, the rendezvous, and both interfaces are the **one-time-connection** scope under `## Future`.

A phone reaches a laptop with no account, no Relay, and no passkey: the laptop
shows a link, the phone opens it, a person types on the laptop the two digits the
phone shows, and the session runs over a direct WebRTC path on the same network.
Hosted's rendezvous carries the handshake and nothing after it.

## Link

**One link per connection, one phone per link.** Exactly
`<origin>/connect/#<v>.<roomId>.<expiry>.<ephPub>`: the fragment is positional,
dot-delimited, carries no field names, is exactly 79 characters, and never
reaches a server.

| Field | Encoding, exact length | Purpose |
| --- | --- | --- |
| `v` | literal `1`, one character | E2E wire version; any other value is rejected, never negotiated |
| `roomId` | 16 bytes as 22-character unpadded base64url | the rendezvous room Hosted minted |
| `expiry` | unsigned 32-bit epoch seconds as exactly 10 decimal digits | the phone's fail-fast; the Burrow checks its own copy at the attempt |
| `ephPub` | 32-byte X25519 public key as 43-character unpadded base64url | the one-use Burrow Noise responder key for this link |

- **`ONE_TIME_LINK_MAX_LENGTH = 256`, enforced at mint before any encoder runs**,
  which bounds the origin at 167 characters.
- **One parser boundary, with pairing's discipline.**
  `parseOneTimeLinkUrl(text, appOrigin, now?)` answers the complete link or
  `null`, never a partial parse. The URL around the fragment is
  `parseLinkFragment`'s, under the rules
  `docs/specs/relay.md` -> "Setup tokens and the pairing QR" states, with the
  path exactly `ONE_TIME_PAGE_PATH` (`/connect/`) and the fragment right after
  `#`; then the field rules, the expiry, and the X25519 import last.
- **A link is live through its expiry second** (`oneTimeLinkExpired`), and the
  parser refuses on that same rule. A caller that must tell an expired link from
  a wrong one parses at `now = 0` and asks `oneTimeLinkExpired`.
- **The prologue binds every link field under its own kind**: `lengthPrefixedConcat`
  of `dormouse/e2e/v1`, `one-time`, `roomId`, then `v`, `expiry`, `ephPub` in link
  order, from one builder both ends call.

Source of truth: `formatOneTimeLinkUrl` / `parseOneTimeLinkUrl` /
`oneTimeLinkExpired` / `oneTimeLinkPrologue` in
`remote-lib-common/src/security/one-time-link.ts`, `e2eOneTimePrologue` in
`remote-lib-common/src/security/noise-transport.ts`. Pinned by
`remote-lib-common/test/one-time-link.test.mjs`.

## Wire contract

**A separate frame family, never an `E2eKind`**, so neither the Relay nor
`BurrowRuntime` has a reader for it. Two WebSocket routes on the one-time
origin: `ONE_TIME_WS_ROUTES.burrow` (`/api/one-time/burrow`) mints a room, and
`ONE_TIME_WS_ROUTES.client` (`/api/one-time/client?room=<roomId>`) joins one.
Each message is one JSON frame with exact keys, forwarded verbatim by the room:

| Frame | Direction | Shape |
| --- | --- | --- |
| `OneTimeRoomFrame` | room → Burrow, once, first | `{t: 'one-time-room', roomId, expiresAt}`, `expiresAt` epoch ms whose whole seconds fit a uint32 |
| `OneTimeClientFrame` | phone → Burrow | `{t: 'one-time', step: 'init' \| 'transport', ct}` |
| `OneTimeBurrowFrame` | Burrow → phone | `{t: 'one-time', step: 'response' \| 'transport', ct}` |

`ct` is one base64url Noise message, bounded as on the relay envelope.
`ONE_TIME_PING` / `ONE_TIME_PONG` are whole-string keepalives, never JSON.

- **Must measure a frame's raw text against `MAX_ONE_TIME_FRAME_LENGTH` before
  parsing it.** A room forwards at most `MAX_ONE_TIME_FORWARDED` (32) frames,
  both directions together.
- **Timings.** An unused link lives `ONE_TIME_LINK_TTL_MS` (the pairing TTL,
  5 minutes). A room's hard deadline is `expiresAt + ONE_TIME_EXPIRY_GRACE_MS`
  (30 s): join, confirmation, and the direct switch all finish inside it. The
  direct path has `ONE_TIME_DIRECT_DEADLINE_MS` (15 s) after the outcome.
- **The ceremony's messages are padded `control` messages** on the Noise session
  (`docs/specs/relay.md` -> "E2E framing"): `OneTimeRequestV1 {code, label}`
  phone → Burrow, then one `OneTimeOutcomeV1` — `{ok: true, burrowLabel}`, or
  `{ok: false, code}` with `code` one of `ONE_TIME_DENIAL_CODES`
  (`user-denied`, `confirmation-mismatch`, `link-expired`, `burrow-error`).

The room closes a socket with one of six codes, each exported with a `_REASON`:

| Code | Constant | Meaning |
| --- | --- | --- |
| 4010 | `WS_CLOSE_ONE_TIME_EXPIRED` | the link expired with no phone joined |
| 4011 | `WS_CLOSE_ONE_TIME_TAKEN` | a phone already joined |
| 4012 | `WS_CLOSE_ONE_TIME_UNAVAILABLE` | no such room, or it can no longer be joined |
| 4013 | `WS_CLOSE_ONE_TIME_PEER_GONE` | the other end's socket closed |
| 4014 | `WS_CLOSE_ONE_TIME_DEADLINE` | a phone joined, and the hard deadline passed |
| 4015 | `WS_CLOSE_ONE_TIME_VIOLATION` | a binary frame, one over the length bound, or one past the message cap |

Source of truth: `remote-lib-common/src/remote/one-time-wire.ts`;
`OneTimeRequestV1` / `OneTimeOutcomeV1` in
`remote-lib-common/src/security/e2e-ceremony.ts`. Pinned by
`remote-lib-common/test/one-time-wire.test.mjs` and
`remote-lib-common/test/e2e-ceremony.test.mjs`.

## Burrow runtime

**`OneTimeRuntime` is single-use: one rendezvous socket, one one-use keypair,
one phone, and at most one session.** It opens once and ends once, and nothing
resumes. The ceremony's trust rules — the reservation, the one attempt, direct
required — are `docs/specs/remote-security-model.md` -> "One-time connection";
this section is how the runtime carries them out.

| `OneTimeState` | Meaning |
| --- | --- |
| `opening` | minting the keypair, then waiting up to `ONE_TIME_OPEN_TIMEOUT_MS` (8 s) for the room frame |
| `waiting {url, expiresAt}` | the link is live; `expiresAt` is its last live millisecond |
| `confirming {label, expiresAt}` | a phone's request awaits the approval modal |
| `connecting {label}` | confirmed; the direct path has `ONE_TIME_DIRECT_DEADLINE_MS` |
| `connected {label, since}` | both directions are direct and the rendezvous is closed |
| `ended {reason}` | terminal |

`unavailable {reason}` and `idle` complete the type for the service, which
decides them; a runtime never enters either.

- **Must open the socket through the host's factory with no `Origin`
  header**, on the origin's Burrow route with `http` replaced by `ws`. While it
  is open the runtime sends `ONE_TIME_PING` every `ONE_TIME_PING_INTERVAL_MS`
  (30 s) and ignores `ONE_TIME_PONG` uncounted.
- **The first message must be one `OneTimeRoomFrame`**, else `unreachable`.
  The link's expiry is the earlier of the runtime's own `now +
  ONE_TIME_LINK_TTL_MS` and the room's `expiresAt`, floored to whole seconds.
- **Must measure every later message against `MAX_ONE_TIME_FRAME_LENGTH` before
  `JSON.parse`, then guard and count it**: past `MAX_ONE_TIME_FORWARDED` the
  runtime stops reading the room. Frames run through one FIFO, one at a time,
  and **the socket's close rides the same FIFO**, so a phone's `direct-switch`
  is read before the room's report that the phone left.
- **Must spend an `E2E_INIT_BURST` `TokenBucket` token before an `init`'s
  WebCrypto.** The first non-keepalive transport message must be
  `OneTimeRequestV1`, else `burrow-error`; its label passes
  `boundedPairingLabel` before the approval request carries it.
- **Promotion reuses the same Noise session** in an `EstablishedE2eSession`
  whose `hello.burrowId` is the room id, and arms the direct deadline. A
  decline the Burrow sends reaches the phone before the rendezvous closes.
- **Must close the rendezvous normally at the switch, and ignore its loss from
  then on.** Before the switch a close ends the connection by its code.
- **Never let a deadline run later than the room's**: each is on the runtime's
  own clock — an unclaimed link ends the first millisecond past its expiry, and
  a claimed one gets `ONE_TIME_EXPIRY_GRACE_MS` more, then is told
  `link-expired`.
- **`end()` releases everything**: the session and its peer connection, a
  pending approval, the key, queued work, every timer, and the socket. Nothing
  is written.

| `ended` reason | When |
| --- | --- |
| `user-ended` | `end()`: the laptop's End or Cancel, or service disposal |
| `user-denied`, `confirmation-mismatch` | the modal's Deny, or digits the phone was not showing |
| `expired` | a link past its expiry, claimed or not; a late request or confirmation; room close `4010` or `4014` |
| `phone-left` | room close `4013` before the switch; any session failure after it |
| `direct-failed` | a decline, an abandoned attempt, a session failure before the switch, or the direct deadline |
| `idle` | `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` without a decrypted phone message |
| `unreachable` | no room frame by the open deadline, a first message that is not one, or a socket lost before it |
| `rendezvous-lost` | any other close before the switch |
| `burrow-error` | room close `4015`, a protocol violation, an application message over the rendezvous, a room past the message cap, or a local failure |

Source of truth: `OneTimeRuntime` in
`lib/src/remote/burrow/one-time-runtime.ts`; `onRelayedApp` and
`onTransportChanged` in `lib/src/remote/burrow/established-session.ts`.
Pinned by `lib/src/remote/burrow/one-time-runtime.test.ts`, which drives a real
Noise initiator through the in-memory room `lib/src/remote/test-rendezvous.ts`.

## Future

**Scope: one-time-connection** — the feature on top of the contract, in build
order, each stage promoting its part above the fold:

1. **Phone client** — `OneTimeClient` on `ClientSessionCore`, proven end to
   end against the runtime through the in-memory room.
2. **Service commands and host glue** — `BurrowService` commands and event, the
   baked origin, the `serving` gate, approval `kind`, standalone and VS Code.
3. **Hosted rendezvous** — the routes, the `OneTimeRoom` Durable Object, its
   configuration and headers, a Miniflare suite in the root test.
4. **Phone page** — Pocket's shared views and wall mount moved out of its App,
   the `/connect/` entry, its build and staging, the dev loop.
5. **Laptop UI** — the Settings panel and the Baseboard indicator; the button
   enabled.

**Scope: one-time-anywhere** — reach past one network, for paid users: STUN and
TURN servers for those users alone (the Relay-supplied ICE servers of
`docs/specs/remote-api.md` -> "8. Direct path"), a budgeted relayed fallback
when no direct path forms, and a per-IP cap on concurrent rooms beside the mint
limit.

### Flow

1. The laptop's **One-time connection** button runs `oneTimeOpen`.
2. `OneTimeRuntime` mints a one-use X25519 keypair and opens the Burrow route;
   the room sends `OneTimeRoomFrame`, and the socket idles, hibernated, until a
   phone joins.
3. The laptop shows the link as a QR code and as copyable text.
4. The phone page takes and erases the fragment and **opens no socket until the
   person taps Connect**, so a link-preview crawler cannot spend the one join.
5. The phone joins the client route and runs IK with a fresh, never-persisted
   static against `ephPub`, reserving the link ([Burrow runtime](#burrow-runtime)).
6. The phone shows two digits and sends `OneTimeRequestV1`; the laptop's
   approval modal takes the one attempt.
7. A match promotes the session. The phone offers the direct path at once
   (`iceServers: []`) and shows "Connecting directly…".
8. **The phone sends no protocol-v1 until its path is direct.** When the laptop
   ends the connection `direct-failed`, the phone reads: "Couldn't reach your
   laptop directly. Make sure your phone is on the same Wi-Fi, then open a new
   link."
9. After the switch the phone closes its rendezvous socket normally too, and
   the room deletes itself.

### Service and hosts

- **`BurrowService` holds at most one runtime**, from its `oneTimeOrigin`
  option. `oneTimeOpen` takes no parameters — **the origin is never webview
  input** — is refused while connecting or connected, and replaces a waiting or
  ended one; `oneTimeEnd` and `oneTimeStatus` complete the set, with a
  `{name: 'one-time', state}` event. `status` gains
  `serving = enrolled || one-time active`. Works un-enrolled, survives
  `clearEnrollment`, and `dispose()` ends it. The label is the enrollment's, or
  `suggestedBurrowLabel(kind)`.
- **Approval carries a `kind`** (`pairing` | `one-time`) on `PendingPairing`,
  `PairingQueueItem`, `ApproveParams`, and `DenyParams`, the one-time request in
  a slot of its own and a missing `kind` read as `pairing`. The webview mirror
  keys by `(kind, clientId)`; the modal's one-time copy: "Allow a one-time
  connection … full control of every terminal here until it disconnects or you
  end it. Nothing is saved."
- **The origin is baked**: `DEFAULT_ONE_TIME_ORIGIN = 'https://hosted.dormouse.sh'`
  through `__DORMOUSE_ONE_TIME_ORIGIN__`, available only when HTTPS or loopback
  HTTP **and** admitted by the baked connect-src allowlist. The Burrow's socket
  sends no `Origin` header.
- **The webview gate arms on `serving`** for the peer-surface responder and the
  pairing-queue mirror; push refresh stays on `enrolled`.
- **Standalone** passes the baked origin from the sidecar entry. **VS Code**
  treats `oneTimeOpen` as contention-starting, answers `oneTimeStatus` and
  `oneTimeEnd` idly from a non-broker window, and while a one-time connection is
  active keeps a SecretStorage serving marker so sibling windows join the peer
  net and their terminals reach the phone.

### Phone

- **`OneTimeClient.connectOnce(link, label, onCode)` resolves only once the
  direct path carries both directions**, then closes the rendezvous socket. It
  imports no storage and no passkey code; close codes and direct failure map to
  fixed copy.
- **The page** (lib/src/remote/one-time-app/, built to Hosted's `/connect/`):
  invalid, expired, or unsupported → Connect → code → "Connecting directly…" →
  the wall with the laptop's label and End → ended. **It persists nothing**; its
  origin is shared with accounts.

### Hosted rendezvous

- **Routes mount after the bindings mapper and the 421 gate**, before the
  account API, and never touch Hyperdrive, cookies, or auth. The Burrow route
  requires an upgrade, answers **any `Origin` header with 403**, and limits
  mints per IP (per /64 for IPv6) with 429. The client route requires `Origin`
  to equal the app origin and `room` to be an E2E id, under a join limit.
- **`OneTimeRoom`**, a hibernating Durable Object: a synchronous single-join
  check-and-set; refusal by accept-then-close with a code; strings forwarded
  **verbatim, never parsed or logged**, counted toward the message cap;
  a violation closes both with 4015; either close sends the peer 4013 and
  deletes the room; one alarm at the hard deadline (4010 unjoined, 4014 joined);
  ping answered by auto-response.
- **`/connect/` gets its own CSP** — scripts from its own assets, `connect-src`
  the client route only, sandboxed — and the origin gains `worker-src 'none'`.
- **Deploy**: Durable Object migrations are append-only, and a desktop release
  enabling the button ships only after Hosted production serves this link
  version. `dev:one-time` runs the rendezvous on loopback as a `one-time` Dor
  Tool.

### Laptop UI

- **`OneTimeConnection` in Settings' Remote control choices, enrolled or not**:
  idle (hint "…open on your phone. Phone and computer must be on the same Wi-Fi.
  No account needed.") · unavailable (disabled, with the reason) · opening ·
  waiting (QR, link, Copy link, "Good for one phone. Expires in N min.", New
  link, Cancel; no auto-refresh) · confirming · connecting · connected ("<label>
  has full control of your terminals." and End) · ended (reason copy, the
  same-Wi-Fi hint for `direct-failed`, New link, Done). Closing Settings keeps
  it running.
- **`OneTimeIndicator` in the Baseboard's right cluster** reads "Phone connected
  · End" while connected.

### Security model remainder

Promoted into `docs/specs/remote-security-model.md` and the security specs as
the phone page and the rendezvous land: the Hosted page as a third trusted
endpoint, and what the rendezvous learns.
