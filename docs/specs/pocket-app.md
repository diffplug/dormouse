# Pocket App Architecture

How the phone client (Dormouse Pocket) is structured and deployed. Companion
to [remote-api.md](./remote-api.md) (the protocol) and
[server.md](./server.md) (the selfhost server).

> See `docs/specs/glossary.md` for Session / Pane vocabulary. This spec uses it
> when naming what a notification or a directory row refers to.

## The seam: the remote session is a platform adapter

`lib` renders every Dormouse surface through a `PlatformAdapter`
(`lib/src/lib/platform/types.ts`). The adapter's PTY core — `writePty`,
`resizePty`, `onPtyData`, `onPtyExit`, plus the `requestInit`/`onPtyList`/
`onPtyReplay` resume path built for VS Code webview reloads — maps one-to-one
onto the remote-api v1 terminal protocol:

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
`FakePtyAdapter` (`website/src/components/PocketTerminalExperience.tsx`).
Source of truth: `lib/src/remote/pocket-app/PocketWall.tsx` composes
`MobileTerminalUi` + `MobileWall` over the remote adapter. One mobile terminal
experience in `lib`, three consumers: the website playground (fake adapter),
the real Pocket (remote adapter), and whatever comes later. Everything not in
the PTY core no-ops or is absent — the interface is designed for capability
degradation.

Pocket hides `MobileWall`'s local Kill affordance: remote panes are
Host-owned, and v1 grants no phone-side kill/layout authority. Closing a local
xterm view without a Host-side close would leave the Host attachment live and
the phone view inconsistent.

Adapter-specific extras (the same pattern as `FakePtyAdapter`'s scenario
controls): the concrete `RemotePtyAdapter` exposes `setActivePane(id)` — the
v1 protocol allows one attachment per session, so pane switching is
detach → attach, and the attach repaint (resize) redraws the screen. Badges
for non-attached panes come from `directory.watch` without attaching.

Pocket's local "paired" host marker is optimistic cache, not authority. When a
connect denial reports an ACL miss (`passkey-not-paired`,
`device-not-paired`, or `pairing-mismatch`), Pocket clears that marker and
shows Pair again so expected Host ACL resets, revocations, or browser
device-key loss recover through the normal pairing ceremony.

## Module layout

```
lib/src/remote/
  client/          the phone side
    pocket-client.ts     UI-free protocol client (auth, pair, connect, msg)
    device-key.ts        non-extractable device key in IndexedDB
    webauthn.ts          navigator.credentials wrappers
    remote-adapter.ts    RemotePtyAdapter (PlatformAdapter over pocket-client)
    push-subscribe.ts    push availability + the browser half of subscribing
  host/            the laptop side (enrollment, approval modal, ACL, bridge)
  pocket-app/      the app shell: auth views + the mobile wall composition
    service-worker.ts    best-effort registration of the push worker

lib/pocket/        the app's HTML shell and its verbatim-copied static assets
  index.html
  public/          manifest, icons, sw.js — see Installable web app below
```

Both the auth views and the wall are themed by the shared VSCode `--color-*`
system ([theme.md](./theme.md)), not a bespoke palette: `restorePocketTheme()`
(`lib/src/remote/pocket-app/pocket-theme.ts`) applies the persisted-or-default
theme to `<body>` in `main.tsx` before first paint, so the auth chrome — built
from the three list pairs — is themed on the first frame. Kimbie Dark is the
default, matching the homepage brand.

The server (`server/`) stays the only dynamic code: accounts, relay, and
static serving of the built Pocket bundle.

## Design system and theming

Pocket is a product surface, not a marketing page: all of it — the auth
screens included — renders on the shared themeable design system
(`--color-*` tokens over `--vscode-*`; [theme.md](./theme.md), `DESIGN.md`).
The website's separate "homepage" design system (`website/src/index.css`) is
never used by Pocket or anything else the server serves. There is no
Pocket-specific palette; changing the theme re-skins the auth screens and
the wall together.

