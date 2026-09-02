# Pairing walkthrough

Drives the self-host setup → pairing story against the **real** Server and the
**real** Host, in real browsers, and leaves every screenshot, log and captured
image behind in one run directory.

The whole loop, in one command: a Server, a Host enrolling through its own form,
a QR on the laptop's screen read by a phone's camera, a passkey, two digits typed
back on the laptop — and then a command typed on the phone whose output the
laptop's filesystem is holding half a second later. Every claim it makes is
checked on the side that cannot fake it: the file the laptop's shell wrote, the
authenticator's own `signCount`, the Host's alert arriving in the phone's session
list.

It is a development tool, not a test. **It is deliberately not wired into
`pnpm test` or any CI workflow**: it wants Chrome, `ffmpeg`, an exclusive
`:3000`, and several minutes.

```sh
node scripts/pairing-walkthrough/run.mjs
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

`--until <step>` stops after the step it names; the default is the last one, so
a bare run does all of it.

| # | Step | What happens |
| --- | --- | --- |
| 1 | `server` | `pnpm dev:pocket-server` with an isolated `DORMOUSE_STATE_DIR`, then waits for `:3000` to answer. |
| 2 | `host` | `pnpm dev:standalone:ab` with `DORMOUSE_REMOTE_CONNECT_SRC` pointed at that Server, then waits for the app's first terminal. → `01-host-booted.png` |
| 3 | `settings` | Clicks the baseboard's Settings button and scrolls to Remote control. → `02-settings-open.png` |
| 4 | `enroll` | Types the server URL, the setup password and the machine name into the real form, submits, and waits for **Connected**. → `03-enroll-form.png`, `04-enrolled.png` |
| 5 | `qr` | Clicks **Set up a phone**, waits for the code, screenshots, crops to the QR, makes a camera-shaped Y4M, and decodes the crop to prove it is legible. → `qr-full.png`, `qr.png`, `qr.y4m`, `invitation-url.txt` |
| 6 | `pocket` | Launches a second, isolated Chrome with the fake camera pointed at `qr.y4m`, attaches with `agent-browser connect <port>`, opens the **plain origin**, and gives the page a CDP virtual authenticator. → `05-pocket-first-run.png` |
| 7 | `code` | Taps **Scan a Host QR**; Pocket's own scanner decodes the fake camera, registers a passkey with the scanned token, signs in, and shows two digits. Reads them, and waits for the Host's modal to open. → `06-scanner.png`, `07-code-screen.png`, `08-host-pairing-modal.png`, `pairing-code.txt` |
| 8 | `terminal` | Types the two digits into the Host's modal and authorizes; waits for Pocket to connect itself and land on the terminal; runs a command from the phone and reads the file it wrote; rings the Host and finds the bell on the phone; then leaves to the Hosts view and connects again. → `09-host-approved.png` … `14-pocket-reconnected.png`, `terminal-proof.txt`, `notify-proof.txt`, `reconnect-proof.txt` |

Everything a later step needs from an earlier one is on `ctx.state` — `server`,
`host`, `hostBrowser`, `pocketBrowser`, `pocketAuth` (the live CDP session
holding the authenticator), `pairingCode`, and `signCount` — or in
`summary.json`.

Per-step milliseconds land in `summary.json`. With warm builds the whole run is
about 15 s, of which the Host's boot is a third and step 8 is under 3 s; a cold
`lib/dist-pocket` adds however long that build takes.

Nothing in step 8 is driven around the product. The digits go into the modal's
own field, the confirm button is clicked while `disabled` is still the modal's to
decide, and **Pocket is never told to connect**: approving on the laptop is what
ends the ceremony, and the phone lands on the terminal by itself
(`lib/src/remote/pocket-app/App.tsx`). A run that had to tap something there
would have found a bug.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--until <step>` | `terminal` | Stop after this step. |
| `--out <dir>` | `$TMPDIR/pairing-walkthrough/<timestamp>` | Run directory. |
| `--skip-build` | off | Reuse `lib/dist-pocket` and `server/dist` instead of rebuilding them. Ignored (with a warning) when either is missing. |
| `--password <pw>` | `walkthrough-hunter2` | `DORMOUSE_SETUP_PASSWORD` for the run. |
| `--machine-name <n>` | `Walkthrough Mac` | The name the Host enrolls under. |
| `--keep` | off | Leave everything running after the last step; Ctrl-C stops it. Useful for poking at a paired pair by hand. |

