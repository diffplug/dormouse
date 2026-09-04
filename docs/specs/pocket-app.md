# Pocket App Architecture

> See `docs/specs/glossary.md` for Session / Pane vocabulary.
> How the phone client (Dormouse Pocket) is structured and deployed. The
> protocol is [remote-api.md](./remote-api.md); the selfhost server is
> [server.md](./server.md).

## The seam: the remote session is a platform adapter

`lib` renders every Dormouse surface through a `PlatformAdapter`, whose PTY core
— `requestInit`/`onPtyList` resume path included — maps one-to-one onto the
remote-api v1 terminal protocol:

| PlatformAdapter          | remote-api                              |
| ------------------------ | --------------------------------------- |
| `onPtyList`              | `directory.snapshot`                    |
| attach semantics         | `surface.attach` (attach-is-the-resize) |
| `onPtyData`              | `terminal.data`                         |
| `writePty`               | `terminal.write`                        |
| `resizePty`              | `terminal.resize`                       |
| `onPtyExit`              | `terminal.closed`                       |

Pocket is therefore:

> auth screens + `MobileTerminalUi`/`MobileWall` + **`RemotePtyAdapter`**

— the composition [mobile-terminal-ui.md](./mobile-terminal-ui.md) owns, proved
out on `FakePtyAdapter` by
`website/src/components/PocketTerminalExperience.tsx`.

Three phases, one component: `SetupOrSignin`, `HostsView`, then `ConnectedView`
wrapping `PocketWall`. **Everything outside the PTY core no-ops or is absent** —
`getCwd` → null, shells/clipboard empty, alerts inert, `alertAwait` settling
`cancelled` rather than never resolving.

**Scanning is the only way in** — no setup password, no typed credential; the
code on the computer's screen is both account setup and pairing. A first run
leads with the scanner; a browser holding a passkey leads with sign-in and keeps
the scan beside it (rationale). **Prior use is stored passkey material**
(`PocketClient.hasPriorUse`), re-derived every render (rationale).

**The local record must not lag the registration, nor outlive a refusal**:
`setup` caches the public key between `registerPasskey` and `finish`, and a
`finish` the Server *answered* by rejecting clears it. **Blocked site data costs
persistence, not the visit** — `localStoragePocketStorage` mirrors writes in
memory and reads the mirror first. (rationale)

**A QR the native camera opened is origin bootstrap only.** The `#pair?`
fragment is erased with `history.replaceState` before the first render, parsed or
not; nothing is retained, no call is made, the token is not spent. All it keeps
is a flag leading the auth screen with *Scan again from inside Dormouse Pocket*.
(rationale)

**The scanner reads a code as data.** `ScanInvitation` lazy-loads
`@zxing/browser` for a rear-camera scan (iOS has no `BarcodeDetector`), never
navigates, and hands the text to `parsePairingInvitationUrl`
([server.md](./server.md) owns the grammar); a paste field feeds the same parser
(rationale).

* **A `null` parse is one of two fixed lines**: a code that would have parsed
  before it expired says so; everything else — a foreign-origin invitation
  included — is not a setup code for this server. `pairingInvitationExpired`
  re-runs that same parser at the epoch, so the grammar has no second copy.
* **The camera tracks stop on every way out** — accepted, cancelled, errored,
  unmounted, and on a start that finished after the screen was gone. Only a
  refused permission gets its own line; it leaves paste working.
* **The invitation lives in memory-only ceremony state**, cleared on every
  terminal outcome.

**After the parse.** A browser with no usable passkey registers one with the
scanned token (`setup({ setupToken })`) and signs in; one that already holds a
passkey signs in if it must, then **spends the code at `POST /api/setup/retire`**
so a photographed QR cannot register a passkey afterwards — a refusal aborts.
Then the per-Host static is minted, Noise IK runs against the invitation key, and
**the two digits go on screen before the outcome is known and stay until it
lands** ([remote-security-model.md](./remote-security-model.md) → Pairing).
**Cancelling closes the relay socket** and reports nothing. (rationale)

* **Sign-in stays offered on a first run** — a synced passkey may be the better
  path.
