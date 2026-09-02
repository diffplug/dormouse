# Pairing walkthrough

Drives the self-host setup → pairing story against the **real** Server and the
**real** Host, in real browsers, and leaves every screenshot, log and captured
image behind in one run directory.

It is a development tool, not a test. **It is deliberately not wired into
`pnpm test` or any CI workflow**: it wants Chrome, `ffmpeg`, an exclusive
`:3000`, and several minutes.

```sh
node scripts/pairing-walkthrough/run.mjs --until qr
```

## Prerequisites

| What | Why |
| --- | --- |
| Node ≥ 22 | Built-in `fetch`; no dependencies are installed for this harness. |
| `agent-browser` ≥ 0.31 on `PATH` | Drives both browsers. `agent-browser doctor` if it misbehaves. |
| Chrome / Chromium | `agent-browser install` puts one where it wants it. |
| `ffmpeg` on `PATH` | Every pixel operation: crop, upscale, Y4M. Override with `FFMPEG_BIN`. |
| `pnpm install` already run | The Server, the Host and the QR decoder all come from the workspace. |
| A free `:3000` | Not negotiable — see *Ports* below. The run refuses to start otherwise. |
| Two free ports from `:15540` | The Host harness's Vite server and its dev bridge; picked at startup. |

## Steps

`--until <step>` stops after the step it names; the default is `qr`, which is
everything stage (a) implements.

| # | Step | What happens |
| --- | --- | --- |
| 1 | `server` | `pnpm dev:pocket-server` with an isolated `DORMOUSE_STATE_DIR`, then waits for `:3000` to answer. |
| 2 | `host` | `pnpm dev:standalone:ab` with `DORMOUSE_REMOTE_CONNECT_SRC` pointed at that Server, then waits for the app's first terminal. → `01-host-booted.png` |
| 3 | `settings` | Clicks the baseboard's Settings button and scrolls to Remote control. → `02-settings-open.png` |
| 4 | `enroll` | Types the server URL, the setup password and the machine name into the real form, submits, and waits for **Connected**. → `03-enroll-form.png`, `04-enrolled.png` |
| 5 | `qr` | Clicks **Set up a phone**, waits for the code, screenshots, crops to the QR, makes a camera-shaped Y4M, and decodes the crop to prove it is legible. → `qr-full.png`, `qr.png`, `qr.y4m`, `invitation-url.txt` |
| 6 | `pocket` | *Stage (b), not implemented.* Launch Chrome with `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=qr.y4m`, attach with `agent-browser connect <port>`, add a CDP virtual WebAuthn authenticator, and register the passkey. All three were probed against `agent-browser` 0.31.1 and work — see *Stage (b) notes* below. |
| 7 | `code` | *Stage (c), not implemented.* Read the two-digit code off Pocket and type it into the Host's pairing modal. |
| 8 | `terminal` | *Stage (c), not implemented.* Run a command from Pocket and observe its output. |

