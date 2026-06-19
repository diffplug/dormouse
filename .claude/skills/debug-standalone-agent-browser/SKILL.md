---
name: debug-standalone-agent-browser
description: Use when debugging Dormouse standalone behavior through the browser-based agent-browser harness instead of Tauri. Covers launching a fresh `pnpm dev:standalone:ab` run, observing sidecar and in-browser logs together, driving the UI with `agent-browser`, clearing stale nested browser sessions, and timing agent-browser screencast/tab behavior.
---

# Debug Standalone With Agent Browser

Use this skill when you need to run Dormouse standalone in a normal browser so you can inspect sidecar logs, browser console logs, DOM state, screenshots, and user interactions from the same debugging session.

## Harness

Run from the repo root:

```sh
DORMOUSE_BROWSER_DEV_AB_SESSION=dormouse-debug-$(date +%s) \
DORMOUSE_BROWSER_DEV_VITE_PORT=1550 \
DORMOUSE_BROWSER_DEV_HOST_PORT=1552 \
pnpm dev:standalone:ab
```

The harness:

- stages the `dor` CLI and sidecar proxy
- starts the standalone Node sidecar directly
- starts a localhost HTTP/SSE bridge for browser-side `PlatformAdapter` calls
- starts Vite with `VITE_DORMOUSE_BROWSER_DEV_HOST`
- opens the app in `agent-browser`
- mirrors browser console logs as `[browser log] ...` in the harness terminal

Use unique `DORMOUSE_BROWSER_DEV_AB_SESSION`, Vite port, and host port for repeat runs to avoid stale outer-browser state and port collisions.

## Freshness

Before a measurement, clear any stale nested agent-browser session used by Dormouse surfaces:

```sh
agent-browser --session dormouse.1.default close --all
```

This matters because `dor ab open ...` uses a nested agent-browser session such as `dormouse.1.default`. If it has old tabs, the first stream snapshot can be polluted with stale URLs.

**`close --all` is global, not per-session.** Despite the `--session` flag, it closes *every* agent-browser session — including the outer harness session the app runs in. That is actually the cleanest way to get a fresh blank Dormouse, but you must then re-open the outer session yourself:

```sh
agent-browser --session dormouse.1.default close --all      # clears nested AND outer
agent-browser --session <outer-session> open "http://localhost:<vite-port>/"
```

The first `open` after a `close --all` frequently lands on `about:blank` instead of navigating (the stray-about:blank race). **Issue `open` a second time** and poll until the URL sticks and the xterm input exists:

```sh
agent-browser --session <outer-session> open "http://localhost:<vite-port>/"   # often needed twice
agent-browser --session <outer-session> eval '(()=>(!!document.querySelector("textarea.xterm-helper-textarea")&&location.href.indexOf("<vite-port>")>-1)?"ready":"no")()'
```

Browser console mirroring (`[browser log] ...`) keeps working after a manual re-open, so you don't lose log visibility.

Stop any running harness with Ctrl-C (or `pkill -f dev-agent-browser.mjs`) before starting another one. Do not leave background dev servers running after a timing run.

## Driving Dormouse

Use the outer harness session printed by `dev:standalone:ab`:

```sh
agent-browser --session <outer-session> snapshot -i
agent-browser --session <outer-session> get text body
agent-browser --session <outer-session> screenshot /private/tmp/dormouse.png
```

### Command/mouse subcommands are limited

- `agent-browser keyboard` accepts only `type` and `inserttext` (there is **no** `keyboard press`).
- `agent-browser mouse` accepts only `move`, `down`, `up`, `wheel` (there is **no** `mouse click`).

### Typing into xterm

`keyboard type "..."` simulates per-keystroke events and **reorders characters under load** (you get `dor ab opne dormouse.sh`). Use `keyboard inserttext` (atomic) instead, and always read the input line back to verify before submitting:

```sh
agent-browser --session <outer-session> eval '(()=>{document.querySelector("textarea.xterm-helper-textarea")?.focus();return"f"})()'
agent-browser --session <outer-session> keyboard inserttext "dor ab open dormouse.sh"
# verify the line, then clear with raw Ctrl-U ($'\025') and retype if it is wrong
agent-browser --session <outer-session> eval '(()=>{var r=document.querySelector(".xterm-rows");return r?r.innerText.split("\n").filter(l=>l.trim()).slice(-1)[0]:""})()'
```

### Submitting (Enter)

`keyboard type $'\r'` and `keyboard type "\n"` are **unreliable** here — they frequently fail to submit. The robust submit is a **synthetic `keydown` Enter dispatched to the helper textarea**, and it still sometimes needs a retry, so loop until the command's output appears:

```sh
agent-browser --session <outer-session> eval '(()=>{var ta=document.querySelector("textarea.xterm-helper-textarea");ta.focus();["keydown","keypress","keyup"].forEach(function(t){ta.dispatchEvent(new KeyboardEvent(t,{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true}));});return"enter"})()'
# poll the xterm rows for the expected output (e.g. "A dormouse knows when to wake up"); re-dispatch if absent
```

### eval gotcha

`agent-browser eval` runs in a **persistent context**, so top-level `const`/`let` leak across calls (`Identifier 'r' has already been declared`). **Wrap every eval body in an IIFE** — `(()=>{ ... })()`.

### Clicking a link inside the screencast

The screencast canvas forwards real pointer events to the nested page, and the nested page viewport is **1:1 with the canvas intrinsic size**, so mapping is just an offset:

