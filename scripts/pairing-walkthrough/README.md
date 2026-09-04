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

This file is the operator's guide — what to run, what you get, and what it does
not cover. Why each step is done the way it is lives in a comment at the code
that does it: `run.mjs` (the loop and teardown), `steps.mjs` (every step and its
selectors), `ab.mjs` (`agent-browser`), `chrome.mjs` (the Pocket browser),
`cdp.mjs` (the raw CDP socket), `qr.mjs` (pixels), `proc.mjs` (processes/ports).

## Prerequisites

| What | Why |
| --- | --- |
| Node ≥ 22 | Built-in `fetch` and `WebSocket`; no dependencies are installed for this harness. |
| `agent-browser` ≥ 0.31 on `PATH` | Drives both browsers. `agent-browser doctor` if it misbehaves. |
| Chrome / Chromium | `agent-browser install` puts one where it wants it. |
| `ffmpeg` on `PATH` | Every pixel operation: crop, upscale, Y4M. Override with `FFMPEG_BIN`. |
| `pnpm install` already run | The Server, the Host and the QR decoder all come from the workspace. |
| A free `:3000` | Not negotiable — see *Ports* below. The run refuses to start otherwise. |
| Two free ports from `:15540` | The Host harness's Vite server and its dev bridge; picked at startup. |

Every line about `agent-browser` and Chrome here was probed against
`agent-browser` 0.31.1 and Chrome for Testing 150, not assumed.

## Scenarios

`--scenario <name>` picks which ending the run drives: `happy` (the default),
`wrong-code`, `denied`, and `expired-code`. They share the first six steps —
everything up to the scan is the same code on every path — so a scenario is only
ever the last step or two, named for it in *Steps* below, and the differences are
all in what the laptop and the phone say afterwards. What a green run of each
proves is one sentence per scenario in `steps.mjs`, printed at startup and
recorded in `summary.json` as `expect`.

**Every artifact of a scenario other than `happy` is prefixed with the
scenario's name** — screenshots, text captures, logs, proof files — so several
scenarios can share one `--out` without overwriting each other's evidence.

`wrong-code` and `denied` both check an *absence* — that nothing was paired —
which the count cannot show the instant a decision lands, since the section
re-reads its status on a 2 s poll. Each therefore waits a poll cycle out before
believing the count.

`expired-code` never scans anything, so it stops one step short of the others
and its two codes go in through the paste field beside the viewfinder. Both are
the Host's own live code re-issued through the shipped emitter — never by
splicing the fragment, which is positional and carries no field names — so what
the phone refuses is a code that Host could have minted.

## Steps

`--until <step>` stops after the step it names, and must name a step of the
chosen scenario; the default is that scenario's last, so a bare run does all of
it.

| # | Step | What happens |
| --- | --- | --- |
| 1 | `server` | `pnpm dev:server` with an isolated `DORMOUSE_STATE_DIR`, then waits for `:3000` to answer. |
| 2 | `host` | `pnpm dev:standalone:ab` with `DORMOUSE_REMOTE_CONNECT_SRC` pointed at that Server, then waits for the app's first terminal. → `01-host-booted.png` |
| 3 | `settings` | Clicks the baseboard's Settings button and scrolls to Remote control. → `02-settings-open.png` |
| 4 | `enroll` | Types the server URL, the setup password and the machine name into the real form, submits, and waits for **Connected**. → `03-enroll-form.png`, `04-enrolled.png` |
| 5 | `qr` | Clicks **Set up a phone**, waits for the code, screenshots, crops to the QR, makes a camera-shaped Y4M, and decodes the crop to prove it is legible. → `qr-full.png`, `qr.png`, `qr.y4m`, `invitation-url.txt` |
| 6 | `pocket` | Launches a second, isolated Chrome with the fake camera pointed at `qr.y4m`, attaches with `agent-browser connect <port>`, opens the **plain origin**, and gives the page a CDP virtual authenticator. → `05-pocket-first-run.png` |
| 7 | `code` | Taps **Scan a setup code**; Pocket's own scanner decodes the fake camera, registers a passkey with the scanned token, signs in, and shows two digits. Reads them, and waits for the Host's modal to open. → `06-scanner.png`, `07-code-screen.png`, `08-host-pairing-modal.png`, `pairing-code.txt` |
| 8 | `terminal` | Types the two digits into the Host's modal and authorizes; waits for Pocket to connect itself and land on the terminal; runs a command from the phone and reads the file it wrote; rings the Host and finds the bell on the phone; then leaves to the Hosts view and connects again. → `09-host-approved.png` … `14-pocket-reconnected.png`, `terminal-proof.txt`, `notify-proof.txt`, `reconnect-proof.txt` |
| 8′ | `mismatch` | (`wrong-code`) Types the *next* two digits instead, and waits for the panel to report a mismatch; checks the paired count did not move and follows the phone back to its list. → `09-host-mismatch.png`, `10-pocket-mismatch.png` |
| 8′ | `cancel` | (`denied`) Presses the modal's Cancel and waits for the panel to report it; same two checks. → `09-host-cancelled.png`, `10-pocket-cancelled.png` |
| 7′ | `dead-code` | (`expired-code`) Replaces the camera's Y4M with a blank frame, opens the scanner, and pastes the Host's own code re-issued twice — once stamped with a 2023 expiry, once for another origin as well. Waits for the phone's own sentence each time, and checks the two differ. → `06-pocket-expired.png`, `07-pocket-foreign.png` |