Steps 6–8 exist as named steps whose `run` throws, so adding a stage is filling
one in rather than restructuring the runner. Everything a later step needs from
an earlier one is on `ctx.state` (`server`, `host`, `hostBrowser`) or in
`summary.json`.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--until <step>` | `qr` | Stop after this step. |
| `--out <dir>` | `$TMPDIR/pairing-walkthrough/<timestamp>` | Run directory. |
| `--skip-build` | off | Reuse `lib/dist-pocket` and `server/dist` instead of rebuilding them. Ignored (with a warning) when either is missing. |
| `--password <pw>` | `walkthrough-hunter2` | `DORMOUSE_SETUP_PASSWORD` for the run. |
| `--machine-name <n>` | `Walkthrough Mac` | The name the Host enrolls under. |
| `--keep` | off | Leave the Server and Host running after the last step; Ctrl-C stops them. Useful while writing stage (b). |

## Artifacts

Everything lands in the run directory, whose path is printed at the start and
at the end. **Nothing is written into the repo.**

```
server.log            the Server's whole stdout/stderr
host.log              the dev:standalone:ab harness, sidecar and Vite
01-host-booted.png … one screenshot per UI step
qr-full.png           the Host webview at the moment the QR was measured
qr.png                the QR alone, cropped with a little padding
qr-large.png          only when the raw crop was too small to decode
qr.y4m                640×480 single frame on repeat — Chromium's fake camera
invitation-url.txt    the pairing URL, for cross-checking a later scan
summary.json          per-step status and timing, plus the run's facts
```

## State isolation

A walkthrough that starts half-enrolled is not a walkthrough, so both sides get
a store of their own:

- **Server** — `DORMOUSE_STATE_DIR` is set to `<run>/server-state`. The default
  is `./data` in the repo, which accumulates accounts, hosts and a VAPID keypair
  across runs; a second run would find the Host already enrolled and never show
  the form step 4 exists to drive.
- **Host** — nothing to set. `standalone/scripts/dev-agent-browser.mjs` already
  points the sidecar at a per-pid temp directory, so its enrollment and its ACL
  are fresh every launch. The harness reads the path out of the log and records
  it in `summary.json` as `hostStateDir`.
- **Browser** — the agent-browser session name carries the run's timestamp, so
  the Host webview's `localStorage` starts empty too. The session's Chrome and
  its daemon are both stopped at teardown (`close` leaves the daemon alive, so
  it is signalled by its pid file); `close --all` is never used, because it
  would take down every other agent-browser session on the machine.

## Ports

`:3000` is fixed, and the run refuses to start when something else holds it.
Two independent constraints pin it: the Host's allowed relay origins are baked
into `sidecar/remote-host.cjs` at stage time from `DORMOUSE_REMOTE_CONNECT_SRC`,
and Pocket must be same-origin with its own API
([`docs/specs/pocket-app.md`](../../docs/specs/pocket-app.md) → Deployment). The
Host harness's two ports are searched for from `:15540` and passed in.

## Stage (b) notes

Everything stage (b) needs was probed against `agent-browser` 0.31.1 and Chrome
for Testing 150 before this stage landed, so none of it is speculative:

- **`agent-browser connect <port>` attaches to a Chrome you launched yourself**,
  which is how the Pocket browser gets the flags no `agent-browser` verb exposes.
  `agent-browser --session <s> get cdp-url` then answers the *browser-level*
  `ws://127.0.0.1:<port>/devtools/browser/<id>` endpoint.
- **The `qr.y4m` this stage writes decodes back out of `getUserMedia`.** A page
  behind `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
  --use-file-for-fake-video-capture=qr.y4m` gets a 640×480 stream whose first
  frame decodes to exactly the string in `invitation-url.txt`.
- **There is no raw-CDP verb on the CLI**, so the virtual authenticator needs a
  WebSocket of its own: take the page's `webSocketDebuggerUrl` from
  `http://127.0.0.1:<port>/json/list` and send `WebAuthn.enable` then
  `WebAuthn.addVirtualAuthenticator` over Node's built-in `WebSocket`. Chrome
  accepts that second client while `agent-browser` is still attached. The
  authenticator belongs to the *page target*, so it has to be re-added if the
  flow ever moves to a new tab.

## Known limitations

- **Stages (b) and (c) are not implemented.** `--until pocket` and beyond throw
  with the work they would do.
- **`ffmpeg` and `agent-browser` are assumed present**, not probed for; a
  missing binary surfaces as an `ENOENT` from the step that first needs it.
- **The invitation URL is read off React's fiber.** The panel draws the code and
  nothing else, so there is no text node to read. A miss is not fatal — the run
  falls back to the decoded value and says so in `summary.json`
  (`qr.fromDom: false`) — but it is an internal, and a React upgrade can break
  it.
- **The QR is captured at scale 1**, which is 2–3 pixels per module. That is
  near any decoder's floor, so the decode falls back to a nearest-neighbour
  enlargement (`qr-large.png`) — closer to what a phone camera sees than the raw
  crop is, but worth knowing when a decode gets marginal.
- **Push is off**, because a loopback origin has no routable VAPID subject
  ([`docs/specs/server.md`](../../docs/specs/server.md) → Configuration). Nothing
  in stages (a)–(c) needs it.
- **One run at a time.** `:3000` and the agent-browser daemon are both global.
