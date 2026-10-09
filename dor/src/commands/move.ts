import { buildCommand } from '@stricli/core';
import type { Command, DorCommandContext, MoveSurfaceResponse, WorkspaceScopedFlags } from './types.js';
import { errorMessage, renderJson, requireControlClient, stringParser, workspaceFlag, workspaceParam, writeStdout } from './shared.js';

interface MoveFlags extends WorkspaceScopedFlags {
  readonly new?: boolean;
  readonly focus?: boolean;
  readonly dangerouslyDestroyIframePageState?: boolean;
  readonly json?: boolean;
}

export const moveCommand: Command = {
  name: 'move',
  command: buildCommand<MoveFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Move a surface to another workspace.',
      customUsage: ['<surface> <workspace>|--new [--workspace source] [--focus] [--dangerously-destroy-iframe-page-state] [--json]'],
      fullDescription: `Moves a Surface within this Window, keeping its id. Focus stays put unless --focus is set. --new creates a Workspace; it is refused for the source's only Surface.

Plain iframes reopen at their saved URL and require --dangerously-destroy-iframe-page-state. Dirty or pending Tools cannot move, even with that flag.

After your own pane moves, unscoped ensure searches the destination and can duplicate work left behind.

To move an entire Workspace to another Window or strip position, use dor workspace move.

Text output: moved surface:4 workspace:2`,
    },
    parameters: {
      flags: {
        new: { kind: 'boolean', brief: 'Create a new destination Workspace.', optional: true, withNegated: false },
        focus: { kind: 'boolean', brief: 'Follow the moved Surface into passthrough.', optional: true, withNegated: false },
        dangerouslyDestroyIframePageState: { kind: 'boolean', brief: 'Accept reopening an iframe at its saved URL.', optional: true, withNegated: false },
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        workspace: workspaceFlag,
      },
      positional: { kind: 'array', minimum: 1, parameter: { parse: stringParser, brief: 'Surface and destination Workspace.', placeholder: 'args' } },
    },
    func: async function(flags, ...args) {
      if ((flags.new === true && args.length !== 1) || (flags.new !== true && args.length !== 2)) {
        return new Error('dor move requires a surface and exactly one destination: <workspace> or --new');
      }
      const client = requireControlClient(this.options);
      if (client instanceof Error) return client;
      try {
        const result = await client.moveSurface({
          surface: args[0], destination: flags.new ? { new: true } : { workspace: args[1] },
          focus: flags.focus === true, dangerouslyDestroyIframePageState: flags.dangerouslyDestroyIframePageState === true,
          ...workspaceParam(flags.workspace),
        });
        writeStdout(this, renderMoveResponse(result, flags.json === true));
      } catch (error) { return new Error(errorMessage(error)); }
    },
  }),
};

function renderMoveResponse(result: MoveSurfaceResponse, json: boolean): string {
  if (!json) return `${result.status} ${result.surfaceId} ${result.workspaceId}\n`;
  return renderJson({ status: result.status, surface_id: result.surfaceId, workspace_id: result.workspaceId });
}