Everything a later step needs from an earlier one is on `ctx.state` —
`hostBrowser`, `pocketBrowser`, `pocketAuth` (the live CDP session holding the
authenticator), `serverHandle`, `invitationUrl`, `pairingCode`, and `signCount`
— or in `summary.json`.

Per-step milliseconds land in `summary.json`. With warm builds the whole run is
about 15 s, of which the Host's boot is a third and step 8 is under 3 s; a cold
`lib/dist-pocket` adds however long that build takes.

Nothing in step 8 is driven around the product. The digits go into the modal's
own field, the confirm button is clicked while `disabled` is still the modal's to
decide, and **Pocket is never told to connect**: approving on the laptop is what
ends the ceremony, and the phone lands on the terminal by itself. A run that had
to tap something there would have found a bug.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--scenario <name>` | `happy` | Which ending to drive — see *Scenarios*. |
| `--until <step>` | the scenario's last | Stop after this step. |
| `--out <dir>` | `$TMPDIR/pairing-walkthrough/<timestamp>` | Run directory. |
| `--skip-build` | off | Reuse `lib/dist-pocket` and `server/dist` instead of rebuilding them. Ignored (with a warning) when either is missing. |
| `--machine-name <n>` | `Walkthrough Mac` | The name the Host enrolls under. |
| `--keep` | off | Leave everything running when the run ends — including a failed one, which is when poking by hand is most useful. Ctrl-C stops it. |

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

### Warnings a green run leaves behind

Three, every time. None is a symptom of anything, and a run that lacks them is
not healthier than one that has them.

| Where | What | Why |
| --- | --- | --- |
| `pocket-console.log` | `publicKey.pubKeyCredParams is missing at least one of the default algorithm identifiers: ES256 and RS256` | Deliberate: the verifier is ES256-only, so offering RS256 would mint keys that fail at the first assertion (`lib/src/remote/client/webauthn.ts`). |
| `pocket-console.log`, twice | `Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute` | `@zxing/browser` reading camera frames; not ours to set, and one decode per run is not a performance question. |
| `server.log`, `host.log` | `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] … Command failed with signal "SIGTERM"` | The last line of a clean teardown. `pnpm` reports a SIGTERMed child as a failed script; the harness sent that signal on purpose. |

`summary.json` also carries what only a run can know: the decoded pairing URL
and how much of its TTL was left, the round trip from Enter to the file the
laptop's shell wrote (`terminal.roundTripMs`, ~220 ms here), the Enter-to-bell
time, and the authenticator's `signCount` after each ceremony. `options` holds
what the run chose for itself. The setup password is not among them — the
Server mints its own, and a `--keep` run is signed into by hand with the
`password` in `<run>/server-state/setup-password.json`.

## State isolation

A walkthrough that starts half-enrolled is not a walkthrough, so both sides get
a store of their own. The *why* of each is at the code; what it means for you:

- **Server** — `DORMOUSE_STATE_DIR` is set to `<run>/server-state`, so the
  default `./data` in the repo is neither read nor written.
- **Host** — nothing to set; `standalone/scripts/dev-agent-browser.mjs` already
  uses a per-pid temp directory. The path it picked is in `summary.json` as
  `hostStateDir`.
- **The Host's browser** — a fresh agent-browser session per run, torn down with
  its daemon at the end. `close --all` is never used: it would take down every
  other agent-browser session on the machine.
- **Pocket's browser** — a Chrome of its own under `<run>/pocket-profile`, in its
  own agent-browser session (`<session>-pocket`), torn down the same way. It has
  to be a separate browser rather than a second tab: this is the *phone*, and its
  passkeys, its IndexedDB records and its service worker are the state the whole
  ceremony is about.

## Ports

`:3000` is fixed, and the run refuses to start when something else holds it:
the Host's allowed relay origins are baked into `sidecar/remote-host.cjs` at
stage time, and Pocket must be same-origin with its own API
([`docs/specs/pocket-app.md`](../../docs/specs/pocket-app.md) → Deployment). The
Host harness's two ports are searched for from `:15540` and passed in, and the
Pocket browser's debugging port from 100 above the second of them.

`localhost`, never `127.0.0.1` — WebAuthn's secure-context rule and the `rpId`
the Server derives from its own origin
([`docs/specs/server.md`](../../docs/specs/server.md) → Running it).

Every listener a run starts binds loopback only — the server is pinned with
`DORMOUSE_BIND_HOST=127.0.0.1`, the Host bridge and both Chrome debugging ports
already are, and a step that adds one holds to the same rule
([`docs/specs/server.md`](../../docs/specs/server.md) → Configuration).

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
  it. A `data-` attribute on the product's `QrCode` would retire it.
- **The QR is captured at scale 1**, which is 2–3 pixels per module. That is
  near any decoder's floor, so a crop that misses is retried against a
  nearest-neighbour enlargement (`qr-large.png`) — closer to what a phone camera
  sees than the raw crop is, but worth knowing when a decode gets marginal.
- **Push is off**, because a loopback origin has no routable VAPID subject
  ([`docs/specs/server.md`](../../docs/specs/server.md) → Configuration). So the
  Hosts view's card reads *Push notifications are off · This server has push
  notifications turned off* (`13-pocket-hosts.txt`), the alarm settings say no
  paired phone has push on, and **the whole delivery-keyed push path — Enable,
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
- **The Pocket browser is launched by the harness, not by `agent-browser`.**
  `agent-browser --args` can carry launch flags, so it could be — see the head
  of `chrome.mjs` for what the harness gets by owning the process instead.
- **One run at a time.** `:3000` and the agent-browser daemon are both global.
