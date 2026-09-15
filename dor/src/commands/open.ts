import { buildCommand } from '@stricli/core';
import type { Command, DorCommandContext } from './types.js';
import { callerWorkingDirectory, errorMessage, requireControlClient, stringParser, workspaceFlag, workspaceParam, writeStderr, writeStdout } from './shared.js';
import { renderToolResponse } from './tool.js';

interface OpenFlags {
  json?: boolean;
  minimize?: boolean;
  fresh?: boolean;
  surface?: string;
  workspace?: string;
  cwd?: string;
  tool?: string;
}

export const openCommand: Command = {
  name: 'open',
  command: buildCommand<OpenFlags, [string], DorCommandContext>({
    docs: {
      brief: 'Open a local file with a Dor Tool.',
      fullDescription: `Opens one existing local file. Relative paths resolve from the caller's directory (or --cwd); symlink aliases resolve to the same file. URLs, directories, and Surface handles are not accepted.

The first matching rule in the user dormouse.yml selects a user Tool or builtin:file. --tool chooses a handler explicitly. Without a matching rule, the built-in viewer opens supported HTML, text/source, image, PDF, and media files. Use --tool builtin:file to select it explicitly. Markdown is shown as source text; a user Tool can provide rendered Markdown. Project associations and project Tools never participate in this lookup. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml.

The ordered open list contains {match, tool} entries. Patterns without a slash match the filename; patterns with a slash match the canonical file path relative to the invocation directory, using forward slashes and Node glob syntax. Dotfiles require explicit patterns. The built-in HTML viewer serves statically referenced relative assets within the document directory tree; root-relative and external resources are unavailable. Text previews are capped at 8 MiB.

The selected Tool receives the canonical absolute filename as one argument. Configure prespawn_dedupe: [$TARGET] to reveal the same file on repeated opens within a Workspace. --fresh bypasses reuse.

Opening creates a focus-neutral split or reveals an existing Tool, never taking over the caller's terminal. The command prints the Surface handle; --json prints structured output.`,
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
    async func(this: DorCommandContext, flags: OpenFlags, file: string) {
      const client = requireControlClient(this.options, 20_000);
      if (client instanceof Error) return client;
      try {
        const response = await client.toolSurface({ file, tool: flags.tool, cwd: callerWorkingDirectory(flags.cwd, this.options.env),
          fresh: flags.fresh === true, minimized: flags.minimize === true, surface: flags.surface, ...workspaceParam(flags.workspace) });
        for (const warning of response.warnings ?? []) writeStderr(this, `${warning}\n`);
        writeStdout(this, renderToolResponse(response, flags.json === true));
      } catch (error) { return new Error(errorMessage(error)); }
    },
  }),
};
