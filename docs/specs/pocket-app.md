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

— the exact composition the website playground already proves out with
`FakePtyAdapter` (`website/src/components/PocketTerminalExperience.tsx`). The
composition itself, and its other consumers, belong to
[mobile-terminal-ui.md](./mobile-terminal-ui.md).

Three phases, one component: `SetupOrSignin` (passkey sign-in, with first-time
setup — the server's setup password plus a passkey label — behind a
disclosure), `HostsView`, then `ConnectedView` wrapping `PocketWall`. Source of
truth: `lib/src/remote/pocket-app/App.tsx`, and
`lib/src/remote/pocket-app/PocketWall.tsx`, which composes `MobileTerminalUi` +
`MobileWall` over the remote adapter. Everything outside the PTY core no-ops or
is absent — the interface is designed for capability degradation (`getCwd` →
null, shells/clipboard empty, alerts inert, `alertAwait` settling `cancelled`
rather than handing back a promise that never resolves).

**Pocket hides `MobileWall`'s local Kill affordance** (`showKillButton={false}`)
— remote panes are Host-owned, and v1 grants no phone-side kill/layout
authority. Closing a local xterm view without a Host-side close would leave the
Host attachment live and the phone view inconsistent.

Adapter-specific extras (the same pattern as `FakePtyAdapter`'s scenario
controls): the concrete `RemotePtyAdapter` exposes `setActivePane(id)` — the
v1 protocol allows one attachment per session, so pane switching is
detach → attach, and the attach repaint (resize) redraws the screen. Writes and
resizes for a non-attached pane are dropped, since the Host rejects them
anyway. Badges for non-attached panes come from `directory.watch` without
attaching.

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
Pairing continues into connecting, so approval on the laptop lands the phone in
a terminal.

## Design system and theming

Pocket is a product surface, not a marketing page: **all of it — the auth
screens included — renders on the shared themeable design system** (`--color-*`
tokens over `--vscode-*`; [theme.md](./theme.md), `DESIGN.md`), never the
website's separate "homepage" system (`website/src/index.css`). There is no
Pocket-specific palette; changing the theme re-skins the auth screens and the
wall together.

Pocket has no VS Code host and boots into auth long before a Wall exists, so it
restores the theme itself before first paint: `main.tsx` calls
`restorePocketTheme()` (`lib/src/remote/pocket-app/pocket-theme.ts`) before the
first render, defaulting to Kimbie Dark (the homepage brand theme); `PocketWall`
repeats it idempotently via `usePocketTheme()` for isolated consumers (stories).
The default is one shared `POCKET_THEME_ID` constant the website playground
imports, so the playground cannot drift from it. Restoring also syncs
document-level browser chrome no in-app host needs: `color-scheme` on the root
element (native form controls, scrollbars) and the `<meta name="theme-color">`
address-bar tint, from the applied theme's type and resolved
`sideBar.background`. The static meta values in `lib/pocket/index.html` are
pre-boot placeholders only.

The chrome draws only on theme.md's three list pairs — page = app, header band =
active-header (the "titlebar", doubling as the primary-action tone), host rows =
inactive-header — with secondary text as alpha on the owning pair's foreground
and presence as intensity: an offline row drops to `opacity-55`, with no online
badge, border, `surface-raised`, or `muted`. The one status color is
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
sets `display: standalone` (iOS ignores any other value for this purpose) and
why permission must be requested from a real user gesture. Adding to the Home
Screen is a manual step that cannot be automated or prompted for. iOS also
ignores the manifest's `icons` and honors only `apple-touch-icon`, so
`lib/pocket/index.html` declares both.

The manifest, the icons, and `sw.js` live in `lib/pocket/public/` rather than the
bundle because Vite copies `publicDir` verbatim: every one of them is referenced
by an absolute root path, and a service worker in particular must be served from
the scope it controls, under a stable name with no content hash — all of which
bundling would break. `emptyOutDir` wipes `lib/dist-pocket` on every build, so
they have to be checked-in source, never dropped into the output by hand.

- **The worker caches nothing and registers no `fetch` handler.** Pocket is
  useless without a live relay connection, so an offline cache would buy no
  working screens while actively fighting `registerPocketServing`, which
  re-reads `index.html` per request precisely because a rebuild swaps in new
  content-hashed assets. It handles `push` and `notificationclick`, plus
  `install`/`activate` to take over immediately (`skipWaiting` + `clients.claim`,
  which cost nothing when there is no cache to migrate), and nothing else.
- **A push that cannot be parsed still shows a notification.** Subscribing with
  `userVisibleOnly: true` promises the browser that every delivery becomes
  visible; a browser that catches the worker showing none substitutes its own
  "site updated in the background" notice and counts it against the
  subscription. Malformed and payload-less pushes therefore fall back to generic
  text rather than returning early — even when reading the raw text itself
  throws, which is guarded separately so no payload shape can exit the handler
  without a notification. `title`/`body` are re-bounded at this sink because the
  string is ultimately terminal-supplied ([alert.md](./alert.md) -> Push
  notifications, which owns the sanitizing rule the worker mirrors).