* **A passkey the authenticator already holds outranks an empty store**:
  `excludeCredentials` refusing (`PasskeyAlreadyRegisteredError`) proves this
  device can sign in, so sign-in leads. (rationale)
* **A refused token is reported, never folded away**:
  `SETUP_TOKEN_INVALID_ERROR` — expired, spent, or minted by a since-revoked
  Host — becomes `SetupTokenInvalidError`, whose message is the recovery: show a
  new code on the computer.
* **An installed iOS Pocket can never receive a scanned hash** — Camera opens
  Safari, a different partition, and the install launches at its own start URL.
  (rationale)

**Runtimes are gated, not degraded**: `probeNoiseSupport` runs before sign-in,
setup, pairing, or connection, and `false` renders a fixed upgrade requirement,
performing no remote operation
([remote-security-model.md](./remote-security-model.md) → Host identity).

**Pocket hides `MobileWall`'s local Kill affordance** (`showKillButton={false}`)
— remote panes are Host-owned; v1 grants no phone-side kill/layout authority.
(rationale)

`RemotePtyAdapter` exposes the adapter-specific `setActivePane(id)`: v1 allows
one attachment per session, so pane switching is detach → attach, whose repaint
(resize) redraws the screen. **Writes and resizes for a non-attached pane are
dropped**, since the Host rejects them anyway. Badges for non-attached panes come
from `directory.watch` without attaching.

Three details the table leaves implicit:

- **`PtyInfo.alive` is `entry.alive`, never derived from `entry.exitCode`** —
  the latter is the last command's shell-integration status, not PTY-process
  liveness.
- **An absent `terminal.closed` exit code maps to `-1`, not `0`** — the local
  path's sentinel; `0` would paint a signal-only kill as success.
- **Exited surfaces stay in the directory** with `alive:false` as history, so the
  wall filters them out of selectable sessions and the active-pane default.

**The pinned record picks a row's one action.** The Hosts view — titled
**Computers** (rationale) — lists the `KnownHostV1` records (no record, no row),
labeled from the record and stamped online from `GET /api/hosts`, offering
Connect alone or **Pair again** alone, never a Connect that can only fail.
**Nothing asks the Host**: only an authenticated
`pairing-required` outcome moves a row, dropping local authorization without
discarding the pin (rationale). Each row carries **Remove**, which tombstones the
delivery id before deleting the record; the list carries **Scan a setup code**.
Pairing continues into connecting.

Source of truth: `PlatformAdapter` in `lib/src/lib/platform/types.ts`;
`SetupOrSignin` / `PairingCodeView` / `HostsView` / `ConnectedView` and the
`probeNoiseSupport` gate in `lib/src/remote/pocket-app/App.tsx`;
`lib/src/remote/pocket-app/PocketWall.tsx`;
`lib/src/remote/pocket-app/pair-link.ts`;
`lib/src/remote/pocket-app/ScanInvitation.tsx`; `PocketClient.pair` in
`lib/src/remote/client/pocket-client.ts`; `attachableDirectoryEntries` in
`lib/src/remote/pocket-app/wall-model.ts`.

## Design system and theming

**All of Pocket — the auth screens included — renders on the shared themeable
design system** (`--color-*` tokens over `--vscode-*`; [theme.md](./theme.md),
`DESIGN.md`), never the website's separate "homepage" system
(`website/src/index.css`). **No Pocket-specific palette**: a theme change
re-skins auth screens and wall together.

**The theme is restored before first paint** by `main.tsx` calling
`restorePocketTheme()` (rationale), defaulting to Kimbie Dark, the homepage brand
theme; `PocketWall` repeats it idempotently through `usePocketTheme()` for
isolated consumers (stories). **That default is one shared `POCKET_THEME_ID`**
the website playground imports, so it cannot drift. Restoring also syncs
document-level chrome no in-app host needs — root `color-scheme` and the
`<meta name="theme-color">` tint — from the applied theme's type and resolved
`sideBar.background`; the static meta values in `lib/pocket/index.html` are
pre-boot placeholders.