1. Get the outer canvas box: `agent-browser --session <outer-session> eval '(()=>{var c=document.querySelector("canvas");var r=c.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,iw:c.width,ih:c.height})})()'`
2. Find the link's center in the **nested** session DOM (the real page): `agent-browser --session dormouse.1.default eval '(()=>{var a=[...document.querySelectorAll("a")].find(x=>/github\.com/i.test(x.href));var r=a.getBoundingClientRect();return JSON.stringify({cx:r.x+r.width/2,cy:r.y+r.height/2})})()'`
3. Outer click point = `canvas.x + nested.cx`, `canvas.y + nested.cy`. Click with move → down → up, and **dwell ~0.1–0.2s between down and up** — a too-fast click on an *idle* (quiet) daemon does not register:

```sh
agent-browser --session <outer-session> mouse move <X> <Y>
agent-browser --session <outer-session> mouse down ; sleep 0.12 ; agent-browser --session <outer-session> mouse up
```

Confirm the click landed against the **real** daemon, not just the panel: `agent-browser --session dormouse.1.default tab list`.

## Timing Pattern

Install a page-local timing probe with `agent-browser eval` before the action under test. **Store marks in a global (`window.__M`) and poll it from the shell** — this is more reliable than parsing `[browser log] [measure] ...` mirror lines, and gives you exact deltas. Keep it simple:

- record `performance.now()` into `window.__M.<mark>` at each event
- use a `MutationObserver` plus a short `setInterval` to watch DOM titles/text/canvas
- intercept `console.log` to catch `[ab-panel] tabs msg` and parse its `t` array — that is the precise signal for tab open/resolve (e.g. `t.length>=2`, or an entry matching `github.com`)
- poll with `agent-browser eval '(()=>JSON.stringify(window.__M))()'`

Useful marks:

- `command-enter-start`: immediately before submitting `dor ab open ...`
- `first-visible-canvas`: first visible non-zero canvas frame
- `page-title-loaded`: a `[title]` attribute equals the page's real `<title>`
- `github-click-start`: immediately before clicking the GitHub link
- `tabs-two`: first `[ab-panel] tabs msg` whose `t` array has ≥2 entries
- `tabs-github-resolved`: first tab entry whose URL is `github.com/diffplug/dormouse`

Caveats that corrupt timings:

- **Set `cmd-enter-start` atomically inside the same eval that dispatches the synthetic Enter** (zero skew). Because submitting often needs retries, do **not** naively reset the start mark each retry — a stale/overwritten `cmdStart` yields nonsense deltas (e.g. tens of seconds). Only count marks that fire after the *successful* submit.
- The shell→`mouse down`/`up` round-trip adds ~100–150 ms; a click-to-tabs number measured this way is an upper bound.

For click targeting, see **Clicking a link inside the screencast** above (1:1 canvas→page mapping; locate the link via the nested session DOM).

## What To Watch

In the harness terminal, correlate:

- `[sidecar] ...` for sidecar behavior
- `[browser log] [ab-panel] connecting stream ...`
- `[browser log] [ab-panel] tabs msg ...`
- `[browser log] [agent-browser] screenshot start/done ...`
- `[browser log] [measure] ...`

For a clean `dor ab open dormouse.sh`, the first tab snapshot should look like one active tab:

```text
[ab-panel] tabs msg {"t":["t1:A:https://dormouse.sh/"]}
```

If the first snapshot already contains GitHub or multiple Dormouse tabs, clear the nested session and rerun.

### Static-page screenshot churn (diagnosed + fixed)

A *static* page should produce **zero** `screenshot start/done` and **zero** `tabs msg` once it settles. If you see them repeating (~20/sec) with unchanged tab snapshots, that is the known churn bug.

Root cause: the external agent-browser **daemon re-broadcasts the current frame and tab list on a ~20Hz heartbeat even when nothing changes**. Each forwarded frame triggers a device-resolution screenshot — *a child-process spawn* (`agent-browser screenshot`) — which pokes the daemon into emitting again: a self-perpetuating feedback loop. Each redundant `tabs` message also forces a `setTabs` React re-render.

Fix (in `lib/src/components/wall/agent-browser-connection.ts`): drop **byte-identical** frame and tab re-broadcasts (djb2 hash of the payload) before emitting `frame-pulse` / `tabs`, resetting the dedupe sentinels on reconnect. A genuine change (animation, navigation, new/closed/focused tab, title) alters the bytes and flows through. See `agent-browser-connection.test.ts` for the dedupe + reconnect-reprime tests.

**Regression check:** open `dormouse.sh`, let it settle ~4s, then over 10s of idle confirm `grep -c "screenshot start"` and `grep -c "tabs msg"` are both **0**. To re-measure the daemon's raw vs. forwarded rate, temporarily add a 2s-window counter in the connection (count frames/tabs seen vs. dropped-as-duplicate) — on a static page it reads ~39 seen / 39 dropped per 2s before the dedupe takes effect.

## Validation

After changing the harness, run:

```sh
node --check standalone/scripts/dev-agent-browser.mjs
pnpm --filter dormouse-standalone build
```

After changing webview/lib code under `lib/src` (e.g. the agent-browser connection, panel, or screenshot loop), run from `lib/`:

```sh
npx tsc --noEmit -p tsconfig.json
npx vitest run src/components/wall          # whole wall suite, or the specific *.test.ts
```

`lib/src` is served to the standalone app directly via a Vite alias (`dormouse-lib` → `lib/src`), so these changes hot-reload — re-open the outer session to pick them up, no sidecar rebuild needed. (Only host-side code bundled into the sidecar, e.g. `agent-browser-host.ts`, needs a sidecar rebuild + restart.)

If the `dor` command fails inside the staged sidecar with missing package imports, confirm the harness uses:

```js
standalone/sidecar/dor-cli/dist/dor.js
```

not `dist/cli.js`.
