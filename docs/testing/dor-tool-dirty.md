# Tool dirty-indication QC

Branch: `dor-tool-dirty`, stacked on `dor-tool-qc`.

## Scope

Tools report unsaved state with `OSC 367;state;{"v":1,"dirty":true|false}`.
This pass adds indication; save coordination and close protection remain future work.

## Plan

Run source-mutating root tests before starting innerdogfood. Start the real
sidecar/staged CLI in a visible `dor ensure` pane, with an isolated XDG config.
Use `scripts/dor-tool-qc/server.mjs --announce --dirty-controls` as a user Tool.
All credentials and captures stay in the ignored `standalone/src-tauri/target/`
fixture directory and credentials are deleted at shutdown.

| Case | Expected | Result |
| --- | --- | --- |
| Unknown and clean | No dot; neither invents an unsaved report | Pass live: initial unknown and explicit clean both show no dot; tri-state distinction is unit-tested. |
| Dirty / clean updates | Dot updates immediately, accessible name and tooltip “Unsaved changes” | Pass live: 6px dot appears/clears with Tool output; role, label and tooltip verified. |
| Ordinary terminal output | State report never creates Tool identity or dirty chrome | Pass live: identical state output in the plain terminal creates no indicator. |
| Serving | State updates leave URL and browser process intact | Pass live: state-only signal retains page location and entered browser text. |
| Narrow pane | Dirty dot remains outside overflow controls and Kill stays usable | Pass live at 103px: dot remains 6px and outside popup; Kill available inside popup. |
| Minimize / reattach | Door shows the dot; updates while minimized; restored Pane agrees | Pass live: Door updates while minimized; reattached Pane retains state and page input. |
| Command exit / restart | Last dirty report remains on terminal face; new command returns to unknown | Pass live: dirty remains after Ctrl-C on terminal face; keyed restart keeps Surface and clears old state. |
| Live reload / transfer | Ordered replay and volatile transfer retain state; no durable dirty field | Live reload passed; automated tests cover both true/false Workspace transfer, since-mark replay and durable omission. Native-window transfer not exercised live. |
| Malformed output | Invalid type/version, oversized payload, or unknown verb cannot clear state | Pass automated: strict parsing and ordered stream tests retain state on invalid output. |

## Results

- Full `pnpm test` passes, including 3,569 lib tests, 228 standalone frontend tests, and 180 VS Code tests; the root lint/self-tests pass too.
- Library production TypeScript/CSS build and host typechecks pass.
- Protocol/lifecycle review found no actionable issues.
- Local screenshots: `dirty-pane.png` and `dirty-narrow.png` in the ignored fixture directory. `live.json` and `after-restart.json` capture the same Tool identity across its restart.
- The root loopback lint caught the earlier QC server once tracked. Its explicit allowlist entry documents that it is an unshipped generated-content fixture with no file, credential, or command API.

Native host rendering, cold restart, and cross-window transfer were not exercised through this browser harness. Automated coverage checks transfer and reset semantics.

## Cleanup

The fixture Tool was closed and its listener PID verified exited. The harness
was stopped and private CLI credentials deleted.
