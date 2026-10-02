# One-time connection

> See `docs/specs/glossary.md` for Burrow, Client, Relay, Pane, and Baseboard vocabulary.
> Owns one-time links, Hosted rendezvous, and direct-only sessions. Trust rules: `docs/specs/remote-security-model.md` -> "One-time connection"; audited checks: `docs/specs/security-remote.md` -> "One-time connection" and `docs/specs/security-hosted.md` -> "Rendezvous boundary".

## Flow

1. The laptop's **One-time connection** button runs `oneTimeOpen`
   ([Service and hosts](#service-and-hosts)).
2. `OneTimeRuntime` mints a one-use X25519 keypair and opens the Burrow route;
   the room answers with `OneTimeRoomFrame` and idles, hibernated, until a
   phone joins ([Hosted rendezvous](#hosted-rendezvous)).
3. The laptop shows the [link](#link) as a QR code and as text
   ([Laptop UI](#laptop-ui)).
4. The phone page takes and erases the fragment, then waits for the Connect
   tap ([Phone page](#phone-page)).
5. The tap runs `connectOnce` ([Phone client](#phone-client)), which completes the
   handshake ([Burrow runtime](#burrow-runtime)).
6. The page shows the two digits; the laptop's approval modal takes the one
   attempt.
7. A match promotes the session, which waits until both directions have
   switched to the direct path.
8. Both ends leave the room, which deletes itself; the direct channel carries
   the session from then on and decides when it ends.

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
  `parseOneTimeLinkUrl` answers the complete link or `null`, never a partial
  parse: the URL around the fragment under `docs/specs/relay.md` -> "Setup
  tokens and the pairing QR", the path exactly `ONE_TIME_PAGE_PATH`
  (`/connect/`), then the field rules, the expiry, and the X25519 import last.
- **Must keep a link live through `expiry * 1000`, expiring the following millisecond** (`oneTimeLinkExpired`), and the
  parser refuses on that same rule.
- The prologue contract: `docs/specs/remote-security-model.md` -> "One-time connection".

Which desktop release may carry a link version: `docs/specs/deploy.md` ->
"Release checklist".

Source of truth: `remote-lib-common/src/security/one-time-link.ts`.

## Wire contract

**A separate frame family, never an `E2eKind`**, so neither the Relay nor
`BurrowRuntime` has a reader for it. Two WebSocket routes on the one-time
origin: `ONE_TIME_WS_ROUTES.burrow` (`/api/one-time/burrow`) mints a room, and
`ONE_TIME_WS_ROUTES.client` (`/api/one-time/client?room=<roomId>`) joins one.
**Must send each message as one JSON frame with exact keys**, forwarded verbatim by the room:

| Frame | Direction | Shape |
| --- | --- | --- |
| `OneTimeRoomFrame` | room → Burrow, once, first | `{t: 'one-time-room', roomId, expiresAt}`, `expiresAt` epoch ms whose whole seconds fit a uint32 |
| `OneTimeClientFrame` | phone → Burrow | `{t: 'one-time', step: 'init' \| 'transport', ct}` |
| `OneTimeBurrowFrame` | Burrow → phone | `{t: 'one-time', step: 'response' \| 'transport', ct}` |

`ct` is one base64url Noise message, bounded as on the relay envelope. Each
end keeps its open socket alive with the relay socket's `RELAY_PING`
heartbeat (`docs/specs/relay.md` -> "Routing"), whole strings never JSON,
holding the room to no deadline.

- **Must measure a frame's raw text against `MAX_ONE_TIME_FRAME_LENGTH` before
  parsing it**; both ends read the room through `parseOneTimeFrame`. A room
  forwards at most `MAX_ONE_TIME_FORWARDED` (32) frames, both directions
  together.
- **Timings.** An unused link lives `ONE_TIME_LINK_TTL_MS` (the pairing TTL,
  5 minutes). The join and the confirmation finish by its expiry, and the
  direct path's `DIRECT_ONLY_DEADLINE_MS` (30 s) after the outcome ends
  inside the room's hard deadline, `expiresAt + ONE_TIME_EXPIRY_GRACE_MS` (45 s).
- **The ceremony's messages are padded `control` messages** on the Noise session
  (`docs/specs/relay.md` -> "E2E framing"): `OneTimeRequestV1 {code, label}`
  phone → Burrow, the page sending a `label` from `ONE_TIME_DEVICE_LABELS`, then one
  `OneTimeOutcomeV1` — `{ok: true, burrowLabel}`, or
  `{ok: false, code}` with `code` one of `ONE_TIME_DENIAL_CODES`
  (`user-denied`, `confirmation-mismatch`, `link-expired`, `burrow-error`).

The room closes a socket with one of six codes:

| Code | Constant | Meaning |
| --- | --- | --- |
| 4010 | `WS_CLOSE_ONE_TIME_EXPIRED` | the link expired with no phone joined |
| 4011 | `WS_CLOSE_ONE_TIME_TAKEN` | a phone already joined |
| 4012 | `WS_CLOSE_ONE_TIME_UNAVAILABLE` | no such room, or it can no longer be joined |
| 4013 | `WS_CLOSE_ONE_TIME_PEER_GONE` | the other end's socket closed |
| 4014 | `WS_CLOSE_ONE_TIME_DEADLINE` | a phone joined, and the hard deadline passed |
| 4015 | `WS_CLOSE_ONE_TIME_VIOLATION` | a binary frame, one over the length bound, or one past the message cap |

A laptop ends on a close code it does not know as `rendezvous-lost`, and the
phone reads one as generic copy for its phase; an outcome whose guard refuses
it, a denial code the phone does not know included, reads as `burrow-error`.
So either deploy may add a code first.

Source of truth: `remote-lib-common/src/remote/one-time-wire.ts`;
`parseOneTimeFrame` in `lib/src/remote/one-time-rendezvous.ts`;
`OneTimeRequestV1` / `OneTimeOutcomeV1` in
`remote-lib-common/src/security/e2e-ceremony.ts`.

## Burrow runtime

**`OneTimeRuntime` is single-use: one rendezvous socket, one one-use keypair,
one phone, one guess, and at most one session.** It opens once and ends once,
and nothing resumes. Its states are `OneTimeState`, its endings
`OneTimeEndReason`; `unavailable` and `idle` are the service's, which a runtime
never enters, and `ended`'s `refusal` is `network-not-allowed`'s alone.

- **Must open the socket through the host's factory with no `Origin`
  header**, on the origin's Burrow route with `http` replaced by `ws`.
- **The first message must be one `OneTimeRoomFrame`, the keypair minted and
  the frame read within `ONE_TIME_OPEN_TIMEOUT_MS`**, else `unreachable`.
  The link's expiry is the earlier of the runtime's own `now +
  ONE_TIME_LINK_TTL_MS` and the room's `expiresAt`, floored to whole seconds.
- **Must guard and count every later message** after the
  [length check](#wire-contract): past `MAX_ONE_TIME_FORWARDED` the runtime
  stops reading the room.
- **Must reserve the link and erase its key only after message 1, message 2, and
  Noise Split succeed; a failed handshake leaves it live.**
- **Must spend an `E2E_INIT_BURST` `TokenBucket` token before an `init`'s
  WebCrypto.** The first non-keepalive transport message must be
  `OneTimeRequestV1`, else `burrow-error`. **Its label passes
  `knownOneTimeDeviceLabel` before the approval request or any state carries
  it**, so anything not exactly a member of `ONE_TIME_DEVICE_LABELS` is
  `Phone browser` (the rule: `docs/specs/remote-security-model.md` ->
  "One-time connection").
- **Promotion reuses the same Noise session** in an `EstablishedE2eSession`
  whose `hello.burrowId` is the room id, and arms the direct deadline. A
  decline the Burrow sends reaches the phone before the rendezvous closes.
- At the switch it closes the rendezvous normally (the lifecycle carve-out:
  `docs/specs/remote-security-model.md` -> "One-time connection"); before the
  switch a room close ends the connection by its code.
- **Never let a deadline run later than the room's**: each is on the runtime's
  own clock. A link not yet promoted ends the first millisecond past its
  expiry — a claimed one telling its phone `link-expired`, which dismisses the
  modal — and the request and the approval each check the expiry again.
- **`end()` releases everything and writes nothing.** **A `user-ended`, `idle`, or `network-not-allowed` ending sends the goodbye first, before
  the room closes** (`docs/specs/remote-api.md` → Transport), so a phone still
  connecting hears it over the rendezvous.

Source of truth: `OneTimeRuntime` in
`lib/src/remote/burrow/one-time-runtime.ts`; `directOnly`,
`onDirectOnlyBroken`, and `directDeadlineAt` in
`lib/src/remote/burrow/established-session.ts`.

## Phone client

**`OneTimeClient` is single-use: one `connectOnce`, one rendezvous socket, and
at most one session**, on `ClientSessionCore`, direct or not at all.
`connectOnce`:

1. Mints a static with `generateNoiseKeyPair`, writes message 1, then joins the
   link's room on the client route and completes IK; both payloads are empty.
2. Hands the two digits to `onCode`, sends `OneTimeRequestV1 {code, label}`,
   and reads one outcome.
3. On `ok`, establishes the session and offers the direct path, which has
   `DIRECT_ONLY_DEADLINE_MS` to carry both directions; a decline, an abandoned
   attempt, or the deadline fails the attempt.
4. At the switch, closes the rendezvous normally and resolves
   `{ok: true, burrowLabel}`.

- **Never open a socket outside `connectOnce`**, which runs once per client
  and opens none for an expired link.
- **Must end steps 1–2 at the room's hard deadline**, WebCrypto and the
  socket's open included; step 3 runs on the direct deadline instead.
- **Never import store, passkey, push, or worker code** (the static's rule:
  `docs/specs/remote-security-model.md` -> "One-time connection").
- Every protocol-v1 method refuses until both directions are direct (Direct
  required: `docs/specs/remote-security-model.md` -> "One-time connection").
- **Must drop what `isOneTimeBurrowFrame` refuses**, after the
  [length check](#wire-contract).
- **An outcome already read outranks the room's close behind it.**
- After the switch (the same carve-out), channel loss, the laptop's goodbye, or
  the idle deadline reaches `setOnEnded` once; `close()` reports nothing.
- **Every failure resolves `{ok: false, message}` with fixed copy**, never
  text from the room or the Burrow but the goodbye's address, which
  `networkNotAllowedMessage` fills in (`docs/specs/remote-network.md` -> "Local networks").

Source of truth: `OneTimeClient` in `lib/src/remote/client/one-time-client.ts`.

## Hosted rendezvous

The relay Worker (`https://relay.dormouse.sh`; `docs/specs/hosted.md` ->
"Application boundary") serves both routes, and one `OneTimeRoom` Durable
Object per room carries the frames. **Never parse, store, or log a forwarded frame**: the
room bounds a frame by its raw length and its count alone, and forwards the
string verbatim (rationale).

| Route | Admits | Refuses |
| --- | --- | --- |
| `ONE_TIME_WS_ROUTES.burrow` | an upgrade with no `Origin` header | 426 without an upgrade, 403 on any `Origin`, 429 past `ONE_TIME_MINT_LIMIT` |
| `ONE_TIME_WS_ROUTES.client` | an upgrade whose `Origin` is exactly `APP_ORIGIN`, naming exactly one E2E id as `room` | 426 without an upgrade, 403 on any other or no `Origin`, 400 on a missing, repeated, or malformed room, 429 past `ONE_TIME_JOIN_LIMIT` |

- **Must mount after the bindings mapper and the 421 gate**, and never read a
  cookie, reach Hyperdrive, or call auth. The Worker
  mints each room id from 16 random bytes and hands the room a fresh request
  carrying only the upgrade and the room id, never the caller's headers.
- **The `Origin` rules are abuse control, never authorization** (rationale).
- **Both limits key on `cf-connecting-ip`**: an IPv6 address by its /64, an
  IPv4-mapped one (`::ffff:0:0/96`, however spelled) by its IPv4, and a missing
  one as `local` (rationale); `hosted/wrangler.relay.jsonc` sets them.
- **The room's state is the Burrow socket's hibernation attachment** —
  `expiresAt`, `joined`, and a count of every frame received — never memory, so
  a hibernated room keeps its join and its count. `RELAY_PING` is answered by
  the runtime's auto-response and never wakes, forwards, or counts.

A room's life, each step one event on the object:

1. **Open.** The Burrow's upgrade arms one alarm at `expiresAt +
   ONE_TIME_EXPIRY_GRACE_MS`, with `expiresAt` `ONE_TIME_LINK_TTL_MS` from now,
   accepts the socket tagged `burrow`, and sends `OneTimeRoomFrame`.
2. **Join, decided synchronously**, check and set with no await between: no
   open Burrow socket answers 4012, a joined room 4011, a join past `expiresAt`
   4010; otherwise the socket is accepted tagged `client`. **A refusal accepts
   outside hibernation and closes at once**, so its close never reaches the
   room's handlers (rationale).
3. **Forward.** Every text frame counts (rationale), and goes verbatim to the
   other end's open socket, or nowhere before a phone joins. A binary frame, one longer than
   `MAX_ONE_TIME_FRAME_LENGTH`, or one past `MAX_ONE_TIME_FORWARDED` closes both
   ends with 4015.
4. **Leave.** Either end closing or erroring closes the room's sockets with
   4013, the leaving end's included as its reply.
5. **Deadline.** The alarm closes what remains with 4010 if no phone joined,
   4014 if one did.

**Every ending deletes the alarm and the room's storage**, so a finished room
holds nothing.

Source of truth: `oneTimeRoutes` in `hosted/server/one-time.ts`; `OneTimeRoom`
in `hosted/server/one-time-room.ts`.

## Phone page

The relay Worker serves the phone's half at `ONE_TIME_PAGE_PATH` (`/connect/`):
`OneTimeApp` on Pocket's screens, chrome, and mobile wall, refusing a browser
without X25519 or `RTCPeerConnection`.

- **Must take the fragment and erase it with `history.replaceState` before the
  first render**, parsed or not, and reload on `hashchange` (rationale).
- **Never open a socket before the Connect tap**: the tap builds the client and
  runs `connectOnce`, so a link-preview crawler spends nothing.
- Its ICE servers: `docs/specs/remote-network.md` -> "Anywhere".
- **Never persist anything** from the page: no storage, IndexedDB, worker,
  push, or cookie, though Pocket keeps its own on the same origin. `applyPocketTheme` applies Pocket's
  default theme without reading or writing a stored pick, for the page and its
  `PocketWall`. `scripts/e2e-lint.mjs` holds the page to the client's store rule.
- **Must mount the wall only on `ok`**, through `mountRemoteWall`. End, Cancel, a
  reported ending, a failed mount, or a failed attachment closes the client and
  releases the adapter; the first ending's copy stays.
- **The label the page sends is `oneTimeDeviceLabel`, never Pocket's
  `deviceLabel`**, and always a member of `ONE_TIME_DEVICE_LABELS`: `iPhone`;
  `iPad`, a `MacIntel` platform with more than one touch point included;
  `Android phone` from the platform, or from the user agent where there is no
  `userAgentData`; else `Phone browser` (rationale).

**Build.** `build:one-time` in `lib/package.json` builds `lib/one-time/` into
`lib/dist-one-time` under base `ONE_TIME_PAGE_PATH`, then runs
`assertPocketShell --one-time`: scripts under `/connect/assets/`, links under
`/connect/`, nothing inline. Hosted's `build` runs it first, and `stageRelay`
empties the relay's assets directory, copies the page to
`hosted/dist/relay/connect/` beside Pocket at the root, and checks the copy.

**Serving.** The relay Worker answers `/connect`, `/connect/`, and
`/connect/assets/*` from its assets, with no SPA fallback; an HTML answer
under `/connect/assets/` and any other path under `/connect/` is a 404.
Everything under `/connect` carries `oneTimePagePolicy`
(`hosted/server/headers.ts`), built from the relay's `APP_ORIGIN`. Every other relay response carries Pocket's policy or
`RUNS_NOTHING_POLICY` (`docs/specs/security-hosted.md` -> "Relay boundary").

- **An `APP_ORIGIN` that is not exactly `scheme://host[:port]` of plain host
  characters gets `RUNS_NOTHING_POLICY` instead**: the URL parser admits `;`,
  `,`, and `'` in a host.
- **The sandbox keeps `allow-same-origin`**, and Chrome's warning about the pair
  stands (rationale).

Source of truth: `OneTimeApp` in `lib/src/remote/one-time-app/OneTimeApp.tsx`;
`stageRelay` in `hosted/scripts/stage-relay.mjs`; `oneTimePageRoutes` in
`hosted/server/one-time.ts`; `relayRules` in `hosted/server/headers.ts`.
`oneTimeSmoke` in `hosted/scripts/one-time-smoke.mjs` checks a deployment's
page and script.

## Dev loop

**`dor tool one-time` (root `pnpm dev:one-time`) runs the rendezvous and page
on loopback, without Postgres**: the relay Worker under `wrangler dev --local`
on `127.0.0.1`, at `PORT` or a fixed default, since a Burrow build bakes the
origin in. Its config sets `APP_ORIGIN` to `http://localhost:<port>`, keeps
the relay config's Durable Object, migration, and rate limits, and carries no
route or production secret. It prints the dev Burrow build variables
(`DORMOUSE_RELAY_ORIGIN`, `DORMOUSE_RELAY_IS_HOSTED=1`; `docs/specs/relay.md`
-> "Relay origin").

Source of truth: `hosted/scripts/dev-one-time.mjs`.

## Service and hosts

**`BurrowService` holds at most one `OneTimeRuntime`, independent of the
enrollment**: it works un-enrolled, survives `clearEnrollment` and
`reconnect`, and `dispose()` ends it. Its label is the enrollment's, else
`suggestedBurrowLabel(kind)`; its provider and direct-peer factory are the
enrolled runtime's, under the level's path rules (`docs/specs/remote-network.md`
-> "Local networks" and "Anywhere").

| Command | Answers |
| --- | --- |
| `oneTimeOpen` | the state the open settled at, `waiting` or `ended` |
| `oneTimeEnd` | `{}`: a live connection ends `user-ended`; an `ended` one returns to `idle` |
| `oneTimeStatus` | the current `OneTimeState` |

- **`oneTimeOpen` takes no parameters: the origin is never webview input.**
  It joins an open in flight, replaces a waiting, confirming, or ended
  connection (ending it unannounced), and is **refused while `connecting` or
  `connected`**, and while `unavailable`.
- **Every state change is a `{ name: 'one-time', state }` event, and so is a
  service's start**, after its policy read, ahead of its enrollment read
  (rationale).
- **`status` and its event carry `serving`**: a running Burrow (none under
  Nothing), or a one-time status
  of `opening`, `waiting`, `confirming`, `connecting`, or `connected`; a flip
  emits `status`. What arms on each: `docs/specs/vscode.md` -> "Burrow: a
  service in the extension host".
- **Approval carries a `kind`** (`pairing` | `one-time`) on `PendingPairing`,
  `PairingQueueItem`, `ApproveParams`, and `DenyParams`. The one-time request
  has a slot of its own — `clientId: ''`, a fresh random `pairingId` ticket,
  after the pairings in the snapshot — and **its answer goes straight to the
  runtime, never behind the lifecycle chain**. **The service reads any `kind`
  but `one-time` as a `pairing`**, so a malformed answer finds nothing to
  approve. The mirror keys by `(kind, clientId)`.

**The origin is the build's Hosted origin, which only a Hosted build has**
(`docs/specs/relay.md` -> "Relay origin", whose "Accepted origins" bounds it). **Availability is decided before any socket exists**:
without a Hosted origin the state is `unavailable` with reason `self-host`, and
the service builds no runtime; the network policy's `nothing` makes it
`unavailable` with reason `network-off`, and a policy change ends a live
connection (`docs/specs/remote-network.md` -> "Policy").

**Standalone** passes the baked pair from the sidecar entry, and Rust
broadcasts every `burrow:event` unchanged. VS Code's bootstrap, idle answers,
and serving marker are `docs/specs/vscode.md` -> "Burrow: a service in the
extension host".

Source of truth: `BurrowService` in `lib/src/host/remote/service.ts`;
`lib/src/host/remote/service-protocol.ts`.

## Laptop UI

**`OneTimeConnection` sits in the Remote control choices of Settings →
Network's Phones section, enrolled or not**
(`docs/specs/remote-network.md` -> "Settings → Network"); `OneTimeIndicator`
sits in the Baseboard's right cluster (`docs/specs/layout.md` -> "Baseboard").

- **The panel renders the service's state and owns only its busy and error.**
  **Closing Settings changes nothing**: the link keeps waiting.
- **Never open a link on a timer**: only New link replaces one (rationale).
- **Cancel and End send `oneTimeEnd`; Done sends the one that returns `ended`
  to `idle`. `ended {user-ended}` renders as `idle`** (rationale).
- **End copy is fixed per reason and level**, looked up own-property only,
  with a fallback for a reason a newer broker knows.
- **The indicator shows only while `connecting` or `connected`**, with End
  (rationale).
- **The store seeds from `oneTimeStatus` and replaces its state with every
  `one-time` event that passes `isOneTimeState`**; an answer an event overtook
  is dropped. **Never publish a failed read over a state already read,
  unless an End has returned since**: a window that missed the End's event
  must not show the phone connected.

Source of truth: `OneTimeConnection` in
`lib/src/components/OneTimeConnection.tsx`; `OneTimeIndicator` in
`lib/src/components/OneTimeIndicator.tsx`; `lib/src/remote/burrow/one-time-store.ts`.

## Future

**Scope: one-time-limits** — a per-IP cap on concurrent rooms, beside the mint limit.