`--skip-build` skips the Pocket build, so **a change under
`lib/src/remote/pocket-app/` or `lib/src/remote/client/` will not be in the run**
— Pocket is served built from `lib/dist-pocket`. The Host's own webview code
(`lib/src/**`) hot-reloads through Vite either way, and `lib/src/host/**` is
re-staged into the sidecar at every launch.

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
pocket-chrome.log     the Pocket browser's own stdout/stderr
pocket-console.log    everything the Pocket page logged, recorded over CDP
pocket-profile/       the Pocket browser's profile — passkeys, IndexedDB, worker
pairing-code.txt      the two digits Pocket showed
terminal-proof.txt    what the laptop's shell wrote for a command typed on the phone
notify-proof.txt      the same, for the command that also rang the Host
reconnect-proof.txt   the same again, after leaving the wall and connecting back
summary.json          per-step status and timing, plus the run's facts
```

**Every `NN-name.png` has an `NN-name.txt` beside it** holding the page's
visible text at that moment, with anything announced (`role="alert"`,
`aria-live`) repeated under a rule. A pass that critiques the copy a user meets
on this path cannot read a PNG; this is its raw material.

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
- **The Host's browser** — the agent-browser session name carries the run's
  timestamp, so the Host webview's `localStorage` starts empty too. The
  session's Chrome and its daemon are both stopped at teardown (`close` leaves
  the daemon alive, so it is signalled by its pid file, and its config file goes
  with it); `close --all` is never used, because it would take down every other
  agent-browser session on the machine.
- **Pocket's browser** — a Chrome of its own, launched by the harness with
  `--user-data-dir=<run>/pocket-profile`. It has to be a separate browser rather
  than a second tab: this is the *phone*, and its passkeys, its IndexedDB
  records and its service worker are the state the whole ceremony is about. It
  gets its own agent-browser session (`<session>-pocket`), torn down the same
  way.

## Ports

`:3000` is fixed, and the run refuses to start when something else holds it.
Two independent constraints pin it: the Host's allowed relay origins are baked
into `sidecar/remote-host.cjs` at stage time from `DORMOUSE_REMOTE_CONNECT_SRC`,
and Pocket must be same-origin with its own API
([`docs/specs/pocket-app.md`](../../docs/specs/pocket-app.md) → Deployment). The
Host harness's two ports are searched for from `:15540` and passed in, and the
Pocket browser's debugging port from 100 above the second of them.

`localhost`, never `127.0.0.1`: `rpId` is the Server origin's hostname, the
browser checks `clientData.origin` against the configured origin exactly, and
only `localhost` is exempt from WebAuthn's secure-context rule on plain HTTP.

## The Pocket browser

What `agent-browser` cannot do for itself, and how the harness does it instead.
Every line below was probed against `agent-browser` 0.31.1 and Chrome for
Testing 150 rather than assumed:

- **`agent-browser connect <port>` attaches to a Chrome you launched yourself**,
  which is how the Pocket browser gets the flags no `agent-browser` verb exposes.
  `agent-browser --session <s> get cdp-url` then answers the *browser-level*
  `ws://127.0.0.1:<port>/devtools/browser/<id>` endpoint.
- **Which Chrome.** `agent-browser`'s own download
  (`~/.agent-browser/browsers/chrome-<version>`) leads, then the Playwright
  cache, then `/Applications`; `AGENT_BROWSER_CHROME` or `CHROME_PATH` overrides
  the lot, and a run with none of them fails naming everywhere it looked. The
  order is not cosmetic: a Chrome for Testing out of the Playwright cache can
  re-exec itself into whichever bundle `com.google.chrome.for.testing` last ran
  from and then ignore `--remote-debugging-port` outright, which reads as a
  browser that launched and never opened its port.
- **The `qr.y4m` decodes back out of `getUserMedia`.** A page behind
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
  --use-file-for-fake-video-capture=qr.y4m` gets a 640×480 stream whose first
  frame decodes to exactly the string in `invitation-url.txt`.
- **Chrome opens that file at `getUserMedia` time, and re-reads it every
  time.** It need not exist at launch, and rewriting it between two
  `getUserMedia` calls changes what the second one sees — which is what lets the
  `code` step re-capture a rotated QR into a browser that is already up.
- **There is no raw-CDP verb on the CLI**, so the harness keeps a WebSocket of
  its own to the page target — attached before the app is opened, so
  `pocket-console.log` covers the first paint (`agent-browser console` answers
  empty for a browser it merely connected to). The virtual authenticator rides
  the same socket: take the page's `webSocketDebuggerUrl` from
  `http://127.0.0.1:<port>/json/list` and send `WebAuthn.enable` then
  `WebAuthn.addVirtualAuthenticator` over Node's built-in `WebSocket`. Chrome
  accepts that second client while `agent-browser` is still attached. The
  authenticator belongs to the *page target*, so it has to be re-added if the
  flow ever moves to a new tab, and the socket stays open for the whole run —
  Chrome drops the authenticator when the client that added it goes away.
