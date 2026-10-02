# Burrow service

> See `docs/specs/glossary.md` for Session / Pane / Surface vocabulary.
> Owns the desktop Burrow: the Relay origin a build bakes, `BurrowService` and its store, enrollment from the laptop, the relay socket, and Settings → Remote control. `docs/specs/relay.md` owns the selfhost Relay it enrolls with and the wire both share, `docs/specs/hosted.md` the Hosted one; host plumbing is `docs/specs/standalone.md` -> "Burrow service" and `docs/specs/vscode.md` -> "Burrow: a service in the extension host".
> Read `docs/specs/remote-security-model.md` first — it owns what the Burrow decides and proves.

## Relay origin

**Every desktop build bakes exactly one origin, `DORMOUSE_RELAY_ORIGIN`, into the
Node bundle that holds the relay socket, and its Burrow reaches no other Relay.**
No CSP fences that socket, and **the webview CSPs carry no relay sources**
(`docs/specs/vscode.md` -> "CSP policy"; `standalone/scripts/tauri-conf.test.mjs`).
The origin sets the build's mode (rationale):

| `DORMOUSE_RELAY_ORIGIN` | Mode | Relay | One-time connection | Managed voice | Standalone auto-update |
| --- | --- | --- | --- | --- | --- |
| unset, or `https://relay.dormouse.sh` | Hosted | Hosted's, enrolled by device code | at this origin | at `https://voice.dormouse.sh` | on |
| any other accepted origin | self-host | exactly this origin | off | off | off |

- **A self-host build sends nothing to `dormouse.sh` or any host under it
  unless the user clicks a link** (rationale). **Every Hosted-reaching host
  feature takes the nullable `hostedOrigin` or `hostedVoiceOrigin` and does
  nothing on `null`** (`docs/specs/one-time.md` -> "Service and hosts",
  `docs/specs/alert.md` -> "Managed voice"); the standalone webview never checks
  for updates (`docs/specs/auto-update.md` -> "How it works").
- **The stock binary reaches only the default origin**, so self-hosting takes a
  source build whose `DORMOUSE_RELAY_ORIGIN` is exactly its Relay's
  `DORMOUSE_ORIGIN` (`SELF_HOST.md` -> "Prerequisites").
