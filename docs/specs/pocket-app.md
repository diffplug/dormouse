# Pocket App Architecture

How the phone client (Dormouse Pocket) is structured and deployed. Companion
to [remote-api.md](./remote-api.md) (the protocol) and
[server.md](./server.md) (the selfhost server).

> See `docs/specs/glossary.md` for Session / Pane vocabulary. This spec uses it
> when naming what a notification or a directory row refers to.

## The seam: the remote session is a platform adapter

`lib` renders every Dormouse surface through a `PlatformAdapter`
(`lib/src/lib/platform/types.ts`). The adapter's PTY core — `writePty`,
`resizePty`, `onPtyData`, `onPtyExit`, plus the `requestInit`/`onPtyList`
resume path built for VS Code webview reloads — maps one-to-one onto the
remote-api v1 terminal protocol:

| PlatformAdapter          | remote-api                              |
| ------------------------ | --------------------------------------- |
| `onPtyList`              | `directory.snapshot`                    |
| attach semantics         | `surface.attach` (attach-is-the-resize) |
| `onPtyData`              | `terminal.data`                         |
| `writePty`               | `terminal.write`                        |
| `resizePty`              | `terminal.resize`                       |
| `onPtyExit`              | `terminal.closed`                       |

So the Pocket app is NOT a bespoke terminal UI. It is:

> auth screens + `MobileTerminalUi`/`MobileWall` + **`RemotePtyAdapter`**

— the exact composition the website playground proves out with
`FakePtyAdapter` (`website/src/components/PocketTerminalExperience.tsx`). The
composition itself, and its other consumers, belong to
[mobile-terminal-ui.md](./mobile-terminal-ui.md).

Three phases, one component: `SetupOrSignin`, `HostsView`, then `ConnectedView`
wrapping `PocketWall`. Source of truth: `lib/src/remote/pocket-app/App.tsx`, and
`lib/src/remote/pocket-app/PocketWall.tsx`, which composes `MobileTerminalUi` +
`MobileWall` over the remote adapter. Everything outside the PTY core no-ops or
is absent — the interface is designed for capability degradation (`getCwd` →
null, shells/clipboard empty, alerts inert, `alertAwait` settling `cancelled`
rather than handing back a promise that never resolves).

**Scanning is the only way in.** There is no setup password, no typed
credential, and no QR-less path: the code on the computer's screen is both the
account setup and the pairing. A first run leads with the scanner; a browser
holding a passkey leads with sign-in and keeps the scan beside it, since a
signed-in phone still scans to pair a *new* computer. Prior use is stored
passkey material (`PocketClient.hasPriorUse`), re-derived every render so a
half-finished run retries into whichever half can still work. **The local record
must not lag the registration, nor outlive a refusal**: `setup` caches the
public key between `registerPasskey` and `finish`, so a lost `finish` answer
leaves a browser that can sign in rather than one minting a second passkey —
while a `finish` the Server *answered* by rejecting clears it, that answer being
proof there is nothing to sign in against. Blocked site data costs persistence,
not the visit: `localStoragePocketStorage` mirrors writes in memory and reads
the mirror first, since that write lands after the credential is already
irreversible and a throw would leave every retry minting an orphan.

**A QR the native camera opened is origin bootstrap only.** The `#pair?`
fragment is erased with `history.replaceState` before the first render, parsed
or not — an address bar, a history stack and a screenshot are no place for a
live credential — nothing from it is retained, no call is made, and the token is
not spent. All the run keeps is a flag that leads the auth screen with *Install
or open Pocket, then scan this Host QR in Pocket*: on iOS the camera opens
Safari, a different storage partition from the installed app, so the keys must
be minted where they will live.

**The scanner reads a code as data.** `ScanInvitation` lazy-loads
`@zxing/browser` for a rear-camera scan (iOS has no `BarcodeDetector`), never
navigates, and hands the text to `parsePairingInvitationUrl`
([server.md](./server.md) owns the grammar); a paste field feeds the same
parser, since a pasted invitation is no weaker than a scanned one and a desktop
browser or the dev loop has no camera. A `null` parse is one fixed line, because
that parser answers a complete invitation or nothing and never a reason. **The
camera tracks stop on every way out** — accepted, cancelled, errored, unmounted,
and on a start that finished after the screen was gone. A refused permission is
named and leaves paste working; every other camera failure reads the same from
here. The invitation moves into memory-only ceremony state, which clears on
every terminal outcome.