The chrome draws only on theme.md's three list pairs: page = app, header band =
active-header (the "titlebar", doubling as the primary-action tone), host rows =
inactive-header. Secondary text and hairlines (dividers, the `outline` button)
are alpha on the owning pair's foreground; presence is intensity — an offline row
drops to `opacity-55`, with no online badge, border, `surface-raised`, or
`muted`. **The one status color is `text-error`**, delineated by a red inset
hairline because panel-border is transparent in many themes.

**Two phone-specific exceptions to `DESIGN.md`'s Two-Step Rule, kept narrow**:
form inputs use 16px text, and chrome type runs a step larger than desktop (13px
body, 11–12px secondary) with taller touch targets (44px block actions, 36px row
actions). (rationale)

Source of truth: `pkButton` / `PK` in
`lib/src/remote/pocket-app/pocket-chrome.tsx`,
`lib/src/remote/pocket-app/App.tsx`, `restorePocketTheme` / `usePocketTheme` /
`POCKET_THEME_ID` in `lib/src/remote/pocket-app/pocket-theme.ts`,
`lib/src/remote/pocket-app/main.tsx`, `lib/pocket/index.html`.

## Installable web app

Pocket ships a web app manifest and a service worker: installable to a home
screen, able to receive Web Push while backgrounded or closed.

**On iOS, installing is a prerequisite, not a nicety.** Web Push is granted only
to a Home Screen web app, never to a Safari tab: hence `display: standalone` in
the manifest (iOS ignores any other value) and a permission request from a real
user gesture. Adding to the Home Screen is manual and cannot be automated or
prompted for. **iOS also ignores the manifest's `icons` and honors only
`apple-touch-icon`**, so `lib/pocket/index.html` declares both.

**The manifest and icons must be checked-in source under `lib/pocket/public/`**,
which Vite copies verbatim, each referenced by an absolute root path:
`emptyOutDir` wipes `lib/dist-pocket` on every app build, so nothing may be
dropped in by hand.

**The worker is built, not copied.** It decrypts sealed pushes
([remote-security-model.md](./remote-security-model.md) -> Push sealing), so it
imports the shared crypto, the IndexedDB records, and `boundedPushText` rather
than mirroring them. `lib/vite.sw.config.ts` bundles it as one classic IIFE at
the stable, unhashed `dist-pocket/sw.js`, after the app build and with
`emptyOutDir: false`; registration stays `register('/sw.js', { scope: '/' })`
with **no `type: 'module'`**, pinned by `service-worker.test.ts`. **A worker that
is not one classic self-contained script fails the build**:
`lib/scripts/assert-pocket-worker.mjs` runs last in `build:pocket` and owns the
exact refusals (rationale). **Root `pnpm build` runs `build:pocket`**, so CI
checks a real bundler output (rationale; `assert-pocket-worker.test.ts`).
`dev:pocket` bundles the same config in memory per `/sw.js` request (rationale).

- **The worker caches nothing and registers no `fetch` handler** (rationale). It
  handles `push`, `notificationclick`, and `install`/`activate` to take over
  immediately (`skipWaiting` + `clients.claim`) — nothing else.
- **Every delivery ends in a notification.** `userVisibleOnly: true` promises it
  (rationale), so a push with no payload, an unknown `hostId`, a
  `pairing-required` record, a failed decrypt, or malformed plaintext shows the
  generic content-free notice rather than returning early. What does decrypt is
  re-validated and re-bounded here ([alert.md](./alert.md) -> Push notifications
  owns the rule). **A `showNotification` the UA refuses is retried once with
  that generic notice, then swallowed**, so the handler never rejects out of
  `waitUntil`. Pinned by
  `lib/src/remote/pocket-app/sw.test.ts`.
- **Registration is best-effort and never awaited**: a failure warns and boot
  continues (rationale) — ordinary without support and on an insecure origin,
  since service workers need a secure context (`localhost` exempt), as WebAuthn
  does (Deployment, below).
- **Clicking a notification focuses the app and leaves the user on the
  directory.** There is no deep link to a Pane: protocol-v1 carries no routable
  surface ref.

