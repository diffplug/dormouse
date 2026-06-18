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

Stop any running harness with Ctrl-C before starting another one. Do not leave background dev servers running after a timing run.

## Driving Dormouse

Use the outer harness session printed by `dev:standalone:ab`:

```sh
agent-browser --session <outer-session> snapshot -i
agent-browser --session <outer-session> get text body
agent-browser --session <outer-session> screenshot /private/tmp/dormouse.png
```

To type into xterm reliably, focus the hidden xterm textarea:

```sh
agent-browser --session <outer-session> eval 'document.querySelector("textarea.xterm-helper-textarea")?.focus()'
agent-browser --session <outer-session> keyboard type "dor ab open dormouse.sh"
agent-browser --session <outer-session> keyboard type $'\r'
```

`agent-browser press Enter` and `keyboard type "\n"` can fail to submit in this nested setup after `eval` steals focus. Prefer an explicit carriage return after focusing `textarea.xterm-helper-textarea`.

## Timing Pattern

Install a page-local timing probe with `agent-browser eval` before the action under test. Keep it simple:

- record `performance.now()` immediately before command submission or click
- use a `MutationObserver` plus a short interval
- detect browser surface state from DOM titles/text/canvas visibility
- log marks with `console.log("[measure]", ...)`, which the harness mirrors into the terminal

Useful marks:

- `command-enter-start`: immediately before submitting `dor ab open ...`
- `first-visible-canvas`: first visible non-zero canvas frame
- `github-click-start`: immediately before dispatching/clicking the GitHub link
- `github-tab-visible`: when DOM titles/text include `github.com/diffplug/dormouse`
- `two-browser-tabs-visible`: when two browser-tab title attributes are present

For screenshot-backed click targeting:

1. Capture a screenshot.
2. Inspect the canvas bounds:
   ```sh
   agent-browser --session <outer-session> eval 'JSON.stringify(Array.from(document.querySelectorAll("canvas")).map(c => { const r = c.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height, width:c.width, height:c.height }; }))'
   ```
3. Click either with `agent-browser mouse` or by dispatching mouse events to the canvas at the outer-page coordinates.

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

Constant screenshot churn on a static page is suspicious. If logs show hundreds of `screenshot start/done` lines with unchanged tab snapshots, treat that as a likely resource/latency issue and include it in the investigation.

## Validation

After changing the harness, run:

```sh
node --check standalone/scripts/dev-agent-browser.mjs
pnpm --filter dormouse-standalone build
```

If the `dor` command fails inside the staged sidecar with missing package imports, confirm the harness uses:

```js
standalone/sidecar/dor-cli/dist/dor.js
```

not `dist/cli.js`.