Pocket has no VS Code host and boots into auth long before a Wall exists, so
the app restores the theme itself before first paint: `main.tsx` calls
`restorePocketTheme()` (`lib/src/remote/pocket-app/pocket-theme.ts`) before
the first render, with the Kimbie Dark default; `PocketWall` repeats it
idempotently via `usePocketTheme()` for isolated consumers (stories). The
default is one shared `POCKET_THEME_ID` constant that the website playground
imports, so the playground cannot drift from the real Pocket default.
Restoring also syncs document-level browser chrome that in-app hosts don't
need: `color-scheme` on the root element (native form controls, scrollbars)
and the `<meta name="theme-color">` address-bar tint, taken from the applied
theme's type and resolved `sideBar.background`. The static meta values in
`lib/pocket/index.html` are pre-boot placeholders only.

Phone-specific exceptions to the desktop chrome scale (`DESIGN.md`'s
Two-Step Rule), kept deliberately narrow:

* Form inputs use 16px text: smaller input text triggers iOS zoom-on-focus,
  and 10–12px inputs are illegible at thumb distance.
* Chrome type runs a step larger than desktop (13px body, 11–12px
  secondary), and touch targets are taller: 44px block actions, 36px row
  actions.

The chrome itself follows theme.md's three-pair rule: the page is the app
pair, the header band is the active-header pair (the "titlebar", doubling as
the primary-action tone), and host rows are the inactive-header pair.
Secondary text is alpha on the owning pair's foreground, and presence is
intensity — an offline row drops to `opacity-55`; there is no online badge,
no border, no `surface-raised`, no `muted`. The one status color is
`text-error`, delineated by a red inset hairline for the error notice
(panel-border is transparent in many themes). Source of truth:
`lib/src/remote/pocket-app/App.tsx` (views + the `pkButton`/`PK`
vocabulary), `lib/src/remote/pocket-app/pocket-theme.ts` (theme boot +
browser-chrome sync), `lib/pocket/index.html` (structural viewport rules +
pre-boot color fallbacks).

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

The three static assets live in `lib/pocket/public/` rather than the bundle
because Vite copies `publicDir` verbatim. A service worker must be served from
the scope it controls, under a stable path, with no content hash in its name —
all three of which bundling would break. `emptyOutDir` wipes `lib/dist-pocket`
on every build, so they have to be checked-in source, never dropped into the
output by hand.

- **The worker caches nothing and registers no `fetch` handler.** Pocket is
  useless without a live relay connection, so an offline cache would buy no
  working screens while actively fighting `registerPocketServing`, which
  re-reads `index.html` per request precisely because a rebuild swaps in new
  content-hashed assets. It handles `push` and `notificationclick`, and nothing
  else.
- **A push that cannot be parsed still shows a notification.** Subscribing with
  `userVisibleOnly: true` promises the browser that every delivery becomes
  visible; a browser that catches the worker showing none substitutes its own
  "site updated in the background" notice and counts it against the
  subscription. Malformed and payload-less pushes therefore fall back to generic
  text rather than returning early — even when reading the raw text itself
  throws, which is guarded separately so no payload shape can exit the handler
  without a notification.
- **Payload text is re-bounded at the sink.** The Host already caps and
  sanitizes, but the worker coerces `title`/`body` to bounded single-line
  strings anyway, because the string is Pane-derived and therefore ultimately
  terminal-supplied ([alert.md](./alert.md) -> Text And Security).
- **Registration is best-effort and never awaited.** Every screen works without
  the worker, so a failure warns and boot continues. Failure is ordinary on a
  browser without support and on an insecure origin — service workers need a
  secure context, and only `localhost` is exempt, the same constraint WebAuthn
  imposes below.
- Clicking a notification focuses the app and leaves the user on the directory.
  There is no deep link to an individual Pane, because protocol-v1 carries no
  routable surface ref.

**The installed app is a separate storage partition from the browser tab.** On
iOS, cookies, `localStorage`, and IndexedDB are not shared between Safari and a
Home Screen web app, so the install generates its own device key and is a
*different Client* than the same phone's Safari tab.

Exactly one consequence survives, and it is the security model working as
designed: the install needs **its own pairing approval** on each Host. Signing
in is not enough to reach a machine, and a Client the user has not approved
there must not inherit access
([remote-security-model.md](./remote-security-model.md)).