**The installed app is a separate storage partition from the browser tab** —
cookies, `localStorage`, and IndexedDB are not shared between iOS Safari and a
Home Screen web app — so the install mints its own per-Host statics and is a
*different Client*. **It therefore needs its own pairing approval on each Host**
([remote-security-model.md](./remote-security-model.md)). (rationale)

**Signing in *is* enough to ask.** `SigninFinishResponse` returns the asserted
passkey's public key, which a Client needs to build a presence proof, so a
profile that never registered can still pair (rationale); holding that public key
authorizes nothing ([remote-security-model.md](./remote-security-model.md) ->
Client statics). **If
the cached copy disappears mid-session, Pocket directs the user to sign in
again**; the verified response restores it on any profile.

**Pocket states the order on the screen that leads with the scan**, above the
action rather than after it: install to the Home Screen **first**, then scan,
approve the pairing on the machine, and enable push from within it — everything
partition-bound is minted from there, the passkey and each per-Host static.

**One phone can hold two Client identities, so Pocket names the mode in the label
it suggests at pairing** — `Dormouse Pocket (Home Screen)` versus
`Dormouse Pocket (browser)` — so the laptop's approval modal and the Alarm
settings dialog can tell them apart. **They cannot be merged**: separate Client
statics are separate delivery targets.

Source of truth: `lib/pocket/public/manifest.webmanifest`;
`lib/src/remote/pocket-app/sw.ts` with `lib/vite.sw.config.ts`;
`registerPushServiceWorker` in `lib/src/remote/pocket-app/service-worker.ts`;
`PASSKEY_UNAVAILABLE_MESSAGE` / `PocketClient.signin` in
`lib/src/remote/client/pocket-client.ts`; `deviceLabel` in
`lib/src/remote/pocket-app/App.tsx`.

### Detecting install state, and what cannot be detected

Installed means `navigator.standalone === true` (iOS) or the standard
`(display-mode: standalone)` media query. **Availability is evaluated in this
order, and every unavailable result is named in the UI:**

| Result | Condition | UI consequence |
|---|---|---|
| `needs-install` | `navigator.standalone` exists but the app is not installed; checked before capability probes, since iOS tabs omit those APIs | Explain Home Screen install above the scan action and again on the Hosts view; with no prompt API it stays advice — a tab must still scan |
| `unsupported` | Service workers, `Notification`, or `PushManager` unavailable after the install gate | Explain that this browser cannot receive push |
| `no-worker` | The tracked registration failed or resolved empty, commonly on an insecure origin | Explain the worker failure |
| `denied` | Notification permission is denied | Direct the user to browser settings |
| `ready` | Worker and APIs exist and permission is not denied | Offer the registration action |

`needsHomeScreenInstall` exports that predicate alone, so the auth gate awaits no
push machinery.

**Never parse the user-agent:** iPadOS reports as a Mac; `navigator.standalone`'s
presence is the install-required signal, absent on macOS Safari. **A tab cannot
detect the installed app** — the partitions share no signal — so the copy allows
for "already installed, wrong window."

**Both the availability check and the subscribe path await the tracked
registration promise**, never `navigator.serviceWorker.ready`, which never
settles after a failed registration.

**The Server's VAPID public key is prefetched before Pocket offers Enable**, in
an explicit config state (`loading`, `ready`, `disabled`, or `error`): a failed
fetch offers Retry, which only caches the key, and the next tap reveals Enable.
**Permission is requested on that separate, fresh tap** — a network round trip
can consume an iOS gesture's transient activation. (rationale)

Browser availability and Host registration are separate states: a
`PushSubscription` belongs to the service-worker scope; the Server stores one row
per `(hostId, deliveryId)`.

**Push is asked for once per device, on one card, on the Hosts view** — the
prompt and the subscription it mints are scope-wide; the per-Host rows are
bookkeeping. The card reads the paired Hosts as a set — **Enable push
notifications** while any lacks a row, one **Push notifications on.** line once
all have one — and its tap subscribes the browser, then registers every paired
Host, repairing a rotated endpoint at once. **Each response commits as it
lands**, so a loop that fails partway keeps what it registered. **Never offer
push from the wall or from a Host row.** The row states **Push on** beside its
pair state — the card carries no per-Host signal.

