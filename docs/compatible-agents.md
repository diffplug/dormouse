# Compatible agents

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

Recovery requires a fresh exit hint. An empty conversation may produce none. A crash or force-quit can prevent capture, and a conversation you already exited before Dormouse shuts down is not recovered from old terminal output. In these cases, use the agent's own conversation history. Standalone window reloads keep the live terminal processes, so those conversations keep running without this recovery step.

### Watching for attention

On a fresh installation, Dormouse watches commands marked **Yes** in the table above. It observes terminal output becoming busy and then quiet, which can indicate a finished response or a request for input. This is an output heuristic; it does not read the agent's internal task state.

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

Open a **draft pull request** with the entry, fixture, documentation, and verification results. Changes to shared behavior also update its owning spec: [recovery](specs/transport.md#persisted-session-types), [watching](specs/alert.md#watching-track), or [shutdown capture](specs/vscode.md#capturing-agent-recovery).