**After the parse.** A browser with no usable passkey registers one with the
scanned token (`setup({ setupToken })`) and signs in; one that already holds a
passkey signs in if it must, then spends the code at `POST /api/setup/retire` so
a photographed QR cannot register a passkey afterwards — and a refusal aborts,
since a dead code is one the Host would refuse too. Then the per-Host static is
minted, Noise IK runs against the invitation key, and **the two digits go on
screen before the outcome is known and stay until it lands**: the laptop's modal
tells the user to cancel if the phone shows no code
([remote-security-model.md](./remote-security-model.md) → Pairing). Cancelling
closes the relay socket — the only way out of a wait that has no other end — and
reports nothing, because the ceremony the user abandoned has nothing left to say
to them.

* **Sign-in stays offered on a first run** — a synced passkey may be the better
  path.
* **A passkey the authenticator already holds outranks an empty store.**
  `excludeCredentials` refusing (`PasskeyAlreadyRegisteredError`) proves this
  device can sign in, so sign-in leads instead of a registration whose every
  retry fails the same way.
* **A refused token is reported, never folded away.**
  `SETUP_TOKEN_INVALID_ERROR` — expired, spent, or minted by a since-revoked
  Host — becomes `SetupTokenInvalidError`, and its message is the whole
  recovery: show a new code on the computer.
* **An installed iOS Pocket can never receive a scanned hash** — Camera opens
  Safari, a different partition, and the install launches at its own start URL.
  Scanning from inside the installed app is what the bootstrap copy asks for.

**Runtimes are gated, not degraded.** `probeNoiseSupport` runs before sign-in,
setup, pairing, or connection; `false` renders a fixed upgrade requirement and
performs no remote operation
([remote-security-model.md](./remote-security-model.md) → Host identity).

Source of truth: `lib/src/remote/pocket-app/pair-link.ts`,
`lib/src/remote/pocket-app/ScanInvitation.tsx`, `SetupOrSignin` /
`PairingCodeView` / the gate in `lib/src/remote/pocket-app/App.tsx`, and
`PocketClient.pair` in `lib/src/remote/client/pocket-client.ts`.

**Pocket hides `MobileWall`'s local Kill affordance** (`showKillButton={false}`)
— remote panes are Host-owned, and v1 grants no phone-side kill/layout
authority. Closing a local xterm view without a Host-side close would leave the
Host attachment live and the phone view inconsistent.

