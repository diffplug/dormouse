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
  resolveControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface KillFlags {
  readonly confirmAwaitUser?: boolean;
  readonly confirmDangerously?: boolean;
  readonly confirmIfRead?: string;
  readonly surface: string;
}

export const killCommand: Command = {
  name: 'kill',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor kill [--confirm-await-user] [--confirm-dangerously] [--confirm-if-read text] (--surface id|ref|index)',
        '  dor kill --surface id|ref|index [--confirm-await-user|--confirm-if-read text|--confirm-dangerously]',
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '  dor kill [--confirm-await-user] [--confirm-dangerously] [--confirm-if-read text] (--surface id|ref|index)',
        '  dor kill --surface id|ref|index [--confirm-await-user|--confirm-if-read text|--confirm-dangerously]',
      ],
    },
  ],
  command: buildCommand<KillFlags, [], DorCommandContext>({
    docs: {
      brief: 'Kill a terminal surface.',
      fullDescription: `Kills a terminal surface. One confirmation mode is required.

--confirm-await-user asks Dormouse to prompt before killing.

--confirm-if-read kills only if dor read --surface <surface> would return visible text containing the provided text. The text must contain at least 4 non-whitespace characters.

--confirm-dangerously kills without further confirmation. Use only when automation has already validated the target.

Text output:
  killed surface:3`,
    },
    parameters: {
      flags: {
        confirmAwaitUser: { kind: 'boolean', brief: 'Ask Dormouse to prompt before killing.', optional: true, withNegated: false },
        confirmDangerously: { kind: 'boolean', brief: 'Kill without further confirmation.', optional: true, withNegated: false },
        confirmIfRead: { kind: 'parsed', parse: stringParser, brief: 'Kill only if dor read contains this text.', optional: true, placeholder: 'text' },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to kill.', placeholder: 'id|ref|index' },
      },
    },
    func: runKillCommand,
  }),
};

async function runKillCommand(this: DorCommandContext, flags: KillFlags): Promise<void | Error> {
  const confirmation = parseConfirmation(flags);
  if (!confirmation.ok) return new Error(confirmation.message);

  const clientResult = resolveControlClient(this.options);
  if (!clientResult.ok) return new Error(clientResult.message);

  try {
    const response = await clientResult.value.killSurface({
      confirmation: confirmation.value,
      surface: flags.surface,
    });
    writeStdout(this, renderKillResponse(response));
    return undefined;
  } catch (error) {
    return new Error(error instanceof Error ? error.message : String(error));
  }
}

function parseConfirmation(flags: KillFlags): ParseResult<KillSurfaceConfirmation> {
  const confirmations = [
    flags.confirmAwaitUser === true,
    flags.confirmDangerously === true,
    flags.confirmIfRead !== undefined,
  ].filter(Boolean).length;

  if (confirmations !== 1) {
    return { ok: false, message: 'dor kill requires exactly one confirmation mode' };
  }

  if (flags.confirmAwaitUser) return { ok: true, value: { mode: 'await-user' } };
  if (flags.confirmDangerously) return { ok: true, value: { mode: 'dangerously' } };

  const text = flags.confirmIfRead?.trim() ?? '';
  if (text.replace(/\s/g, '').length < 4) {
    return { ok: false, message: 'dor kill --confirm-if-read requires at least 4 non-whitespace characters' };
  }
  return { ok: true, value: { mode: 'if-read', text } };
}

function renderKillResponse(response: KillSurfaceResponse): string {
  return `${response.status} ${response.surfaceRef}\n`;
}