- **Registration is best-effort and never awaited.** Every screen works without
  the worker, so a failure warns and boot continues. Failure is ordinary on a
  browser without support and on an insecure origin — service workers need a
  secure context, and only `localhost` is exempt, the same constraint WebAuthn
  imposes (Deployment, below).
- Clicking a notification focuses the app and leaves the user on the directory.
  There is no deep link to an individual Pane, because protocol-v1 carries no
  routable surface ref.

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
so a profile that never performed the registration can still pair rather than
being pushed into a redundant second passkey. Holding that public key authorizes
nothing ([remote-security-model.md](./remote-security-model.md) -> Device Keys).
If the cached copy disappears mid-session, Pocket directs the user to sign in
again, and the verified response restores it on any profile. Source of truth:
`PASSKEY_UNAVAILABLE_MESSAGE` and `PocketClient.signin` in
`lib/src/remote/client/pocket-client.ts`.

So the order is: install to the Home Screen **first**, then sign in, approve the
pairing on the machine, and enable alerts from within it.

Because one phone can hold two Client identities this way, Pocket names the mode
in the label it suggests at pairing — `Dormouse Pocket (Home Screen)` versus
`Dormouse Pocket (browser)` — so the person approving on the laptop, and the
Alarm settings dialog afterwards, can tell two entries for one phone apart. They
cannot be merged: separate device keys are separate delivery targets. Source of
truth: `deviceLabel` in `lib/src/remote/pocket-app/App.tsx`.

### Detecting install state, and what cannot be detected

Source of truth: `isInstalledWebApp` / `requiresInstallForPush` in
`lib/src/remote/client/push-subscribe.ts`, surfaced by the notices in
`lib/src/remote/pocket-app/App.tsx`.

Installed means `navigator.standalone === true` (iOS) or the standard
`(display-mode: standalone)` media query. Availability is evaluated in this
order, and every unavailable result is named in the UI:

| Result | Condition | UI consequence |
|---|---|---|
| `needs-install` | `navigator.standalone` exists but the app is not installed; checked before capability probes because iOS tabs omit those APIs. | Explain Home Screen install; iOS has no prompt API. |
| `unsupported` | Service workers, `Notification`, or `PushManager` are unavailable after the install gate. | Explain that this browser cannot receive alerts. |
| `no-worker` | The tracked registration failed or resolved empty, commonly on an insecure origin. | Explain the worker failure. |
| `denied` | Notification permission is denied. | Direct the user to browser settings. |
| `ready` | Worker and APIs exist and permission is not denied. | Offer the Host-specific registration action; this does not mean any Host is registered yet. |

**Never parse the user-agent:** iPadOS reports as a Mac; the presence of
`navigator.standalone` is the install-required signal and stays absent on macOS
Safari. **A tab cannot detect the installed app** because their storage
partitions share no signal, so the copy allows for “already installed, wrong
window.”

Because registration is best-effort and asynchronous, both the availability
check and the subscribe path await the tracked registration promise from
`lib/src/remote/pocket-app/service-worker.ts` rather than
`navigator.serviceWorker.ready`, which never settles when registration failed —
that would hang the button the user just tapped, with no way out.

The Server's VAPID public key is also prefetched before Pocket offers Enable
alerts. The config state is explicit (`loading`, `ready`, `disabled`, or
`error`): a failed fetch offers Retry, which only caches the key, and a
successful retry then reveals Enable. Permission is requested on that separate,
fresh tap, because putting a network round trip between an iOS user gesture and
`Notification.requestPermission()` can consume the transient activation.
Source of truth: the push-config state and actions in
`lib/src/remote/pocket-app/App.tsx`.

Browser availability and Host registration are separate states. A
`PushSubscription` belongs to the service-worker scope, while the Server stores
one row per `(hostId, devicePublicKey)`. An existing browser subscription
therefore leaves Enable alerts available for every Host that has not completed
registration; only a successful `POST /api/push/subscribe` changes that Host's
copy to Alerts on.

Which Hosts those are is read back from the Server when the Hosts view opens,
not remembered locally, so a reload does not re-offer an action already taken
and a row pruned after a 410 stops claiming alerts are on. The read is
`GET /api/push/subscriptions`, which returns the **account's** registrations as
identities and is filtered to this device by `PocketClient`. **Never
parameterize that read by `devicePublicKey`** — it would be an enumeration
primitive over an input the caller need not own, where the account's own rows
are already its to read (the same scoping `GET /api/hosts` uses).
`POST /api/push/subscribe` answers with the same thing — every Host this device
is registered with after the mutation — so both answers are complete and neither
is a delta: nothing to merge, only the question of which is newer. Pocket counts
completed registrations, captures that count when a read begins, and discards
the read's snapshot if a registration overtook it; it also clears the previous
snapshot at the start of a read, so a failed read re-offers an idempotent action
instead of preserving a stale **Alerts on** claim. Source of truth:
`getPushAvailability` in `lib/src/remote/client/push-subscribe.ts`,
`PocketClient.listPushSubscribedHosts`, and the hosts-phase effect in
`lib/src/remote/pocket-app/App.tsx`.