Adapter-specific extras (as with `FakePtyAdapter`'s scenario controls):
`RemotePtyAdapter` exposes `setActivePane(id)` — v1 allows one
attachment per session, so pane switching is detach → attach, and the attach
repaint (resize) redraws the screen. Writes and resizes for a non-attached pane
are dropped, since the Host rejects them anyway. Badges for non-attached panes
come from `directory.watch` without attaching.

Three details the table above leaves implicit:

- **`PtyInfo.alive` is `entry.alive`, never derived from `entry.exitCode`** —
  the latter is the last command's shell-integration status, not PTY-process
  liveness.
- **An absent `terminal.closed` exit code maps to `-1`, not `0`.** Signal-only
  kills and Hosts that report none would otherwise paint an abnormal close as
  success; `-1` is the sentinel the local path already uses.
- **Exited surfaces stay in the directory** with `alive:false` as history, so
  the wall filters them out before rendering selectable sessions or defaulting
  the active pane (`attachableDirectoryEntries` in
  `lib/src/remote/pocket-app/wall-model.ts`).

**The pinned record picks a row's one action.** The Hosts view lists the
`KnownHostV1` records — a Host with no record is not a row — labeled from the
record and stamped with online state from `GET /api/hosts`, and offers Connect
alone or **Pair again** alone, never a Connect that can only fail. Nothing asks
the Host: an authenticated `pairing-required` outcome is the only thing that
moves a row, and it removes local authorization without discarding the pin, so
an ACL reset or a revocation recovers through the ordinary ceremony. Each row
also carries **Remove**, which tombstones the delivery id before deleting the
record, and the list carries **Scan a Host QR**. Pairing continues into
connecting, so laptop approval lands the phone in a terminal.

## Design system and theming

Pocket is a product surface, not a marketing page: **all of it — the auth
screens included — renders on the shared themeable design system** (`--color-*`
tokens over `--vscode-*`; [theme.md](./theme.md), `DESIGN.md`), never the
website's separate "homepage" system (`website/src/index.css`). No
Pocket-specific palette: a theme change re-skins auth screens and wall together.

Pocket has no VS Code host and boots into auth long before a Wall exists, so
`main.tsx` restores the theme itself before first paint via
`restorePocketTheme()` (`lib/src/remote/pocket-app/pocket-theme.ts`), defaulting
to Kimbie Dark (the homepage brand theme); `PocketWall` repeats it idempotently
through `usePocketTheme()` for isolated consumers (stories). That default is one
shared `POCKET_THEME_ID` the website playground imports, so it cannot drift.
Restoring also syncs document-level chrome no in-app host needs: root
`color-scheme` (native form controls, scrollbars) and the
`<meta name="theme-color">` address-bar tint, from the applied theme's type and
resolved `sideBar.background`; the static meta values in `lib/pocket/index.html`
are pre-boot placeholders.

The chrome draws only on theme.md's three list pairs — page = app, header band =
active-header (the "titlebar", doubling as the primary-action tone), host rows =
inactive-header — with secondary text and hairlines (dividers, the `outline`
button) as alpha on the owning pair's foreground and presence as intensity: an
offline row drops to `opacity-55`, with no online badge, border,
`surface-raised`, or `muted`. The one status color is
`text-error`, delineated by a red inset hairline because panel-border is
transparent in many themes.

Two phone-specific exceptions to `DESIGN.md`'s Two-Step Rule, kept narrow: form
inputs use 16px text (anything smaller triggers iOS zoom-on-focus, and 10–12px
is illegible at thumb distance), and chrome type runs a step larger than desktop
(13px body, 11–12px secondary) with taller touch targets (44px block actions,
36px row actions). Source of truth: `lib/src/remote/pocket-app/pocket-chrome.tsx`
(the `pkButton`/`PK` vocabulary every screen draws from),
`lib/src/remote/pocket-app/App.tsx` (views),
`lib/src/remote/pocket-app/pocket-theme.ts`
(theme boot + browser-chrome sync), `lib/pocket/index.html` (structural viewport
rules + pre-boot color fallbacks).

## Installable web app

Pocket ships a web app manifest and a service worker so it can be installed to
a phone's home screen and receive Web Push while backgrounded or closed. Source
of truth: `lib/pocket/public/manifest.webmanifest`, `lib/pocket/public/sw.js`,
and `registerPushServiceWorker()` in
`lib/src/remote/pocket-app/service-worker.ts`, called from `main.tsx`.

**On iOS, installing is a prerequisite, not a nicety.** Web Push is granted only
to a Home Screen web app — never to a Safari tab — which is why the manifest
sets `display: standalone` (iOS ignores any other value here) and why permission
must be requested from a real user gesture. Adding to the Home Screen is manual
and cannot be automated or prompted for. iOS also ignores the manifest's `icons`
and honors only `apple-touch-icon`, so `lib/pocket/index.html` declares both.

The manifest, icons, and `sw.js` live in `lib/pocket/public/` rather than the
bundle because Vite copies `publicDir` verbatim: each is referenced by an
absolute root path, and a service worker must be served from the scope it
controls under a stable, unhashed name — all of which bundling breaks.
`emptyOutDir` wipes `lib/dist-pocket` on every build, so they must be checked-in
source, never dropped into the output by hand.

- **The worker caches nothing and registers no `fetch` handler.** Pocket is
  useless without a live relay connection, so an offline cache would buy no
  working screens while fighting `registerPocketServing`, whose per-request
  `index.html` re-read exists because rebuilds swap in new hashed assets. It
  handles `push`, `notificationclick`, and `install`/`activate` to take over
  immediately (`skipWaiting` + `clients.claim`, free with no cache to migrate) —
  nothing else.
- **A push that cannot be parsed still shows a notification.**
  `userVisibleOnly: true` promises that every delivery becomes visible; a
  browser catching the worker showing none substitutes its own "site updated in
  the background" notice and counts it against the subscription. Malformed and
  payload-less pushes therefore fall back to generic text rather than returning
  early — reading the raw text is guarded separately, so no payload shape exits
  the handler without a notification. `title`/`body` are re-bounded at this sink
  because the string is terminal-supplied ([alert.md](./alert.md) -> Push
  notifications owns the rule).
- **Registration is best-effort and never awaited.** Every screen works without
  the worker, so a failure warns and boot continues — ordinary without support
  and on an insecure origin, since service workers need a secure context
  (`localhost` exempt), the same constraint WebAuthn imposes (Deployment,
  below).
- Clicking a notification focuses the app and leaves the user on the directory.
  There is no deep link to a Pane: protocol-v1 carries no routable surface ref.

**The installed app is a separate storage partition from the browser tab.** On
iOS, cookies, `localStorage`, and IndexedDB are not shared between Safari and a
Home Screen web app, so the install mints its own per-Host statics and is a
*different Client* than the same phone's Safari tab.

**The install needs its own pairing approval on each Host** — the one
consequence that survives, and the security model working as designed: signing
in is not enough to reach a machine, and a Client the user has not approved
there must not inherit access
([remote-security-model.md](./remote-security-model.md)).

Signing in *is* enough to ask. `SigninFinishResponse` returns the asserted
passkey's public key, which a Client needs to build a presence proof, so a
profile that never registered can still pair instead of minting a redundant
second passkey. Holding that public key authorizes nothing
([remote-security-model.md](./remote-security-model.md) -> Client statics).
If the cached copy disappears mid-session, Pocket directs the user to sign in
again, and the verified response restores it on any profile. Source of truth:
`PASSKEY_UNAVAILABLE_MESSAGE` and `PocketClient.signin` in
`lib/src/remote/client/pocket-client.ts`.

So the order is: install to the Home Screen **first**, then scan, approve the
pairing on the machine, and enable push from within it — **and Pocket says so on
the screen that leads with the scan**, above the action rather than after it.
Everything partition-bound is minted from there: the passkey, and a per-Host
static for each machine. A scanned code does not survive the install either: the
installed app launches at `start_url`, which carries no hash.

Because one phone can hold two Client identities, Pocket names the mode in the
label it suggests at pairing — `Dormouse Pocket (Home Screen)` versus
`Dormouse Pocket (browser)` — so the laptop's approval modal, and the Alarm
settings dialog afterwards, can tell two entries for one phone apart. They
cannot be merged: separate Client statics are separate delivery targets. Source
of truth: `deviceLabel` in `lib/src/remote/pocket-app/App.tsx`.

### Detecting install state, and what cannot be detected

Source of truth: `isInstalledWebApp` / `requiresInstallForPush` /
`needsHomeScreenInstall` in `lib/src/remote/client/push-subscribe.ts`, surfaced
by `InstallFirstNotice` (auth) and `InstallNotice` (Hosts) in
`lib/src/remote/pocket-app/App.tsx`.

Installed means `navigator.standalone === true` (iOS) or the standard
`(display-mode: standalone)` media query. Availability is evaluated in this
order, and every unavailable result is named in the UI:

| Result | Condition | UI consequence |
|---|---|---|
| `needs-install` | `navigator.standalone` exists but the app is not installed; checked before capability probes because iOS tabs omit those APIs. `needsHomeScreenInstall` exports that predicate alone, so the auth gate awaits no push machinery. | Explain Home Screen install above the scan action, and again on the Hosts view; with no prompt API it stays advice — scanning in a tab must still work. |
| `unsupported` | Service workers, `Notification`, or `PushManager` are unavailable after the install gate. | Explain that this browser cannot receive push. |
| `no-worker` | The tracked registration failed or resolved empty, commonly on an insecure origin. | Explain the worker failure. |
| `denied` | Notification permission is denied. | Direct the user to browser settings. |
| `ready` | Worker and APIs exist and permission is not denied. | Offer the registration action. |

**Never parse the user-agent:** iPadOS reports as a Mac; the presence of
`navigator.standalone` is the install-required signal and stays absent on macOS
Safari. **A tab cannot detect the installed app** because their storage
partitions share no signal, so the copy allows for “already installed, wrong
window.”

Because registration is best-effort and asynchronous, both the availability
check and the subscribe path await the tracked registration promise from
`lib/src/remote/pocket-app/service-worker.ts` rather than
`navigator.serviceWorker.ready`, which never settles when registration failed —
that would hang the button the user just tapped.

The Server's VAPID public key is prefetched before Pocket offers Enable. The
config state is explicit (`loading`, `ready`, `disabled`, or `error`): a failed
fetch offers Retry, which only caches the key, and the next tap reveals Enable.
Permission is requested on that separate, fresh tap, because a network round
trip between an iOS user gesture and `Notification.requestPermission()` can
consume the transient activation. Source of truth: the push-config state and
actions in `lib/src/remote/pocket-app/App.tsx`.

Browser availability and Host registration are separate states: a
`PushSubscription` belongs to the service-worker scope, while the Server stores
one row per `(hostId, deliveryId)`.

**Push is asked for once per device, on one card, on the Hosts view.** The
permission prompt and the subscription it mints are scope-wide, so the per-Host
rows are bookkeeping, not something to ask for once each. The card reads
the paired Hosts as a set — **Enable push notifications** while any lacks a row, one
**Push notifications on.** line once all have one — and its tap subscribes the
browser, then registers every paired Host, repairing a rotated endpoint at
once. Each response commits as it lands, so a loop that fails partway keeps what
it registered. **Never offer push from the wall or from a Host
row:** the terminal is what the user tapped Connect to reach. The row states
**Push on** beside its pair state — the only thing that says *which* Host the
card still covers.

Every state the card can be in is one pure predicate over (paired set,
registrations, availability, config); `needs-install` is the one it declines to
render, because `InstallNotice` is the push card for that state and is on screen
exactly then. Source of truth: `pushNoticeState` and `PushNotice` in
`lib/src/remote/pocket-app/App.tsx`.

Which Hosts those are is read from the Server on entering the Hosts list — the
connect neither refetches nor drops it — never locally, so a reload does not
re-offer an action already taken and a row pruned after a 410 stops claiming
push is on. **The readback is by capability, never by identity**:
`POST /api/push/subscriptions/query` presents this browser's own delivery ids
and reports only on those, so there is no read over an input the caller need not
already hold ([server.md](./server.md) → Web Push).
`POST /api/push/subscribe` answers with the same thing — every Host this device
is registered with after the mutation — so both are complete answers, never
deltas: nothing to merge, only which is newer.
One run token drops any read a newer load, or a completed registration, already
overtook. A read in flight or failed never settles at empty on its own behalf:
the card re-offers its idempotent Enable rather than preserving a stale
**Push notifications on.** claim. Source of truth: `getPushAvailability` in
`lib/src/remote/client/push-subscribe.ts`, `PocketClient.listPushSubscribedHosts`,
and the push effect in `lib/src/remote/pocket-app/App.tsx`.

A Server row is necessary but not sufficient for **Push notifications on**.
Pocket also checks that permission is still granted, that the scope holds a
`PushSubscription` minted for the Server's current VAPID key, and that it points
at the registered address; any of the four failing re-exposes Enable rather than
letting a stale row hide the repair path. The Server likewise omits rows under
an old VAPID key, so repairing one Host after a rotation cannot make another's
old endpoint look current.

The endpoint check is the non-obvious one: a push service may rotate an address
on its own with the VAPID key unchanged, so the subscription stays valid and
correctly keyed while every stored row points somewhere unreachable. Pocket
records a SHA-256 digest of the address each time the Server accepts a
registration (`dormouse-pocket:push-endpoint`, beside the `:passkey:` cache)
and compares it on open — a digest, because the endpoint is a
bearer capability and equality is the only question. One key per device, not per
Host: one scope holds one subscription, so if it moves, every Host row for that
device is stale at once. **Absent reads as no opinion, not as a mismatch**, so a
device that registered before this was recorded, or whose storage was cleared,
is not forced to re-register. Source of truth: `hasCurrentPushSubscription` in
`lib/src/remote/client/push-subscribe.ts`, `pushEndpointFingerprint` in
`server-lib-common/src/security/push.ts`, `PocketClient.subscribeToPush`, the
`vapidPublicKey` field in `server/src/state.ts`, and the subscriptions read in
`server/src/app.ts`.

Repair waits for the next app open rather than a `pushsubscriptionchange`
handler in `sw.js`: a worker can open a pinned record but not obtain a session
token, which lives only in
`PocketClient` memory behind a fresh WebAuthn assertion — and
`navigator.credentials` does not exist in a worker. Unattended re-registration
would need a long-lived credential
[remote-security-model.md](./remote-security-model.md) does not grant.

Registering another Host, or retrying that POST, reuses the scope's existing
`PushSubscription` when its `applicationServerKey` matches the Server's VAPID
key byte-for-byte; Pocket mints a new endpoint only when the key differs, since
replacing a matching subscription would invalidate the endpoint already stored
for every other Host. When it does rotate, the Server drops that device's other
Host rows in the same mutation and its response lists what survived — which
makes a committed POST whose response was lost self-repairing: the idempotent
retry cannot re-announce a deletion it already performed, but it can always say
what is registered now.

`subscribeToPushInBrowser` reports that replacement through a *required*
callback, fired the moment the old address stops being valid — before the new
one is minted, so a `subscribe()` that throws cannot take the fact with it
(hence not a return value). Its one job is the UI: Pocket stops claiming
**Push notifications on** for every Host at that instant. Source of truth:
`subscribeToPushInBrowser` in
`lib/src/remote/client/push-subscribe.ts`, `PushSubscriptionStore.upsert` in
`server/src/state.ts`, and `onEnablePush` in
`lib/src/remote/pocket-app/App.tsx`.

**Obsolete delivery mappings are retired, durably.** A `pairing-required`
transition, a re-pair that mints a new id, and an explicit **Remove** each write
the old `{ hostId, deliveryId }` to `PendingDeliveryDeletionV1` *before* the
record forgets it — that id is the only handle that can ever name the row again
— then call the idempotent deletion route. Tombstones retry after sign-in, on
every entry to the Hosts list, and before registering a replacement, and clear
only on a Server answer. **This deletes the delivery row alone** — never the
scope's shared `PushSubscription`, and never another Host's row. Source of
truth: `PocketClient.retirePendingDeletions` / `forgetHost` in
`lib/src/remote/client/pocket-client.ts`.

## What Pocket stores

**One module owns the IndexedDB name, its version, its upgrade, and every open**,
so no two stores can disagree about the version and no caller can leak a
connection past the next upgrade. `dormouse-pocket` is at **v3**: `known-hosts`
(`KnownHostV1`, keyed by `hostId`) and `pending-deletions`
(`PendingDeliveryDeletionV1`, keyed `hostId:deliveryId`). The upgrade is "create
what is absent, drop what is gone", so a phone arriving from v1 or v2 lands in
the same shape and its `device-key` store goes with the protocol that used it —
a key nothing can use is only a credential left lying about.
`navigator.storage.persist()` is requested once before the first write, and
**never throws**: a browser with no storage manager, or one that refuses, gets
ordinary eviction-prone storage, which re-pairing already survives
([remote-security-model.md](./remote-security-model.md) → Client static loss).

**A `KnownHostV1` is this Client's whole authorization state** — the pinned Host
static, the per-Host X25519 private half as a nonextractable `CryptoKey` beside
its raw public point, the paired passkey identifiers, and either
`{ paired, deliveryId }` or `pairing-required`. Only the private half is a key
object: a `NoiseKeyPair` wants the public half as raw bytes, so a second stored
`CryptoKey` would be a structured clone nothing ever reads. `localStorage` holds
only the `:passkey:` cache and the `:push-endpoint` digest — the `:paired:`
markers those records replaced are swept once at boot. Source of truth:
`lib/src/remote/client/pocket-db.ts` and `purgeLegacyPairedMarkers` in
`lib/src/remote/client/pocket-client.ts`.

## Serving the built bundle

Content types need no special-casing: `serveStatic` already answers
`application/manifest+json` for `.webmanifest` and `text/javascript` for
`sw.js`.

Caching is set explicitly, because the build has two kinds of file needing
opposite answers. Vite content-hashes everything it emits into `assets/`, so
those are `immutable` — the name changes when the content does. Everything else
— `index.html` plus the `public/` passthroughs at the root — is `no-cache`:
revalidate before use, not never store. That half is load-bearing, because
`emptyOutDir` deletes the previous build's hashed assets: a browser reusing a
heuristically cached `index.html` does not merely run stale code, it requests
files that no longer exist and fails to boot. Two rules make it hold:

- **The class comes from the request path** (`/assets/` or not), never the
  platform-shaped resolved path. An unhashed file emitted into `assets/`, or an
  overridden `assetsDir`, would silently mislabel it. The header is staged on
  the context *before* `serveStatic` runs, since its `onFound` hook fires after
  the Response is built and cannot add to it.
- **The SPA fallback overrides that staged class, and 404s under `/assets/`.**
  It answers with the shell whatever was asked, and a response's cache policy
  describes the response. The shell is never a useful answer to a subresource
  miss: it stored an HTML body under a hashed-asset URL in the `immutable`
  class, which no reload could revalidate away — so a request during a deploy,
  the exact window this policy exists for, broke the app for good.

Source of truth: `registerPocketServing` in `server/src/app.ts`.

## A backgrounded phone loses its Host session

While a connection is established **and the page is visible**, Pocket sends one
fixed-size keepalive every `E2E_KEEPALIVE_INTERVAL_MS` (30 s) on the Noise
session; hiding the page pauses them, and returning sends one immediately before
resuming the interval. **Hidden means paused, not slowed**: a backgrounded tab
has its timers throttled or suspended outright, so a phone in a pocket must not
promise a liveness it cannot keep.

The Host disposes any session it has not decrypted a Client message on for
`ESTABLISHED_E2E_IDLE_TIMEOUT_MS` (120 s — four intervals;
[remote-security-model.md](./remote-security-model.md) → Host bounds). **A phone
suspended for longer than that comes back to no session**, and reconnecting
costs a fresh Noise handshake and one WebAuthn prompt. That is the price of the
Host being able to reclaim state a hostile relay would otherwise never let it
reclaim.

**Pocket runs the same deadline against its own last send**, before a keepalive
and before every request, and reports host loss when it passes. A reap sends
nothing — there is no frame to send — and this Client's relay socket is to the
*Server*, so it stays open: without this check a returning phone holds a session
the Host has forgotten, every request hangs with no error, and a reload is the
only way out.

Source of truth: `PocketClient.sendKeepalive` / `#reapedByHost` and the injected
timer, clock, and visibility seams in `lib/src/remote/client/pocket-client.ts`.

## An expired session drops to sign-in

Sessions live only in the Server's memory ([server.md](./server.md)), so they
end on their 12h expiry *and* on every Server restart, while the passkey and
paired-host markers in `localStorage` outlive both. Without a way back an
installed Pocket is stuck: no address bar to reload from, and the in-app Refresh
re-sends the same dead token, leaving force-quit as the only escape.

So Pocket treats a dead session as actionable, not reportable: `PocketClient`
clears its in-memory token and throws `SessionExpiredError`; the app tears down
any live adapter and returns to sign-in carrying that message. One passkey
prompt restores the Hosts list, pairing and push registration intact.
Source of truth: `SessionExpiredError` in
`lib/src/remote/client/pocket-client.ts`, handled in `run` in
`lib/src/remote/pocket-app/App.tsx`.

Two details this depends on:

- **The trigger is the session gate specifically**, matched on the shared
  `UNAUTHORIZED_ERROR` from `server-lib-common/src/remote/wire.ts` — a 401 alone
  is ambiguous, since a refused setup token answers 401 too (as
  `SetupTokenInvalidError`), and signing the user out for that would be worse
  than the bug this fixes.
- **A rejected relay upgrade carries no status.** The browser surfaces it as a
  bare `error` event, so `openSocket` asks an authenticated route what happened:
  a 401 there means expiry, anything else leaves it an ordinary socket failure.

## Deployment: same-origin, always

**The Pocket app is always served same-origin with its API.** WebAuthn binds
passkeys to the serving origin, and Chrome's Private Network Access rules are
blocking public-site → private-network fetches — both point the same way. Pocket
holds itself to it by construction — an empty API base and a `wsBase` derived
from `location.origin` — and the Server enforces it: a registration or assertion
whose `clientDataJSON.origin` is not the configured `DORMOUSE_ORIGIN` is
rejected, so a Pocket served anywhere else cannot sign in
([server.md](./server.md)). CORS on `/api/*` is permissive because every route
is gated by a bearer token, the setup password, or a Host-minted setup token;
it is not what upholds this rule. The bundle mounts at the origin **root**,
never under a path prefix: the manifest's `start_url`/`scope`, the worker's
registration scope, and the shell's manifest/icon links are all root-absolute.

One lib-owned bundle, two deployments:

* **Selfhost (shipped):** the Node server serves the bundle
  (`lib/dist-pocket`). Selfhost auth never depends on dormouse.sh existing.
* **SaaS (staged — see [Future](#future)):** CloudFlare serves the static site
  and routes `/api/*` and `/ws/*` to the dynamic backend (CloudFlare proxies
  WebSockets). The same bundle mounts at the site origin; rpId is the site's.
  The dynamic surface is two path prefixes — everything else stays static.

The website keeps its playground and marketing pages fully static in both
worlds and shares all terminal UI through `lib`; it never duplicates Pocket
code.

## Future

1. **Dedupe the composition** — extract the thin wiring shared by the
   website's `PocketTerminalExperience` and the Pocket shell
   (`PocketWall.tsx`) so the two cannot drift. Today each wires
   `MobileTerminalUi` + `MobileWall` independently.
2. **CloudFlare routing** — the SaaS deployment above; deferred until SaaS.
   Nothing in the shipped architecture needs rework for it.
3. **Theme picker in Pocket** — the app restores the persisted theme but
   exposes no picker; add the shared `ThemePicker` (and its theme-debugger
   entry) once its dropdown is phone-friendly.
4. **Onboarding friction** — Pocket carries the phone-side items of the
   **selfhost-onboarding** scope ([server.md](./server.md) `## Future`).
5. **The Pocket worker is built, not copied** — the phone side of stage 6 of
   the **e2e-client-host** scope
   ([remote-security-model.md](./remote-security-model.md) `## Future`).
   `sw.js` moves to a TypeScript source under the Pocket app that imports the
   shared E2E, IndexedDB, and sanitization code, bundled by a second Vite
   config as one classic IIFE with `inlineDynamicImports`, no runtime
   `import`/`export`, no secondary chunk, and the stable unhashed output name
   `dist-pocket/sw.js`, run after the app build with `emptyOutDir: false`.
   Registration stays `register('/sw.js', { scope: '/' })` with no
   `type: 'module'`. The worker decrypts with the pinned record for the
   envelope's `hostId`, re-validates and sanitizes, and shows a generic
   notification on any failure. Production assertions in the Pocket build
   script require exactly one `dist-pocket/sw.js`, classic registration, and no
   top-level imports, exports, dynamic-import loaders, or auxiliary chunks.
