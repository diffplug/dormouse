# Compatible agents

> See `docs/specs/glossary.md` for Surface, Session, Pane, resume, and restore vocabulary.
> Owns the public agent guide and shared agent capture, recovery records, detection, and cold-restore execution. Host shutdown ordering and target selection belong to `docs/specs/vscode.md` and `docs/specs/standalone.md`; watching belongs to `docs/specs/alert.md`.

Dormouse runs CLI agents in ordinary terminal panes. For the agents below, it can also save the conversation's resume command during an orderly shutdown and reopen that conversation on the next start.

## Supported agents

Install and sign in to the agent separately, then launch it from a Dormouse terminal. `<id>` below is the conversation identifier printed by the agent when it exits.

| Agent | Command | Resume command | Watch by default |
| --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/cli-reference) | `claude` | `claude --resume <id>` | Yes |
| [Codex](https://developers.openai.com/codex/cli/) | `codex` | `codex resume <id>` | Yes |
| [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli) | `copilot` | `copilot --resume <id>` | Yes |
| [Antigravity](https://antigravity.google/docs/cli/commands/resume) | `agy` | `agy --conversation <id>` | Yes |
| [Warp](https://docs.warp.dev/agents/cli/reference/) | `warp` | `warp --resume <id>` | Yes |
| [Cursor](https://cursor.com/docs/cli/overview) | `agent` | `agent --resume <id>` | Yes |
| [Cursor](https://cursor.com/docs/cli/overview) | `cursor-agent` | `cursor-agent --resume <id>` | Yes |

Hints printed with `=`, such as `copilot --resume=<id>`, are recognized too. Claude's older `claude --continue` hint is also recognized; every other integration requires an explicit ID, so conversations that share a directory restore separately. Warp's integration uses the `warp` agent CLI.

## How recovery and watching work

### Conversation recovery

During an orderly app shutdown or VS Code window reload, Dormouse interrupts running programs and looks for the resume commands they print. On the next cold start, it restores each pane's working directory and automatically runs its captured command once the shell is ready.

The agent restores its saved conversation. This does not automatically resubmit a prompt or restart the interrupted task. The agent must remain installed and its conversation must still be available. Its own authentication or permission prompts may appear.

Recovery requires a fresh exit hint followed by a separator, such as a newline. An empty conversation may produce none. A crash or force-quit can prevent capture, and a conversation you already exited before Dormouse shuts down is not recovered from old terminal output. In these cases, use the agent's own conversation history. Standalone window reloads keep the live terminal processes, so those conversations keep running without this recovery step.

### Watching for attention

When no watch list has been saved, Dormouse watches commands marked **Yes** in the table above. This includes fresh installations and upgrades where watching was never configured. It observes terminal output becoming busy and then quiet, which can indicate a finished response or a request for input. This is an output heuristic; it does not read the agent's internal task state.

An existing saved watch list is preserved, including an empty list. To watch any running command, listed here or not, open its terminal context and select **Watch all `<command>` commands**. Remove a rule there or in Settings. Rules apply to every pane running that command; Cursor's two executable names have separate rules.

Watching requires shell integration that reports the running command. Terminal notifications and command-exit alerts work independently of watching.

## Adding an agent

An agent integration normally needs one registry entry, an exit fixture, and a row in the table above; the standalone app and VS Code share the recovery implementation.

### Add the definition and fixture

1. Edit [the coding agent registry](../lib/src/lib/coding-agents.ts). For example, Copilot's definition is:

   ```ts
   {
     name: 'GitHub Copilot',
     commands: ['copilot'],
     resume: '--resume',
     watchByDefault: true,
   }
   ```

2. Declare the executable names the agent actually installs and the resume option or subcommand it supports. The shared parser handles space/equals separators, terminal escapes, and command reconstruction. IDs must fit its alphanumeric, hyphen, and underscore grammar. If an agent cannot identify the exact conversation on exit, discuss its capture mechanism in an issue first. Do not substitute a “latest conversation” command.
3. Add a sanitized exit excerpt to [the fixtures](../lib/src/lib/__fixtures__/coding-agents.ts), with the expected rebuilt command, agent version, and operating system. Replace personal paths, account information, and session IDs; preserve relevant wording and terminal escapes. Record real exit output rather than reconstructing a hint from documentation.
4. Add the agent and its command forms to the supported-agents table. Set `watchByDefault` only after checking that the agent becomes quiet when it needs attention. The registry tests require fixture coverage, and the website tests compare this table with the registry.

### Verify the integration

Install dependencies with `pnpm install`, then run the focused tests from the repository root:

```sh
pnpm --filter dormouse-lib exec vitest run src/lib/coding-agents.test.ts src/lib/resume-patterns.test.ts src/lib/watched-defaults.test.ts src/host/recovery-capture.test.ts
pnpm --filter dor-lib-common build
pnpm --filter remote-lib-common build
pnpm --filter dormouse-website test
pnpm lint:public-docs
pnpm lint:specs
```

These tests use fixtures and require no installed agents or credentials. Before submitting, also run `pnpm test` and verify the real agent in disposable conversations:

- Interrupt it while idle and while its input contains unsent text. Record which gestures produce its resume hint and how long that takes.
- Check that an orderly Dormouse shutdown captures the conversation and that a cold start restores the same one, including when two panes use the same working directory.
- Check watching during a response, after completion, at a permission prompt, and while idle. It should settle when attention is needed and should not keep ringing during idle redraws.
- Record the agent version, operating system, Dormouse host tested, and any limitations. Do not claim a platform or scenario you have not tested.

Open a **draft pull request** with the entry, fixture, documentation, and verification results. Changes to shared behavior also update its owning spec: [recovery and shutdown capture](#recovery-contract-maintainers), or [watching](specs/alert.md#watching-track).

## Recovery contract (maintainers)

### Capture

- **Must use the shared `captureAgentRecovery` machine in both hosts**, supplying live ids, an acknowledged interrupt, a monotonic received count, output since a mark, and immediate record delivery.
- **Must capture before killing the target PTYs**, within the host's bounded teardown. Each host owns the target scope; interrupt every live PTY within it, regardless of recognized command, and exclude exited PTYs. (rationale)
- **Must write one `^C` into each target PTY per interrupt call, never signal it.** The shared machine alone decides the second press. Host interrupts must settle within their timeout. (rationale)
- **Never finish early on quiet or replace the retry gates with a blanket second press.** Poll until every target yields or the capture budget expires; retry timing and ask detection live in the module's comments. (rationale)
- **Must scan only bytes received after the mark taken before the first interrupt.** Never widen the scan into earlier output; buffer eviction may discard fresh bytes but must not promote stale bytes into the scan. (rationale)
- **Must report each detected command immediately**, retaining earlier detections if a later target times out.

Source of truth: `captureAgentRecovery` / `RecoveryHost` in `lib/src/host/recovery-capture.ts`; pinned by `lib/src/host/recovery-capture.test.ts`.

### Detection

**Must derive supported executable names and resume options from `CODING_AGENTS`.**

- **Must rebuild only a known invocation plus an opaque id.** The command is *rebuilt* as label, space, captured id, never sliced from the buffer, keeping the hint's executable alias; a long option's id may follow a space or `=`, and only Claude's legacy `claude --continue` omits it. The id must begin with an ASCII alphanumeric and contain only ASCII alphanumerics, hyphens, and underscores. The invocation must end on a word break but nothing stronger (rationale).
- **Must observe a separator after the newest invocation before capturing it.** Buffer end is insufficient, even at the capture deadline; never fall back to an older hint while the newest is unterminated. Pinned by `waits through every ID split` in `lib/src/host/recovery-capture.test.ts` (rationale).
- **Must strip the scan window as a whole, in one pass, with an unterminated control swallowing the rest of it** — the string controls (OSC, DCS, SOS, PM, APC) **in either introducer form, `ESC` or bare C1**, and equally a CSI the window was cut off *inside* (rationale). **Must match every escape by its full ECMA-48 shape**, never by the Fe range (rationale). **Must share one implementation**: `stripTerminalControls` removes string controls by running `TerminalControlStreamFilter`, so the batch and streaming readers cannot disagree.
- **Must strip in boundary mode**: *every complete* control becomes a newline rather than vanishing, except SGR and charset designators, the two classes that neither move the cursor nor erase. **Must discard incomplete trailing presentation controls without creating a boundary** (rationale).
- **Must select the rightmost match in the last 50 lines**, newest *by position* and never by pattern order (rationale).

Source of truth: `CODING_AGENTS` in `lib/src/lib/coding-agents.ts`; `detectResumeCommand` / `normalizeResumeCommand` in `lib/src/lib/resume-patterns.ts`; `stripTerminalControls` in `lib/src/lib/terminal-controls.ts`; pinned by `lib/src/lib/coding-agents.test.ts`, `lib/src/lib/resume-patterns.test.ts`, and `lib/src/lib/terminal-controls.test.ts`.

### Recovery record

- **Must keep one rebuilt invocation per Surface in a host-owned, single-use record outside the persisted Session.** The renderer save path never derives or writes it. (rationale)
- **Must call `beginCapture` before capture can return early.** The first call per host process clears the previous record; subsequent calls merge, preserving captures from other Windows. (rationale)
- **Must persist every detection synchronously through `createRecoveryStore`**, using `recovery.json` in the host-selected directory, an owner-only temporary file, and atomic rename. A failed write must not throw through teardown. Without a directory the store is memory-only and logs that limitation once.
- **Must read and unlink the durable record on the first claim**, including on parse failure; if unlink fails, ignore it. Discard records older than 7 days after unlinking. Within the process, each container claims only its saved pane ids, and each entry is handed out once. (rationale)
- **Must deliver claimed commands out of band on boot through `PlatformAdapter.getRecoveryCommands()`**; adapters whose hosts capture nothing may omit it. Only cold restore consumes these commands for execution; live resume never executes them.

Source of truth: `createRecoveryStore` in `lib/src/host/recovery-store.ts`; `PlatformAdapter` in `lib/src/lib/platform/types.ts`; pinned by `lib/src/host/recovery-store.test.ts`.

### Cold restore

- **Must automatically run a captured command on the next cold restore**, without a confirmation prompt, only while both detection validation and post-interrupt provenance hold. Weakening either requires restoring a confirmation gate. (rationale)
- **Must revalidate the complete stored invocation before typing it**, using `normalizeResumeCommand`; invalid entries must not execute.
- **Must poll for the fresh shell's prompt before typing, with a best-effort write after 15 seconds if no prompt is detected.** Stop without typing if the Session disappears or exits. Command-state seeding follows `docs/specs/terminal-state.md` → Supported OSC Inputs; the passive notice follows `docs/specs/layout.md` → Agent resume on cold restore.

Source of truth: `restoreSession` in `lib/src/lib/session-restore.ts`; `restoreTerminal` / `typeCommandWhenPromptReady` in `lib/src/lib/terminal-lifecycle.ts`; pinned by `lib/src/lib/session-restore.test.ts` and `lib/src/lib/terminal-registry.alert.test.ts`.

## Future

If automatic agent startup becomes disruptive, expose an opt-out setting while retaining prompt-free recovery for users who enable it.