Every card state is one pure predicate over (paired set, registrations,
availability, config); `needs-install` is the one it declines to render, since
`InstallNotice` is the push card for that state.

**Which Hosts this device is registered with is read from the Server on entering
the Hosts list**, never tracked locally, and the connect neither refetches nor
drops it (rationale). **The readback is by capability, never by identity**
(rationale):
`POST /api/push/subscriptions/query` presents this browser's own delivery ids and
reports only on those ([server.md](./server.md) → Web Push).
`POST /api/push/subscribe` answers with the same thing — every Host this device
is registered with after the mutation — so **both are complete answers, never
deltas**: only which is newer. One run token drops any read a newer load, or a
completed registration, already overtook. **A read in flight or failed never
settles at empty on its own behalf**: the card re-offers its idempotent Enable.
(rationale)

**A Server row is necessary but not sufficient for Push notifications on.**
Pocket also checks that permission is still granted, that the scope holds a
`PushSubscription` minted for the Server's current VAPID key, and that it points
at the registered address; any of the four failing re-exposes Enable. **The
Server likewise omits rows under an old VAPID key** (rationale).

**Pocket records a SHA-256 digest of the address each time the Server accepts a
registration** (`dormouse-pocket:push-endpoint`, beside the `:passkey:` cache)
and compares it on open (rationale) — a digest, not the address, since it is a
bearer capability. **One key per device, not per Host**: one scope holds one
subscription. **Absent reads as no opinion, not as a mismatch**, so a device that
predates the record, or whose storage was cleared, is not forced to re-register.

**Repair waits for the next app open, never a `pushsubscriptionchange` handler in
`sw.js`**: a worker cannot obtain a session token — it lives in `PocketClient`
memory behind a fresh WebAuthn assertion, and a worker has no
`navigator.credentials`. **Unattended re-registration would need a long-lived
credential** [remote-security-model.md](./remote-security-model.md) does not
grant.

**Registering another Host, or retrying that POST, reuses the scope's existing
`PushSubscription`** when its `applicationServerKey` matches the Server's VAPID
key byte-for-byte; a new endpoint is minted only when the key differs
(rationale). **When it does rotate, the Server drops that device's other Host
rows in the same mutation** and its response lists what survived, which makes a
committed POST whose response was lost self-repairing (rationale).

**`subscribeToPushInBrowser` reports that replacement through a *required*
callback**, fired the moment the old address stops being valid, before the new
one is minted (rationale). Its one job is the UI: Pocket stops claiming **Push
notifications on** for every Host at that instant.

**Obsolete delivery mappings are retired, durably.** A `pairing-required`
transition, a re-pair that mints a new id, and an explicit **Remove** each write
the old `{ hostId, deliveryId }` to `PendingDeliveryDeletionV1` *before* the
record forgets it (rationale), then call the idempotent deletion route.
Tombstones retry after sign-in, on every entry to the Hosts list, and before
registering a replacement, and clear only on a Server answer. **This deletes the
delivery row alone** — never the scope's shared `PushSubscription`, and never
another Host's row.

Source of truth: `isInstalledWebApp` / `requiresInstallForPush` /
`needsHomeScreenInstall` / `getPushAvailability` / `hasCurrentPushSubscription` /
`subscribeToPushInBrowser` in `lib/src/remote/client/push-subscribe.ts`;
`InstallFirstNotice` / `InstallNotice` / `PushNotice` / `pushNoticeState` /
`onEnablePush` in `lib/src/remote/pocket-app/App.tsx`;
`PocketClient.listPushSubscribedHosts` / `subscribeToPush` /
`retirePendingDeletions` / `forgetHost` in
`lib/src/remote/client/pocket-client.ts`;
`lib/src/remote/pocket-app/service-worker.ts`; `pushEndpointFingerprint` in
`server-lib-common/src/security/push.ts`; `PushSubscriptionStore.upsert` and
`vapidPublicKey` in `server/src/state.ts`; `server/src/app.ts`.

