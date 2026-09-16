# Dor Tool innerdogfood QC

Branch: `dor-tool-qc`, based on the reviewed stack at `4c7f9012`.

## Harness and isolation

Run source-mutating root self-tests before starting the live harness. Run
`pnpm innerdogfood` in a visible `dor ensure` pane. Use its real sidecar,
PTYs, staged CLI, and browser UI through `dor ab`. Keep fixture files, captured
inner CLI credentials, and the separate XDG user config under this worktree's
ignored `standalone/src-tauri/target/dor-tool-qc/` directory. Never use the
installed application's configuration or trust records. Capture credentials
only to a mode-0600 local file; do not include them in reports.

## Test plan

| Area | Exercise | Expected result | Result |
| --- | --- | --- | --- |
| Boot and flag | Start harness; run Tool with flag off, then enable it | Clear disabled error; healthy terminal and CLI after enable | Pass: disabled rejection, then real PTY and Tool startup; disabling later preserves existing Tools. |
| Project trust | Invoke named Tool; repeat pending invocation; decline, then allow folder | No execution before approval; pending dedupes; decline records nothing; approved command serves | Pass: pending deduplication, decline/re-prompt, folder-only approval, failure without PTY, repair and Retry. |
| Inputs | argv with spaces, quotes, dollar signs; canonical target and symlink | Exact argument values; no shell expansion; canonical file identity | Pass: literal shell metacharacters survive; symlink resolves to canonical target and reuse key. |
| Identity | Keyed live reuse, concurrent invocations, `--fresh`, idle restart | One keyed live process; fresh splits; restart keeps Surface/ref | Pass: three concurrent invocations reuse one live Tool; fresh splits; idle and fast-command restarts retain ref. |
| Takeover | Type standalone `dor tool` at a plain prompt; compare compound line and `dor open` | Eligible Tool retains terminal/ref; other paths split | Pass: standalone Tool takes over; compound command and standalone open create separate Tools. |
| Serving | Automatic single port, multiple-port conflict, announced port/path | Only owned ports frame; conflict explains refusal; announcement resolves it | Pass: automatic single port; three-port conflict; OSC announcement resolves the conflict. |
| File dispatch | Ordered user rules, explicit handler, malformed config, project rule isolation | Correct user handler; useful errors; project config cannot intercept opens | Pass: first matching user rule, explicit override, malformed user errors; malformed/project associations do not intercept opens. |
| Built-in viewer | Text/Markdown, HTML+CSS+image, image/audio; awkward filename | Correct content, relative assets load, filename is one argument | Pass: text/Markdown source, HTML/CSS/image, SVG, audio and awkward names. |
| Rejection/bounds | URL, directory, missing/unsupported file, oversized text | Clear errors and no leaked Tool/process | Pass: URL/directory/missing/unsupported rejected; oversized text reports 8 MiB limit and exits. |
| UI and lifecycle | Narrow approval, Terminal Context, minimize/reveal, browser exit/refocus, renderer swap | Reachable controls; same Session; input reaches terminal after exit | Pass: approval at 249×203, same-session context, minimize/reveal state, exit/refocus, narrow popup Zoom/Unzoom/Display focus, and iframe↔screencast round trip. |
| Workspace/reload | Live page reload, move serving Tool, cross-Workspace identity | State/PTY survive live reload; scoped reuse and correct movement | Pass: live reload preserves IDs/kinds/URLs; cross-Workspace identity is scoped. Tool transfer was not exercised; native-window transfer is unavailable in this harness. |
| Cleanup/regression | Close owned Tools, verify listeners retire; rerun affected tests/builds | No orphan fixture servers; fixes covered and retested live | Pass: all final viewer PIDs exited on close; both owned harness runs stopped. Full suite/build and final affected-package suites pass. |

## Findings and evidence

### Narrow browser and Tool headers

At a 103-pixel pane width, header controls extended into the neighboring pane;
Zoom could not be clicked. The original breakpoints measured the viewport.
The fix measures available header width and exposes overflow controls in a
keyboard-accessible popup. Real clicks also exposed premature popup dismissal
before the selected action ran; dismissal now waits until that action completes.
The clean-harness native-click retest passes: Zoom reaches 716×403 pixels, Unzoom returns to the compact header, Reload works, and Display retains modal focus. Header buttons remain inside every pane at the final 1200×800 viewport. Regression coverage lives in
`lib/src/components/wall/SurfacePaneHeader.test.tsx` and narrow header stories.

### PDFs require a user Tool

A valid one-page PDF showed Chromium's broken-document icon in the normal
sandboxed iframe. PDFs now require a configured user Tool, per the selected
product behavior. The bundled renderer, dependency, assets and build plumbing
have been removed. Regression tests cover default rejection, explicit
`builtin:file` rejection, user associations, explicit user handlers, and
source-like names such as `README.pdf` and `LICENSE.PDF`.

### Evidence and limits

Local screenshots and JSON observations are in the ignored
`standalone/src-tauri/target/dor-tool-qc/` directory. Useful before-fix images:
`html.png`, `pdf-zoom.png`; the diagnostic PDF image is `pdf-diagnostic.png`.
`approval-error.png` captures the persisted error with no PTY. Reload snapshots
are `before-reload.json` and `after-reload.json`. Captured CLI credentials are
private runtime artifacts, not report material.

Native Tauri/VS Code rendering, native-window transfer, and Windows shell
behavior are outside this browser harness's direct coverage. The tests use the
real standalone sidecar, staged CLI, PTYs, and iframe proxy.

### Review and automated checks

- Full `pnpm test` and `pnpm build` passed during the original QC run. PDF-policy follow-up validation is recorded below.
- Focused header/Tool/iframe/Wall coverage: 139 tests pass.
- PDF-policy follow-up: all 168 dor tests and 20 host dispatch/proxy tests pass; spec and public-doc lints pass. Both host CLI staging directories contain no PDF renderer assets.
- An unexpected development-state reset occurred while the full build/test suite ran beside the harness: Tools appeared as terminals. Investigation confirmed `e2e-lint-selftest` temporarily mutates Vite inputs, including invalid root package JSON; the exact metadata-loss trigger was not captured. A clean harness restart restored normal operation. The final stable-build reload preserved every ID, kind, URL and Workspace (`final-before-reload.json` / `final-after-reload.json`). No claim of cold-restore or native-host coverage is made from the disturbed development reload.

## Cleanup

The four final viewer processes exited after their verified Tool Surfaces were
killed; `cleanup-result.json` records the check. Earlier closed fixture listeners
also exited, and both QC harness processes were stopped. Private connection
captures were deleted after shutdown. Screenshot and result artifacts remain
ignored locally for inspection.
