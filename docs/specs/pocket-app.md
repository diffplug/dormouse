# Pocket App Architecture

How the phone client (Dormouse Pocket) is structured and deployed. Companion
to [remote-api.md](./remote-api.md) (the protocol) and
[server.md](./server.md) (the selfhost server).

# The seam: the remote session is a platform adapter

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
One mobile terminal experience in `lib`, three consumers: the website
playground (fake adapter), the real Pocket (remote adapter), and whatever
comes later. Everything not in the PTY core no-ops or is absent — the
interface is designed for capability degradation.

Adapter-specific extras (the same pattern as `FakePtyAdapter`'s scenario
controls): the concrete `RemotePtyAdapter` exposes `setActivePane(id)` — the
v1 protocol allows one attachment per session, so pane switching is
detach → attach, and the attach repaint (resize) redraws the screen. Badges
for non-attached panes come from `directory.watch` without attaching.

# Module layout

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

The server (`server/`) stays the only dynamic code: accounts, relay, and
static serving of the built Pocket bundle.

# Deployment: same-origin, always

WebAuthn binds passkeys to the serving origin, and Chrome's Private Network
Access rules are progressively blocking public-site → private-network fetches.
Both point the same way: **the Pocket app is always served same-origin with
its API.** One lib-owned bundle, two deployments:

* **Selfhost (now):** the Node server serves the bundle (`lib/dist-pocket`).
  Selfhost auth never depends on dormouse.dev existing.
* **SaaS (later):** CloudFlare serves the static site and routes `/api/*` and
  `/ws/*` to the dynamic backend (CloudFlare proxies WebSockets). The same
  bundle mounts at the site origin; rpId is the site's. The dynamic surface
  is two path prefixes — everything else stays static.

The website keeps its playground and marketing pages fully static in both
worlds and shares all terminal UI through `lib`; it never duplicates Pocket
code.

# Phases

1. **RemotePtyAdapter + real Pocket UI** — move the protocol modules to
   `remote/client/`, add the adapter, rebuild the Pocket entry as
   auth views + `MobileTerminalUi`/`MobileWall`, delete the bespoke terminal
   UI from the POC. Protocol and server untouched. The fake host harness
   grows a synthetic directory + echo terminal so the adapter is testable
   end-to-end without a real host.
2. **Dedupe the composition** — extract the thin wiring shared by the
   website's `PocketTerminalExperience` and the Pocket shell so the two
   cannot drift.
3. **CloudFlare routing** — deferred until SaaS; nothing in 1–2 needs rework.