## What Pocket stores

**One module owns the IndexedDB name, its version, its upgrade, and every open**
(rationale). `dormouse-pocket` is at **v3**: `known-hosts` (`KnownHostV1`, keyed
by `hostId`) and `pending-deletions` (`PendingDeliveryDeletionV1`, keyed
`hostId:deliveryId`). **The upgrade is "create what is absent, drop what is
gone"**, so a phone arriving from v1 or v2 lands in the same shape and its
`device-key` store goes with the protocol that used it (rationale).
**`navigator.storage.persist()` is requested once before the first write, and
never throws**: a browser with no storage manager, or one that refuses, gets
ordinary eviction-prone storage, which re-pairing survives
([remote-security-model.md](./remote-security-model.md) → Client static loss).

**A `KnownHostV1` is this Client's whole authorization state** — the pinned Host
static, the per-Host X25519 private half as a nonextractable `CryptoKey` beside
its raw public point, the paired passkey identifiers, and either
`{ paired, deliveryId }` or `pairing-required`. **Only the private half is a key
object**: a `NoiseKeyPair` wants the public half as raw bytes (rationale).
**`localStorage`
holds only the `:passkey:` cache and the `:push-endpoint` digest** — the
`:paired:` markers those records replaced are swept once at boot.

Source of truth: `lib/src/remote/client/pocket-db.ts`, `purgeLegacyPairedMarkers`
in `lib/src/remote/client/pocket-client.ts`.

## Serving the built bundle

Content types need no special-casing: `serveStatic` already answers
`application/manifest+json` for `.webmanifest` and `text/javascript` for `sw.js`.

**Caching is set explicitly.** Vite content-hashes everything it emits into
`assets/`, so those are `immutable`; everything else — `index.html`, the built
`sw.js`, and the `public/` passthroughs at the root — is `no-cache`: revalidate
before use, not never store, and load-bearing, because `emptyOutDir` deletes the
previous build's hashed assets (rationale). Two rules make it hold:

- **The class comes from the request path** (`/assets/` or not), never the
  platform-shaped resolved path (rationale). The header is staged on the context
  *before* `serveStatic` runs, since its `onFound` hook fires after the Response
  is built and cannot add to it.
- **The SPA fallback overrides that staged class, and 404s under `/assets/`.** A
  response's cache policy describes the response, and the shell is never a useful
  answer to a subresource miss. (rationale)

Source of truth: `registerPocketServing` in `server/src/app.ts`.

## A backgrounded phone loses its Host session

**While a connection is established and the page is visible, Pocket sends one
fixed-size keepalive every `E2E_KEEPALIVE_INTERVAL_MS` (30 s)** on the Noise
session; hiding the page pauses them, and returning sends one immediately before
resuming the interval. **Hidden means paused, not slowed**: a backgrounded tab
has its timers throttled or suspended outright. (rationale)

The Host disposes any session it has not decrypted a Client message on for
`ESTABLISHED_E2E_IDLE_TIMEOUT_MS` (120 s — four intervals;
[remote-security-model.md](./remote-security-model.md) → Host bounds). **A phone
suspended for longer than that comes back to no session**, and reconnecting costs
a fresh Noise handshake and one WebAuthn prompt. (rationale)

**Pocket runs the same deadline against its own last send**, before a keepalive
and before every request, and reports host loss when it passes. **A reap sends
nothing** — there is no frame to send — and this Client's relay socket is to the
*Server*, so it stays open. (rationale)

Source of truth: `PocketClient.sendKeepalive` / `#reapedByHost` and the injected
timer, clock, and visibility seams in `lib/src/remote/client/pocket-client.ts`.

## An expired session drops to sign-in

Sessions live only in the Server's memory ([server.md](./server.md)), so they end
on their 12h expiry *and* on every Server restart, while the passkey and
paired-host markers in `localStorage` outlive both. **Pocket therefore treats a
dead session as actionable, not reportable** (rationale): `PocketClient` clears
its in-memory token and throws `SessionExpiredError`; the app tears down any live
adapter and returns to sign-in carrying that message. One passkey prompt restores
the Hosts list, pairing and push registration intact.