- **Accepted origins**: a bare origin as `new URL` spells it, on `https:` or on
  loopback `http:` (`localhost`, `127.0.0.1`, `[::1]`), of at most
  `MAX_RELAY_ORIGIN_LENGTH`, the longest a one-time link fits. Anything else
  fails the build. A self-host origin past the pairing QR's tighter limit still
  builds, then cannot set up a phone (`docs/specs/relay.md` -> "Setup tokens and
  the pairing QR").
- **`DORMOUSE_RELAY_IS_HOSTED=1` counts a non-default origin as Hosted in a dev
  build only** — `pnpm dev:standalone`, `pnpm innerdogfood`, VS Code's `watch`.
  **Every other build is a release build and fails when the flag is set or the
  origin is loopback `http:`** (rationale). Unflagged, a loopback origin is a
  local self-host Relay.
- **A retired variable set non-blank fails the build**:
  `DORMOUSE_REMOTE_CONNECT_SRC`, `DORMOUSE_HOSTED_ORIGIN`,
  `DORMOUSE_ONE_TIME_ORIGIN`.
- **Managed voice's origin is the constant `HOSTED_VOICE_ORIGIN`, never baked
  or overridden**, a loopback dev Hosted build included (rationale). **The
  account's origin is the constant `HOSTED_ACCOUNT_ORIGIN`, never baked and never
  requested**: the desktop opens it only on a user's click, in the browser.
  Hosted's origins: `docs/specs/hosted.md` -> "Application boundary".

**The Burrow composes every Relay URL from the baked origin and takes none as
input.** `enroll` and `enrollOffer` post to it, and **a Hosted build refuses
both**; device-code enrollment ("Burrow side") is Hosted's alone. Any build
refuses all three under the network policy's `nothing`
(`docs/specs/remote-network.md` -> "Policy"). **An enrollment whose Relay URL or
`origin` names another origin reads as none** wherever one is read — `start`,
`status`, VS Code's activation — and stays on disk untouched, so switching back
restores it (rationale). Origins compare as `new URL(...).origin`.

**The enroll request carries the baked origin**, which a Relay served from
another refuses before spending or saving anything (`docs/specs/relay.md` ->
"HTTP API"). **An older Relay enrolls anyway, so the Burrow refuses a reported
`origin` other than its own before persisting**, naming the `burrows.json` row
left behind.

**Both build failure modes are silent, so the build catches both**
(rationale): a bad variable, and a bundle the `define` did not reach, the
readers taking the value **as a `declare const`, never an import**. **The
standalone webview bakes the same pair** through Vite's `define`: the dev server
under the dev rule, `vite build` under the release rule.

**Enrollment and Burrow-authenticated push fetches must use `redirect:
'error'`**: Node does not re-check a redirect target, so following one could
carry the setup password, a device code, the `burrowToken`, or notification
metadata to another origin.

Source of truth: `resolveRelayOrigin` and `assertRelayOriginBaked` in
`scripts/relay-origin.mjs`; `isAcceptedRelayOrigin` in
`remote-lib-common/src/security/one-time-link.ts`; `bakedRelay` in
`lib/src/host/relay-origin.ts`; `BurrowService` in
`lib/src/host/remote/service.ts`.

## Burrow side (`lib` + the two Node hosts)

**The Burrow is a service in the process that owns the PTYs, never a webview**:
`BurrowService`, in the Tauri sidecar and in the VS Code extension host. The
webview holds only UI — the pairing modal, the `window.dormouseBurrow` console
hook, ring detection for push (`docs/specs/alert.md` -> "Push notifications"),
and answering for its own panes and terminal sizes — reaching the service over
the `burrow:*` bridge. `lib/src/host/remote/` is shared by both hosts; only the
store, process plumbing, and bridge transport are host-owned.

**The store contract.** Both `BurrowStateStore` implementations:

* **Reads fail closed**: an error that says nothing about what the file holds
  answers neither empty nor stale, since an empty ACL silently de-pairs every
  device.
* **The in-memory view advances only after the durable write lands.**
* **Every mutation is serialized in call order** through `createSerialQueue`,
  so an older ACL snapshot cannot land last (rationale).
* **A store that cannot persist still holds what it is given** in memory and
  reports `persistent: false`.
* **The ACL is keyed per `burrowId`**: an enrollment onto a fresh one starts
  empty; a re-enrollment onto the same one keeps its paired devices.

**Enrollment** (Settings, or the console hook, once):

- **Must mint the Noise static before requesting enrollment, and never send
  either half** (`docs/specs/remote-security-model.md` -> "Burrow identity").
  The request carries one credential and the baked `origin`, nothing else:
  **the operator's `label` is kept locally and disclosed only inside encrypted
  outcomes**.
- **`burrowToken` never enters a webview realm**: `enroll` answers
  `{ burrowId }`.
- **A 200 that is not an enrollment fails the exchange**: the response goes
  through the same `isEnrollment` guard every read uses, naming the bad field
  (rationale).
- **Burrow→Relay requests time out at `BURROW_REQUEST_TIMEOUT_MS`, under the
  webview's own 15 s command budget** (rationale).
- **The store goes first**: the save is awaited before any running Burrow is
  stopped (rationale), and **`clearEnrollment` awaits the delete before anything
  else**. Replacing a running Burrow emits a `status` event with
  `enrolled: false` between the two, since the webview's gate is
  edge-triggered.
- **Enrolled, the service holds `GET /ws/burrow` under every network policy
  level but `nothing`**, which keeps the enrollment without a socket
  (`docs/specs/remote-network.md` -> "Policy").
- **`suggestedLabel` names the app beside the hostname**: standalone and the
  extension are two Burrows on one machine, and Pocket lists them as two rows.

**Hosted enrollment** (a Hosted build; the protocol is `docs/specs/hosted.md` ->
"Burrow enrollment"): `beginHostedEnrollment` posts at the baked origin and the
service polls on its own, off the lifecycle chain. Refused on an enrolled
machine.

- **Must answer a code already waiting, or redeeming, rather than replace it**:
  another VS Code window's Enroll reaches the same service. **Never change what
  ended until a new begin has its code.**
- **Never send the device code to the webview**, as for `burrowToken`.
- **Must compose the verification URL, never take it from the Relay, in a
  release build**: `HOSTED_ACCOUNT_ORIGIN/enroll#<userCode>`. A dev Hosted
  build (`isDevHostedBuild`) takes only the origin of the Relay's
  `verificationUrl`, after `parseLinkFragment`'s checks, and refuses a begin
  without one.
- **Must stop polling** on the Relay's `expired`, at this machine's own deadline
  (the clocks being separate), on Cancel, on disposal, and under `nothing`. **A
  full account polls on**, the Relay keeping the approval.
- **Must hold a redemption that lands after Cancel or a new begin**: the Relay
  has spent and recorded it. When it cannot be held, the failure names the
  Burrow and the account page to remove it at.
- **Must retain an enrollment whose save succeeded when startup fails**,
  reporting restart guidance, never removal advice.

**Relay socket policy**: one socket at a time, reconnected with backoff after
any close **except three, which are terminal** (rationale): the Burrow disposes
its sessions, latches a state, and arms no timer.

| Close | State | Meaning |
|---|---|---|
| `WS_CLOSE_BURROW_REPLACED` (4000; rationale) | `displaced` | another instance enrolled with the same `burrowId` took the relay slot |
| `WS_CLOSE_BURROW_REVOKED` (4001) | `removed` | the Burrow's row is gone |
| `WS_CLOSE_BURROW_NOT_ENTITLED` (4002, Hosted only) | `not-entitled` | its owner is no longer entitled |

Coming back is an explicit `reconnect()` or a fresh start, which after
`displaced` takes the slot back.

- **A socket that never opened is probed before its next backoff**, a refused
  upgrade being only an error event: one `GET /api/push/devices` as the Burrow.
  A 401 `UNAUTHORIZED_ERROR` or `UNKNOWN_BURROW_TOKEN_ERROR` latches `removed`,
  a 403 `NOT_ENTITLED_ERROR` `not-entitled`. **Only a 2xx, 401, or 403 spends
  the failure streak's one probe** (rationale).
- **A latched `removed` or `not-entitled` Burrow (`relayRefuses`) asks its Relay
  nothing more**: no push, device list, or setup code.
- **Ignore every event and probe answer from a socket the runtime no longer
  owns** (rationale), and **never construct a socket after service disposal**.

**Security**: `BurrowAcl`, `ChallengeIssuer`, `verifyPresenceProof`, and the
Noise responder for both ceremonies run in the service's process. **Must keep
authorization in the Burrow process**; the expected two-digit code never leaves
it (`docs/specs/remote-security-model.md` -> "Pairing").

**Setup codes**: `setupQr`, enrolled only, mints the Relay's setup token, has
the `BurrowRuntime` mint an invitation, and composes the URL
(`docs/specs/relay.md` -> "Setup tokens and the pairing QR"). **A mint that
resolves onto a different Burrow is refused rather than painted.** **The QR's
secrets cross into the webview — displaying them is their purpose — while the
invitation's private half and `burrowToken` stay in the Burrow process.** The
Burrow reports its invitation states as an `invitation` event. **A route the
Relay may legitimately hold open past `BURROW_REQUEST_TIMEOUT_MS` passes its own
timeout** (push delivery).

**Pairing confirmation**: the queue is service-side; webviews mirror
`{ kind, clientId, pairingId, label, requestedAt }[]`, pushed whole on every
change, and echo the kind, both ids, and the **typed digits** on Confirm, so
the approve/deny closures never leave the Burrow process. A one-time
connection's request rides the same queue under its own kind
(`docs/specs/one-time.md` -> "Service and hosts"). **A confirmation is bound to
the displayed `pairingId`, not whichever ceremony holds `clientId`**: a
re-sent pairing replaces its predecessor, and an old modal's action is
rejected. **Confirming after the invitation expires answers
`invitation-expired`, ACL untouched.** In VS Code the queue reaches every
window.

**Terminal bridge**: `docs/specs/remote-api.md` -> "The provider seam".

Source of truth: `BurrowService` in `lib/src/host/remote/service.ts`;
`BurrowConsoleStatus` in `lib/src/host/remote/service-protocol.ts`;
`FileBurrowStateStore` in `lib/src/host/remote/burrow-state-store.ts`;
`performEnrollment` in `lib/src/remote/burrow/enrollment.ts`; `BurrowRuntime`
in `lib/src/remote/burrow/burrow-runtime.ts`; `probeBurrowStanding` in
`lib/src/remote/burrow/burrow-fetch.ts`; `installBridgeMode` in
`lib/src/remote/burrow/activation.ts`, the webview half. The relay socket
policy is pinned by `lib/src/remote/burrow/burrow-relay-socket.test.ts`.

### Remote control, in the Settings dialog

The **Remote control** choices sit in the Phones section of Settings → Network
under any level but Nothing (`docs/specs/remote-network.md` -> "Settings →
Network"): **One-time connection** (`docs/specs/one-time.md` -> "Laptop UI")
and **Persistent Relay**, whose enroll view follows the build's `relayMode`. A
self-host build enrolls only under **My Relay only**; a Hosted build under Local
networks or Anywhere. **It renders nothing where `getPlatform().burrow` is
absent** — the website and the lib dev server have no Burrow service.

- **The offer card shows only where it can be pressed**: an unexpired local
  offer file naming the baked origin, on an un-enrolled self-host Burrow.
  **Reading the file is bounded to that state** (rationale).
- **The offer's token never enters a webview**: `status` carries only whether
  there is one (`docs/specs/security-remote.md` -> "Credentials at rest"). **The
  click re-reads the file**, so an old card cannot reuse a spent offer;
  `enrollOffer` takes `{ label }` alone.
- **The setup password is passed through, never held**, and cleared on success.
- **Refusals show the service's own error**, never a generic wrong-password
  message.
- **"Set up a phone" mints only when its panel opens**, replaces its code before
  `expiresAt` while open, and **reports which decision ended the code** in fixed
  local copy (`docs/specs/remote-security-model.md` -> "Pairing"; rationale).
- **`removed` and `not-entitled` offer no "Set up a phone"**; a Hosted
  `removed` offers Enroll again, which clears the enrollment and then begins a
  device-code enrollment.
- **The Hosted enroll view renders `status.hostedEnrollment` and holds no state
  of its own**; it opens `verificationUrl` with `openExternal` only on a click.
- **Status is re-read, not patched**: the service's `status` event carries only
  `{ enrolled, serving, serviceId }`, so every event triggers a full `status`
  command, and the dialog re-reads on open since another window may have
  enrolled. **The connection is polled while something is subscribed**, never
  as a standing timer in every window (rationale).

**Never expose pairing confirmation or one-time commands on
`window.dormouseBurrow`**; its enrollment methods are the scripting seam.

Source of truth: `lib/src/components/RemoteControlSection.tsx`, pinned by
`lib/src/components/RemoteControlSection.test.tsx`;
`lib/src/remote/burrow/burrow-status-store.ts`; `readUsableOffer` in
`lib/src/host/remote/service.ts` over the per-platform path in
`lib/src/host/remote/enroll-offer.ts`; `installBridgeMode` in
`lib/src/remote/burrow/activation.ts`.