- **Every passkey operation is asserted at the authenticator**, not inferred
  from the screen: `WebAuthn.getCredentials` shows one resident credential whose
  `signCount` has moved. A full run leaves it at **5** — register, sign in, the
  pairing presence proof, and one more for each of the two connections, since a
  connection carries a fresh proof of its own
  ([`docs/specs/remote-security-model.md`](../../docs/specs/remote-security-model.md)
  → Connection). Each step checks the count moved rather than checking its
  value, so an extra prompt somewhere earlier does not read as a pass.

## Proving the terminal

**A file, not the screen.** Both terminals render through WebGL, so neither side
has `.xterm-rows` to scrape — the DOM-scraping recipes silently return nothing
(memory note: `ab-harness-webgl-read-via-files`). So the command typed on the
phone redirects itself into the run directory and moves the file into place when
it is complete, and the harness polls for it: the laptop's own shell writing
`WALKTHROUGH-OK-<id>` and `EXIT=0` is what proves the keystrokes reached a real
PTY and its status came back. `summary.json` keeps the command, its output, and
the Enter → file round trip (`terminal.roundTripMs`, ~220 ms on this machine).

- **Typed the only way a phone can type.** The Type reserve's own focus button,
  then `keyboard inserttext` into the hidden textarea and `press Enter` — a touch
  on the pane is consumed by the touch mode, and every input the terminal creates
  is deliberately unfocusable
  ([`docs/specs/mobile-terminal-ui.md`](../../docs/specs/mobile-terminal-ui.md) →
  Keyboard focus).
- **The Enter is re-sent while the wait runs.** It is the one input here that can
  be dropped, and a spare one lands on an empty prompt.
- **The pane title is the phone-side witness.** The Host derives it from the
  command line and ships it in the directory snapshot, so it is the only place
  Pocket displays something the laptop's shell produced. Recorded as
  `terminal.echoedInPaneTitle`, and weaker than the file — the title truncates.
- **The notification round trip is the same trick.** An OSC 777 rides in front of
  the file write, so its delivery is settled before anything is asserted about
  the screen; then the phone's session list is opened and polled for the row's
  TODO pill and bell, which come from the Host's own alert manager by way of
  `ringing`/`hasTODO` on the directory snapshot. Push is off here, so this is the
  in-session path and the whole of it.

Every control in this step is found **structurally** — the pairing modal by its
`aria-labelledby`, the confirm button as the modal's last, the Hosts row by the
`Remove <label>` accessibility label — because the copy pass that follows is
going to rewrite the strings. The one thing the harness reads *as* copy is the
"N paired" line in the Host's enrolled view.

## The invitation's TTL

A setup code lives `DEFAULT_PAIRING_TTL_MS` (5 min), and the Host's panel mints
a replacement 20s before that. So the capture → scan gap matters, and the `code`
step guards it rather than hoping: it re-reads the URL the panel is showing and,
if it is not the one in `invitation-url.txt`, re-captures — asking for a **New
code** first if the panel has stopped showing one at all. The TTL itself is read
out of `server-lib-common/dist` and recorded as `setupTokenTtlMs`, with the
capture's own timestamp beside it in `summary.json`.

## Known limitations

- **`06-scanner.png` shows an empty viewfinder.** The shot is taken the instant
  the scanner mounts, and behind a fake camera the decode lands under a second
  later — so there is no moment at which the screen is both still the scanner
  and showing a frame. The decode is proved by the code screen, not by this.
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
  ([`docs/specs/server.md`](../../docs/specs/server.md) → Configuration). So the
  Hosts view's card reads *Push notifications are off · This server has push
  notifications disabled* (`13-pocket-hosts.txt`), the alarm settings say no
  device has enabled alerts, and **the whole delivery-keyed push path — Enable,
  the sealed payload, the worker's notification — is untested here.** Only the
  in-session ring is.
- **Nothing on this path is a phone.** The Client is a desktop Chrome at a
  phone-shaped viewport with a virtual authenticator: no real biometrics, no iOS,
  no Home Screen install, and therefore neither the partition warning nor the
  two-scan native-camera story. `needsHomeScreenInstall` is false here, so
  `InstallFirstNotice` and `InstallNotice` never render — they are Storybook
  coverage only.
- **The Host is attended throughout**, since its webview is the focused page.
  Alert behavior that depends on the user having walked away (the inactivity
  timeout, spoken alerts, deferral until quiet) is therefore not exercised.
- **One run at a time.** `:3000` and the agent-browser daemon are both global.