Signing in *is* enough to ask. `SigninFinishResponse` returns the asserted
passkey's public key, which a Client needs to build pair and connect requests,
so a profile that never performed the registration can still pair. Without it
only the registering browser could — which forced a redundant second passkey on
every new install and was an artifact of the wire, not a property of the trust
model. The key is public: the Host is handed it in every `ConnectionRequest`
anyway, and holding it authorizes nothing.

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

- **Installed** is `navigator.standalone === true` (iOS) or the standard
  `(display-mode: standalone)` media query.
- **Install is required** is the *presence* of `navigator.standalone`, even when
  it is `false`. The property is iOS/iPadOS Safari only and `undefined`
  everywhere else — including macOS Safari, where Web Push works in an ordinary
  tab and an install prompt would be wrong. This deliberately avoids parsing a
  user-agent string, which iPadOS makes unreliable by reporting as a Mac.
- **A tab cannot see whether the app is also installed.** The two have separate
  storage and share no signal, so the install notice necessarily also shows to
  someone who installed it and opened the wrong window; the copy says so rather
  than insisting they install it twice.
- **iOS cannot be prompted.** There is no `beforeinstallprompt` there, so
  installing can only be described, never triggered.
- Every unavailable reason is named in the UI rather than left as a missing
  button — `needs-install`, `no-worker` (registration failed, usually an
  insecure origin), `denied`, `unsupported`. A push that silently never arrives
  should always have a visible cause. `needs-install` is checked before any
  capability probe: in an iOS Safari tab, `Notification` and `PushManager` are
  themselves absent, so probing first would answer `unsupported` when the
  actionable answer is "install".

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
identities and is filtered to this device by `PocketClient`. It is deliberately
not parameterized by `devicePublicKey`: an endpoint answering "which Hosts is
device X registered with" would be an enumeration primitive over an input the
caller need not own, where the account's own rows are already its to read — the
same scoping `GET /api/hosts` uses. The response is authoritative and replaces
the set, except that a registration completed while the read was in flight
wins, since it is the newer fact: Pocket merges the Server snapshot with the
specific Host registrations whose per-Host completion version advanced after
that request began (including a repeated repair of the same Host), while
earlier local ids remain subject to authoritative removal. A failed read leaves
the set empty, which re-offers an idempotent action — the harmless direction to
be wrong in.
Source of truth: `getPushAvailability` in
`lib/src/remote/client/push-subscribe.ts`,
`PocketClient.listPushSubscribedHosts`, and `reconcilePushSubscribedHosts` in
`lib/src/remote/pocket-app/App.tsx`.

The row is necessary but not sufficient for **Alerts on**: Pocket also verifies
that notification permission remains granted and the service-worker scope still
holds a `PushSubscription` minted for the Server's current VAPID key. A missing
subscription, revoked permission, or VAPID rotation therefore exposes Enable
again instead of letting a stale Server row hide the repair path. The Server
also omits rows registered under an old VAPID key, so repairing one Host after a
rotation cannot make the other Hosts' old endpoints look current. Source of
truth: `hasCurrentPushSubscription` in
`lib/src/remote/client/push-subscribe.ts`, the `vapidPublicKey` field in
`server/src/state.ts`, and the subscriptions read in `server/src/app.ts`.

Registering another Host or retrying that POST reuses the service-worker
scope's existing `PushSubscription` when its `applicationServerKey` matches the
Server's VAPID public key byte-for-byte. Pocket unsubscribes and creates a new
endpoint only when the key differs, because replacing a matching subscription
would invalidate the endpoint already stored for every other Host. Source of
truth: `subscribeToPushInBrowser` in
`lib/src/remote/client/push-subscribe.ts`.

The existing static serving needs no special-casing: `serveStatic` already
answers `application/manifest+json` for `.webmanifest` and `text/javascript` for
`sw.js`.

## Deployment: same-origin, always

WebAuthn binds passkeys to the serving origin, and Chrome's Private Network
Access rules are progressively blocking public-site → private-network fetches.
Both point the same way: **the Pocket app is always served same-origin with
its API.** One lib-owned bundle, two deployments:

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
