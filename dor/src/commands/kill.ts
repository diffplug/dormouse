/** Private `surface.kill` command wiring and confirmation validation. */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  KillSurfaceConfirmation,
  KillSurfaceResponse,
  ParseResult,
} from './types.js';
import {
  renderJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface KillFlags {
  readonly confirmDangerously?: boolean;
  readonly confirmIfRead?: string;
  readonly json?: boolean;
  readonly surface: string;
}

export const killCommand: Command = {
  name: 'kill',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor kill [--confirm-dangerously] [--confirm-if-read text] [--json] (--surface id|ref|index)',
        '  dor kill --surface id|ref|index [--confirm-if-read text|--confirm-dangerously] [--json]',
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '  dor kill [--confirm-dangerously] [--confirm-if-read text] [--json] (--surface id|ref|index)',
        '  dor kill --surface id|ref|index [--confirm-if-read text|--confirm-dangerously] [--json]',
      ],
    },
  ],
  command: buildCommand<KillFlags, [], DorCommandContext>({
    docs: {
      brief: 'Kill a surface.',
      fullDescription: `Kills a surface. One confirmation mode is required.

--confirm-if-read kills only if dor read --surface <surface> would return visible text containing the provided text. The text must contain at least 4 non-whitespace characters.

--confirm-dangerously kills without further confirmation. Use only when automation has already validated the target.

Text output:
  killed surface:3

JSON output:
  {
    "status": "killed",
    "surface_id": "...",
    "surface_ref": "surface:3"
  }`,
    },
    parameters: {
      flags: {
        confirmDangerously: { kind: 'boolean', brief: 'Kill without further confirmation.', optional: true, withNegated: false },
        confirmIfRead: { kind: 'parsed', parse: stringParser, brief: 'Kill only if dor read contains this text.', optional: true, placeholder: 'text' },
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to kill.', placeholder: 'id|ref|index' },
      },
    },
    func: runKillCommand,
  }),
};

async function runKillCommand(this: DorCommandContext, flags: KillFlags): Promise<void | Error> {
  const confirmation = parseConfirmation(flags);
  if (!confirmation.ok) return new Error(confirmation.message);

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  try {
    const response = await client.killSurface({
      confirmation: confirmation.value,
      surface: flags.surface,
    });
    writeStdout(this, renderKillResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(error instanceof Error ? error.message : String(error));
  }
}

function parseConfirmation(flags: KillFlags): ParseResult<KillSurfaceConfirmation> {
  const confirmations = [
    flags.confirmDangerously === true,
    flags.confirmIfRead !== undefined,
  ].filter(Boolean).length;

  if (confirmations !== 1) {
    return { ok: false, message: 'dor kill requires exactly one confirmation mode' };
  }

  if (flags.confirmDangerously) return { ok: true, value: { mode: 'dangerously' } };

  const text = flags.confirmIfRead?.trim() ?? '';
  if (text.replace(/\s/g, '').length < 4) {
    return { ok: false, message: 'dor kill --confirm-if-read requires at least 4 non-whitespace characters' };
  }
  return { ok: true, value: { mode: 'if-read', text } };
}

function renderKillResponse(response: KillSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      ...(response.surfaceId ? { surface_id: response.surfaceId } : {}),
      surface_ref: response.surfaceRef,
    });
  }

  return `${response.status} ${response.surfaceRef}\n`;
}
