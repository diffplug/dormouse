# Migrating scripts to dor 2.0

The generated command reference remains the syntax authority. These changes apply to the CLI bundled with Dormouse 2.0; update scripts together with the host.

| Area | Update |
|---|---|
| Literal values | Option values are literal, including empty strings and values beginning with `-`. Both `--option value` and `--option=value` preserve the value. An empty `--cwd` is refused rather than meaning the caller's directory. |
| Forwarded commands | Only `dor split` changed: its initial command now goes after `--` (`dor split -- npm test`). Browser providers stay drop-in: Dormouse's options (`--key`, `--session`, `--surface`, `--workspace`, `--from`, `--focus`) are read anywhere, as in `dor agent-browser open :5173 --key app`, and an optional bare `--` ends that interception. Named Tools still take `dor tool <name> [args...]`, with `--` only before arguments that begin with a dash. |
| Terminal input | Replace escape-decoded `send` input with ordered `--text`, `--key`, and `--stdin` events, or `--sequence` JSON. `--raw` is removed. Text never implies Enter. A successful send acknowledges PTY delivery, not program completion. |
| Focus | A command an agent or script runs leaves the user's focus where it is, on creation and reuse alike. A `dor` command a person types alone at a prompt focuses its result. `--focus` and `--focus=false` override either default; `--minimize` and `dor open --preview` default to no focus, and only an explicit `--focus` conflicts with `--minimize`. |
| JSON failures | Check exit status before reading success fields. Failures print `{"error":{"code":"...","message":"..."}}` on stdout. Codes: `INVALID_ARGUMENT` (parsing), `CONTROL_UNAVAILABLE` (no host endpoint, or the connection or handshake failed before the request was sent, so nothing ran), `COMMAND_FAILED`, `TIMEOUT` and `SURFACE_DIED` (from `await`, keeping exit codes 2 and 3), and `CANCELLED` (a dismissed picker). |
| Launch results | `completion` is replaced by `command_state`, separate from the creation/reuse `status`: `unconfirmed`, `running` (started, not necessarily ready), `awaiting_approval`, `queued`, or `ended`. Text output from `ensure`, `tool`, and `open` shows it as a `[tag]` after the handle. A browser-provider command that succeeded but whose pane could not be opened exits 4; it already ran, so check the page before repeating it. |
| Placement | Replace placement `--surface` with `--from` on split, ensure, tool/open, and iframe. Browser providers also accept `--from`, which matters only when the command creates a pane; their `--surface` still chooses the browser to drive. |
| References | Replace bare Workspace references with `workspace:<id>` or `workspace-name:<exact name>`. Use `window:<label>` for Window references. Replace `dor workspace move <ref> --window new` with `--new-window`, and `dor move <surface> --new` with `--new-workspace`. |

For example, use `dor send surface:3 --text 'C:\tmp\notes' --key Enter` to send that literal path followed by Enter. In `--sequence`, JSON escaping still applies: `[{"text":"C:\\tmp\\notes"},{"key":"Enter"}]` describes the same events.

A Workspace named `2` is `workspace-name:2`; `workspace:2` always selects the id. Name references preserve whitespace and fail when ambiguous. Prefer ids captured from command output for automation.

`ensure`, Tool and file pickers, caller takeover, and both browser providers remain available. Takeover answers `queued` before the CLI exits, because that exit frees the shell to run the Tool.
