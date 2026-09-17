# Dor Tool innerdogfood QC recipe

Use this fixture with the current contracts in `docs/specs/dor-tool.md` and
`docs/specs/layout.md`. Historical September 2026 results and coverage limits
live in `docs/specs/dor-tool.rationale.md` → Lifecycle; header findings live in
`docs/specs/layout.rationale.md` → Pane header responsive sizing.

## Harness and isolation

1. Run source-mutating root self-tests before starting the live harness. Start
   `dor ensure -- pnpm innerdogfood` from the checkout under test. Use the
   printed browser command through `dor ab`; the harness provides real sidecar
   PTYs, a staged CLI, and the iframe proxy.
2. Keep generated files and a separate XDG user configuration under the ignored
   `standalone/src-tauri/target/dor-tool-qc/` directory. Use that configuration
   for inner CLI invocations; leave the installed application's configuration
   and trust records untouched. Capture inner CLI credentials only to a
   mode-0600 local file, never to a report.
3. From an inner terminal, start the fixture as a Tool:
   `dor tool -- node scripts/dor-tool-qc/server.mjs --label QC --ports 1`.
   Adjust the fixture path if that terminal starts outside the checkout.

## Serving and interaction checks

The fixture accepts `--ports N`, `--label TEXT`, `--path PATH`, and `--announce`.
It prints its PID, listening ports, and argv. `--ports 3` creates a port conflict;
`--announce` selects the first port through OSC 367. On POSIX, send `SIGUSR1` to
the printed PID to announce after startup. The page echoes the requested path
and argv, and its text input makes document-state retention visible.

Use the fixture to exercise narrow header controls, popup actions and focus,
Terminal Context, minimize/reveal, renderer changes, and live reload. Add local
files and temporary user/project `dormouse.yml` declarations for approval,
argument quoting, keyed reuse/restart, and file dispatch. Record the tested
commit, observed outcomes, and coverage limits when collecting new evidence.
The browser harness does not establish native Tauri/VS Code rendering,
native-window transfer, or Windows shell behavior.

## Cleanup

Close every Tool created by the run, verify its printed PID and listeners have
exited, then stop the owned harness. Remove private credential captures. Keep
any screenshots and raw observations ignored locally; summarize durable
findings in the owning spec's rationale rather than linking private artifacts.