Two details this depends on:

- **The trigger is the session gate specifically**, matched on the shared
  `UNAUTHORIZED_ERROR` from `server-lib-common/src/remote/wire.ts` — a 401 alone
  is ambiguous, since a refused setup token answers 401 too (as
  `SetupTokenInvalidError`). (rationale)
- **A rejected relay upgrade carries no status.** The browser surfaces it as a
  bare `error` event, so `openSocket` asks an authenticated route what happened:
  a 401 there means expiry, anything else leaves it an ordinary socket failure.

Source of truth: `SessionExpiredError` in
`lib/src/remote/client/pocket-client.ts`, `run` in
`lib/src/remote/pocket-app/App.tsx`.

## Deployment: same-origin, always

**The Pocket app is always served same-origin with its API.** WebAuthn binds
passkeys to the serving origin, and Chrome's Private Network Access rules block
public-site → private-network fetches. Pocket holds itself to it by construction
— an empty API base, a `wsBase` from `location.origin` — and the Server enforces
it: a registration or assertion whose `clientDataJSON.origin` is
not the configured `DORMOUSE_ORIGIN` is rejected ([server.md](./server.md);
rationale). **The Server emits no CORS grant**; the Host's HTTP client runs in
Node, so no supported client needs one. **The bundle mounts at the origin root,
never under a path prefix**: the manifest's `start_url`/`scope`, the worker's
registration scope, and the shell's manifest/icon links are all root-absolute.

**The origin is served with a Content-Security-Policy**, the defense in depth
around the active XSS `docs/specs/security.md` -> "What is not defended" names (rationale).
Every source is the app's own origin
(`default-src 'self'`, with `frame-ancestors`, `base-uri` and `object-src`
`'none'`), with three loosenings:

* **`style-src 'unsafe-inline'`**, because the shell carries a pre-paint
  `<style>` and React writes `style` attributes — a hash covers the first but not
  the second.
* **`connect-src` names the WebSocket origin explicitly** — `DORMOUSE_ORIGIN`
  with the scheme swapped — rather than resting on `'self'` (rationale). It can
  only ever be this deployment's own relay.
* **`img-src` also admits `data:` and `blob:`, `media-src` `blob:`**; every
  other directive is `'self'`.

**`script-src` stays `'self'`, with no nonce pipeline**, and the build keeps
earning it: `assertPocketShell` fails `build:pocket` on any inline
`<script>` body or off-origin `src`/`href` in the emitted `index.html`.
(rationale)

One lib-owned bundle, two deployments:

* **Selfhost (shipped):** the Node server serves the bundle (`lib/dist-pocket`);
  selfhost auth never depends on dormouse.sh existing.
* **SaaS (staged — see [Future](#future)):** CloudFlare serves the static site
  and routes `/api/*` and `/ws/*` to the dynamic backend (CloudFlare proxies
  WebSockets). The same bundle mounts at the site origin; rpId is the site's.

**The website stays fully static — playground and marketing pages — in both
worlds**, sharing all terminal UI through `lib` and never duplicating Pocket
code.

Source of truth: `pocketContentSecurityPolicy` in `server/src/app.ts`,
`assertPocketShell` in `lib/scripts/assert-pocket-worker.mjs`.

## Future

1. **Dedupe the composition** — the website's `PocketTerminalExperience` and the
   Pocket shell (`PocketWall.tsx`) each wire `MobileTerminalUi` + `MobileWall`
   independently; extract the shared wiring so the two cannot drift.
2. **CloudFlare routing** — the SaaS deployment above; deferred until SaaS.
   Nothing in the shipped architecture needs rework for it.
3. **Theme picker in Pocket** — the app restores the persisted theme but exposes
   no picker; add the shared `ThemePicker` (and its theme-debugger entry) once
   its dropdown is phone-friendly.
4. **Onboarding friction** — Pocket carries the phone-side items of the
   **selfhost-onboarding** scope ([server.md](./server.md) `## Future`).
