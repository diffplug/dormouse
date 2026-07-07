# Pocket App Architecture

How the phone client (Dormouse Pocket) is structured and deployed. Companion
to [remote-api.md](./remote-api.md) (the protocol) and
[server.md](./server.md) (the selfhost server).

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
  host/            the laptop side (enrollment, approval modal, ACL, bridge)
  pocket-app/      the app shell: auth views + the mobile wall composition
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
the app restores the theme itself before first paint: `usePocketTheme()`
(`lib/src/remote/pocket-app/pocket-theme.ts`) runs `restoreActiveTheme()`
with the Kimbie Dark default, called at the top of the app component (and
again by `PocketWall`, idempotently). The default is one shared
`POCKET_THEME_ID` constant that the website playground imports, so the
playground cannot drift from the real Pocket default.
Restoring also syncs document-level browser chrome that in-app hosts don't
need: `color-scheme` on the root element (native form controls, scrollbars)
and the `<meta name="theme-color">` address-bar tint, taken from the applied
theme's type and resolved `sideBar.background`. The static meta values in
`lib/pocket/index.html` are pre-boot placeholders only.

Phone-specific exceptions to the desktop chrome scale (`DESIGN.md`'s
Two-Step Rule), kept deliberately narrow:

* Form inputs use `text-base` (16px): smaller input text triggers iOS
  zoom-on-focus, and 10–12px inputs are illegible at thumb distance.
* Touch targets are taller than desktop chrome: block action buttons
  `min-h-11` (44px), row actions `min-h-9`, host rows `min-h-12` — the same
  bump `MobileTerminalUi` already makes for its selector and session rows.

Everything else stays on the shared vocabulary: screens sit on `app-bg`, the
app header is a `header-inactive-bg` bg-shift (no border), host rows echo
`MobileTerminalUi`'s session rows (`surface-raised`, `rounded`), the primary
action uses the active-header pair, and online/offline status is
`success`/`muted` text — no bespoke accent, no hex. Source of truth:
`lib/src/remote/pocket-app/App.tsx` (views),
`lib/src/remote/pocket-app/pocket-theme.ts` (theme boot + browser-chrome
sync), `lib/src/remote/pocket-app/pocket.css` (structural document rules
only — no colors beyond `--color-*` references).

## Deployment: same-origin, always

WebAuthn binds passkeys to the serving origin, and Chrome's Private Network
Access rules are progressively blocking public-site → private-network fetches.
Both point the same way: **the Pocket app is always served same-origin with
its API.** One lib-owned bundle, two deployments:

* **Selfhost (shipped):** the Node server serves the bundle
  (`lib/dist-pocket`). Selfhost auth never depends on dormouse.dev existing.
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
