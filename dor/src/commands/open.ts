import { buildCommand } from '@stricli/core';
import type { Command, DorCommandContext, WorkspaceScopedFlags } from './types.js';
import { callerWorkingDirectory, stringParser, workspaceFlag, workspaceParam } from './shared.js';
import { dispatchToolSurface } from './tool.js';

interface OpenFlags extends WorkspaceScopedFlags {
  readonly json?: boolean;
  readonly minimize?: boolean;
  readonly fresh?: boolean;
  readonly surface?: string;
  readonly cwd?: string;
  readonly tool?: string;
}

export const openCommand: Command = {
  name: 'open',
  command: buildCommand<OpenFlags, [string], DorCommandContext>({
    docs: {
      brief: 'Open a local file with a Dor Tool.',
      fullDescription: `Opens one existing local file. Relative paths resolve from the caller's directory (or --cwd); symlink aliases resolve to the same file. URLs, directories, and Surface handles are not accepted.

The first matching rule in the user dormouse.yml selects a user Tool or builtin:file. --tool chooses a handler explicitly. Without a matching rule, the built-in viewer opens supported HTML, text/source, image, and media files. PDFs require a user Tool association or --tool <name>. Use --tool builtin:file to select it explicitly. Markdown is shown as source text; a user Tool can provide rendered Markdown. Project associations and project Tools never participate in this lookup. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml.

The ordered open list contains {match, tool} entries. Patterns without a slash match the filename; patterns with a slash match both the canonical absolute path and the path relative to the invocation directory. Matching uses picomatch glob syntax with forward slashes and case sensitivity. Dotfiles require explicit patterns. The built-in HTML viewer serves statically referenced relative assets within the document directory tree; root-relative and external resources are unavailable. Text previews are capped at 8 MiB.

The selected Tool receives the canonical absolute filename as one argument. Configure prespawn_dedupe: [$TARGET] to reveal the same file on repeated opens within a Workspace. --fresh bypasses reuse.

Placement follows dor tool: typed alone at a prompt in a visible, integrated plain terminal in the requested directory, opening takes over that pane, preserving its terminal and scrollback. Agent/script invocations, compound lines, a pane with a helper, --minimize, --surface, or --cwd elsewhere split without taking focus. A matching Tool is reused. The command prints the Surface handle; --json prints structured output.`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        fresh: { kind: 'boolean', brief: 'Open another instance even when the Tool has a key.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split when creating.', optional: true, placeholder: 'id|ref' },
        workspace: workspaceFlag,
        cwd: { kind: 'parsed', parse: stringParser, brief: 'Directory for resolving the file.', optional: true, placeholder: 'path' },
        tool: { kind: 'parsed', parse: stringParser, brief: 'Use a user Tool or builtin:file.', optional: true, placeholder: 'name' },
      },
      positional: { kind: 'tuple', parameters: [{ parse: stringParser, brief: 'Local file to open.', placeholder: 'file' }] },
    },
    func(this: DorCommandContext, flags: OpenFlags, file: string) {
      return dispatchToolSurface(this, {
        file,
        tool: flags.tool,
        ...workspaceParam(flags.workspace),
        fresh: flags.fresh === true,
        minimized: flags.minimize === true,
        surface: flags.surface,
        cwd: callerWorkingDirectory(flags.cwd, this.options.env),
      }, flags.json === true);
    },
  }),
};