A Server row is necessary but not sufficient for **Alerts on**. Pocket also
checks that permission is still granted, that the scope still holds a
`PushSubscription` minted for the Server's current VAPID key, and that it still
points at the address actually registered; any of the four failing re-exposes
Enable rather than letting a stale row hide the repair path. The Server likewise
omits rows registered under an old VAPID key, so repairing one Host after a
rotation cannot make another Host's old endpoint look current.

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

Repair is deferred to the next app open rather than handled by a
`pushsubscriptionchange` handler in `sw.js`: a worker can open the device key (a
non-extractable `CryptoKey` in IndexedDB) but cannot obtain a session token,
which lives only in `PocketClient` memory and is minted solely behind a fresh
WebAuthn assertion — and `navigator.credentials` does not exist in a worker.
Re-registering unattended would need a long-lived credential
[remote-security-model.md](./remote-security-model.md) does not grant.

Registering another Host, or retrying that POST, reuses the scope's existing
`PushSubscription` when its `applicationServerKey` matches the Server's VAPID
key byte-for-byte; Pocket unsubscribes and mints a new endpoint only when the
key differs, because replacing a matching subscription would invalidate the
endpoint already stored for every other Host. When it does rotate, the Server
drops that device's other Host rows in the same mutation and its response lists
what survived — which is what makes a committed POST whose response was lost
self-repairing: the idempotent retry cannot re-announce a deletion it already
performed, but it can always say what is registered now.

`subscribeToPushInBrowser` reports that replacement through a *required*
callback, fired the moment the old address stops being valid — before the new
one is minted, so a `subscribe()` that throws cannot take the fact with it,
which is why it is not a return value. Its one job is the UI: Pocket stops
claiming **Alerts on** for every Host at that instant. Source of truth:
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
revalidate before use, not never store. Revalidating that half is the
load-bearing part, because `emptyOutDir` deletes the previous build's hashed
assets, so a browser reusing a heuristically cached `index.html` does not merely
run stale code — it requests files that no longer exist, and the app fails to
boot. Two rules make it hold:

- **The class comes from the request path** (`/assets/` or not), never the
  resolved file path, which is platform-shaped. If Vite ever emits an unhashed
  file into `assets/`, or `assetsDir` is overridden, that test silently
  mislabels it. The header is staged on the context *before* `serveStatic` runs,
  since its `onFound` hook fires after the Response is built and cannot add to
  it.
- **The SPA fallback overrides that staged class, and 404s under `/assets/`.**
  It answers with the shell whatever was asked for, and a response's cache
  policy describes the response. The shell is never a useful answer to a
  subresource miss: serving it stored an HTML body under a hashed-asset URL in
  the `immutable` class, which no reload could revalidate away — so a request
  made during a deploy, the exact window this policy exists for, broke the app
  permanently.

Source of truth: `registerPocketServing` in `server/src/app.ts`.

## An expired session drops to sign-in

Sessions live only in the Server's memory ([server.md](./server.md)), so they
end on their 12h expiry *and* on every Server restart, while the passkey and the
paired-host markers in `localStorage` outlive both. Without a way back an
installed Pocket is stuck: there is no address bar to reload from and the in-app
Refresh re-sends the same dead token, leaving force-quitting as the only escape.

So Pocket treats a dead session as actionable rather than reportable:
`PocketClient` clears its in-memory token and throws `SessionExpiredError`, and
the app tears down any live adapter and returns to the sign-in screen carrying
that message. One passkey prompt then restores the Hosts list with pairing and
push registration intact. Source of truth: `SessionExpiredError` in
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
of the key that is *asking*, is a value nobody can check unless the phone shows
it too. Both ends call the same `pairingFingerprint` helper from
`server-lib-common` — an 8-character slice of the base64url public point, taken
past the two near-constant leading characters.

It renders whenever the key loads, paired or not, so it reads as a property of
this browser rather than a step in a flow. A key that fails to load leaves it
absent rather than erroring: the pair and connect paths already report that
failure. Source of truth: `HostsView` in `lib/src/remote/pocket-app/App.tsx`.

## Deployment: same-origin, always

**The Pocket app is always served same-origin with its API.** WebAuthn binds
passkeys to the serving origin, and Chrome's Private Network Access rules are
progressively blocking public-site → private-network fetches — both point the
same way. Pocket holds itself to it by construction — an empty API base and a
`wsBase` derived from `location.origin` — and the Server enforces it: a
registration or assertion whose `clientDataJSON.origin` is not the configured
`DORMOUSE_ORIGIN` is rejected, so a Pocket served anywhere else cannot sign in
at all ([server.md](./server.md)). CORS on `/api/*` is permissive because every
route is gated by a bearer token or the setup password; it is not what upholds
this rule. The bundle also mounts at the origin **root**, never under a path
prefix: the manifest's `start_url`/`scope`, the worker's registration scope, and
the shell's manifest/icon links are all root-absolute.

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
4. **Onboarding friction** — Pocket's share of the **selfhost-onboarding**
   scope ([server.md](./server.md) `## Future`): the first-run setup lead,
   install-gate placement, the post-connect push prompt, and the QR setup
   entry point.
