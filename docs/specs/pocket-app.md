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

**The auth screen leads with the half this browser can use.** Prior use is
stored passkey material (`PocketClient.hasPriorUse`), re-derived every render so
a half-finished setup retries into whichever half can still work. Without it,
setup — setup password plus passkey label — is unfolded and sign-in secondary,
since a synced passkey can reach a browser that stored nothing. With it, sign-in
leads and setup folds behind the disclosure. **The local record must not lag the
registration, nor outlive a refusal**: `setup` caches the public key between
`registerPasskey` and `finish`, so a lost `finish` answer leaves a browser that
can sign in rather than one minting a second passkey — while a `finish` the
Server *answered* by rejecting clears it, that answer being proof there is
nothing to sign in against. Blocked site data costs persistence, not the visit:
`localStoragePocketStorage` mirrors writes in memory and reads the mirror first,
since that write lands after the credential is already irreversible and a throw
would leave every retry minting an orphan.

**A scanned code outranks that question.** Opened from a Host's QR
([server.md](./server.md) owns the grammar), the screen leads with setup
whatever this browser holds — pointing a camera at the laptop *is* the ask — and
the token replaces the password field rather than joining it. **The hash is read
before the first render and erased in the same act**, parsed or not — an address
bar, a history stack and a screenshot are no place for a live credential — and a
malformed one is ignored rather than reported.

* **Sign-in stays offered** — a synced passkey may be the better path.
* **The token is dropped on every way out of setup** — redeemed, refused, or
  left behind by a sign-in — since its only job is the first passkey; one that
  outlived it would lead a later session expiry into a *second* registration.
* **A refused token is reported, and setup stays unfolded.**
  `SETUP_TOKEN_INVALID_ERROR` — expired, spent, or minted by a since-revoked
  Host — becomes `SetupTokenInvalidError`: its message goes in the alert row and
  the setup password stays on screen, whatever this browser holds. Folding it
  behind a returning browser's disclosure would hide the field the refusal just
  named and remount the typed label away.
* **The nonce lives for the run, never on disk**, riding every `pair` in it:
  only the Host that verified against it spends it, so dropping it on another
  Host's approval would end the ceremony silently, where a spent proof merely
  misses ([remote-security-model.md](./remote-security-model.md) owns what it
  proves).
* **An installed iOS Pocket can never receive a scanned hash** — Camera opens
  Safari, a different partition, and the install launches at its own start URL.
  "Show a fresh code" is no recovery there; the setup password is.

Source of truth: `setup-link.ts` and `SetupOrSignin` in
`lib/src/remote/pocket-app/App.tsx`, and `PocketClient.pair` in
`lib/src/remote/client/pocket-client.ts`.

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

**The Host's ACL picks a row's one action; the local marker is the fallback.**
The Hosts view asks each online Host whether it holds a record for this Client
(`pair-status` — [server.md](./server.md)) and offers Pair alone or Connect
alone, never a Connect that can only fail; offline rows keep the marker. A
denial reporting an ACL miss (`passkey-not-paired`, `device-not-paired`,
`pairing-mismatch`) drops it and relabels the action **Pair again**, so an ACL
reset, revocation, or device-key loss recovers through the ordinary ceremony.
Pairing continues into connecting, so laptop approval lands the phone in a
terminal.

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
36px row actions). Source of truth: `lib/src/remote/pocket-app/App.tsx` (views +
the `pkButton`/`PK` vocabulary), `lib/src/remote/pocket-app/pocket-theme.ts`
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
Home Screen web app, so the install generates its own device key and is a
*different Client* than the same phone's Safari tab.

**The install needs its own pairing approval on each Host** — the one
consequence that survives, and the security model working as designed: signing
in is not enough to reach a machine, and a Client the user has not approved
there must not inherit access
([remote-security-model.md](./remote-security-model.md)).

Signing in *is* enough to ask. `SigninFinishResponse` returns the asserted
passkey's public key, which a Client needs to build pair and connect requests,
so a profile that never registered can still pair instead of minting a redundant
second passkey. Holding that public key authorizes nothing
([remote-security-model.md](./remote-security-model.md) -> Device Keys).
If the cached copy disappears mid-session, Pocket directs the user to sign in
again, and the verified response restores it on any profile. Source of truth:
`PASSKEY_UNAVAILABLE_MESSAGE` and `PocketClient.signin` in
`lib/src/remote/client/pocket-client.ts`.

So the order is: install to the Home Screen **first**, then sign in, approve the
pairing on the machine, and enable push from within it — **and Pocket says so
wherever setup can happen**, above the first-run fields and inside the return
visit's disclosure. That precedes the passkey it warns about, though not the
device key, which `App` mints at boot. A scanned code does not survive the
install either: the installed app launches at `start_url`, which carries no
hash.

Because one phone can hold two Client identities, Pocket names the mode in the
label it suggests at pairing — `Dormouse Pocket (Home Screen)` versus
`Dormouse Pocket (browser)` — so the laptop's approval modal, and the Alarm
settings dialog afterwards, can tell two entries for one phone apart. They
cannot be merged: separate device keys are separate delivery targets. Source of
truth: `deviceLabel` in `lib/src/remote/pocket-app/App.tsx`.

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
| `needs-install` | `navigator.standalone` exists but the app is not installed; checked before capability probes because iOS tabs omit those APIs. `needsHomeScreenInstall` exports that predicate alone, so the auth gate awaits no push machinery. | Explain Home Screen install wherever setup can happen, and again on the Hosts view; with no prompt API it stays advice — setup in a tab must still work. |
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
one row per `(hostId, devicePublicKey)`.

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
push is on.
`GET /api/push/subscriptions` returns the **account's** registrations, filtered
to this device by `PocketClient`. **Never parameterize
that read by `devicePublicKey`** — an enumeration primitive over an input the
caller need not own, where the account's own rows are already its to read (the
scoping `GET /api/hosts` uses). `POST /api/push/subscribe` answers with the same
thing — every Host this device is registered with after the mutation — so both
are complete answers, never deltas: nothing to merge, only which is newer.
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
registration (`dormouse-pocket:push-endpoint`, beside the `:passkey:` and
`:paired:` keys) and compares it on open — a digest, because the endpoint is a
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
handler in `sw.js`: a worker can open the device key (a non-extractable
`CryptoKey` in IndexedDB) but not obtain a session token, which lives only in
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
  is ambiguous, since a wrong setup password and a rejected device signature
  answer 401 too, and signing the user out for those would be worse than the bug
  this fixes.
- **A rejected relay upgrade carries no status.** The browser surfaces it as a
  bare `error` event, so `openSocket` asks an authenticated route what happened:
  a 401 there means expiry, anything else leaves it an ordinary socket failure.

## The device fingerprint on the Hosts screen

The Hosts screen renders this browser's own device-key fingerprint under the
header, from a one-shot effect over `getOrCreateDeviceKey()`. It is not a status
line: the pairing ceremony verifies no assertion
(`docs/specs/remote-security-model.md`, Pairing Ceremony), so the human at the
laptop's approval modal is the control — and the fingerprint that modal shows,
of the key that is *asking*, is uncheckable unless the phone shows it too. Both
ends call the same `pairingFingerprint` helper from `server-lib-common`: an
8-character slice of the base64url public point, past the two near-constant
leading characters.

It renders whenever the key loads, paired or not, so it reads as a property of
this browser rather than a step in a flow; a key that fails to load leaves it
absent, since the pair and connect paths already report that failure. Source of
truth: `HostsView` in `lib/src/remote/pocket-app/App.tsx`.

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
