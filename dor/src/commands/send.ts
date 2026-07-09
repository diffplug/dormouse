/** Private `surface.send` command wiring and input-byte rendering. */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  ParseResult,
  SendSurfaceResponse,
} from './types.js';
import {
  renderJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface SendFlags {
  readonly json?: boolean;
  readonly key?: string;
  readonly raw?: boolean;
  readonly sequence?: string;
  readonly stdin?: boolean;
  readonly text?: string;
}

type SendInput =
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string };

// stricli parses each flag independently, so it can't enforce "no duplicate input
// flags" or "--text before --key". `cli.ts` runs this before stricli parses, next
// to the flag definitions below — keep the recognized-flag list in `sendFlagName`
// in sync with `parameters.flags`.
export function validateSendFlags(args: string[]): ParseResult<void> {
  const flagPositions = new Map<string, number>();
  const positionalStart = args.indexOf('--');
  const scanEnd = positionalStart === -1 ? args.length : positionalStart;

  for (let index = 0; index < scanEnd; index += 1) {
    const flag = sendFlagName(args[index]);
    if (!flag) continue;

    if (flagPositions.has(flag)) {
      return { ok: false, message: `dor send does not allow duplicate ${flag}` };
    }
    flagPositions.set(flag, index);
  }

  const textIndex = flagPositions.get('--text');
  const keyIndex = flagPositions.get('--key');
  if (textIndex !== undefined && keyIndex !== undefined && keyIndex < textIndex) {
    return {
      ok: false,
      message: 'when combining --text and --key, put --text before --key; use --sequence for arbitrary ordering',
    };
  }

  return { ok: true, value: undefined };
}

function sendFlagName(arg: string): string | null {
  const [name] = arg.split('=', 1);
  switch (name) {
    case '--json':
    case '--key':
    case '--raw':
    case '--sequence':
    case '--stdin':
    case '--text':
      return name;
    default:
      return null;
  }
}

export const sendCommand: Command = {
  name: 'send',
  preParse: validateSendFlags,
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor send [--json] [--key value] [--raw] [--sequence json] [--stdin] [--text value]<TO-EOL>',
        '  dor send <surface> ([--text value] [--key value] | --stdin | --sequence json) [--json] [--raw]\n',
      ],
    },
  ],
  command: buildCommand<SendFlags, [string], DorCommandContext>({
    docs: {
      brief: 'Send text or key input to a terminal surface.',
      customUsage: ['<surface> ([--text value] [--key value] | --stdin | --sequence json) [--json] [--raw]'],
      fullDescription: `Sends text or key input to a target terminal surface. Special keys must be sent with --key so values like "enter" are never confused with literal text.

Exactly one input mode is required: --text/--key, --stdin, or --sequence. --text and --key may be combined only in that order; text is sent first, then the key. Duplicate input flags are rejected. Use --sequence for arbitrary ordering or multiple text/key events.

Text input interprets backslash escapes for \\n, \\r, \\t, and \\\\ unless --raw is set.

Supported keys: enter, escape, esc, tab, backspace, delete, up, down, left, right, ctrl-a through ctrl-z.

Sequence input is an ordered JSON array of {"text":"..."} and {"key":"..."} objects.

JSON output:
  {
    "status": "sent",
    "surface_id": "...",
    "surface_ref": "surface:3",
    "input_count": 1
  }

Examples:
  dor send surface:3 --text "echo hello"
  dor send surface:3 --text "npm test" --key enter
  dor send surface:3 --key ctrl-c
  cat script.sh | dor send surface:3 --stdin
  dor send surface:3 --sequence '[{"text":"npm test"},{"key":"enter"}]'`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        key: { kind: 'parsed', parse: stringParser, brief: 'Send a named key or chord.', optional: true },
        raw: { kind: 'boolean', brief: 'Do not interpret backslash escapes in text input.', optional: true, withNegated: false },
        sequence: { kind: 'parsed', parse: stringParser, brief: 'Send an ordered JSON sequence of text and key events.', optional: true, placeholder: 'json' },
        stdin: { kind: 'boolean', brief: 'Read text from standard input and send it as text.', optional: true, withNegated: false },
        text: { kind: 'parsed', parse: stringParser, brief: 'Send literal text.', optional: true },
      },
      positional: {
        kind: 'tuple',
        parameters: [
          { parse: stringParser, brief: 'Target surface.', placeholder: 'surface' },
        ],
      },
    },
    func: runSendCommand,
  }),
};

async function runSendCommand(this: DorCommandContext, flags: SendFlags, surface: string): Promise<void | Error> {
  const inputs = await collectSendInputs(flags, this.options.readStdin);
  if (!inputs.ok) return new Error(inputs.message);

  const encoded = encodeSendInputs(inputs.value, flags.raw === true);
  if (!encoded.ok) return new Error(encoded.message);
  if (encoded.value.input.length === 0) return new Error('input cannot be empty');

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  try {
    const response = await client.sendSurface({
      surface,
      input: encoded.value.input,
      inputCount: encoded.value.inputCount,
    });
    writeStdout(this, renderSendResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(error instanceof Error ? error.message : String(error));
  }
}

async function collectSendInputs(
  flags: SendFlags,
  readStdin: (() => Promise<string>) | undefined,
): Promise<ParseResult<SendInput[]>> {
  const inline = flags.text !== undefined || flags.key !== undefined;
  const sources = [
    inline,
    flags.stdin === true,
    flags.sequence !== undefined,
  ].filter(Boolean).length;

  if (sources !== 1) {
    return { ok: false, message: 'dor send requires exactly one input mode' };
  }

  if (inline) {
    const inputs: SendInput[] = [];
    if (flags.text !== undefined) inputs.push({ kind: 'text', text: flags.text });
    if (flags.key !== undefined) inputs.push({ kind: 'key', key: flags.key });
    return { ok: true, value: inputs };
  }
  if (flags.stdin === true) {
    if (!readStdin) return { ok: false, message: 'stdin is not available' };
    return { ok: true, value: [{ kind: 'text', text: await readStdin() }] };
  }
  return parseSendSequence(flags.sequence ?? '');
}

function parseSendSequence(input: string): ParseResult<SendInput[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    return { ok: false, message: `invalid --sequence JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, message: '--sequence must be a JSON array' };
  }

  const inputs: SendInput[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `--sequence item ${index + 1} must be an object` };
    }
    const text = 'text' in item ? (item as { text: unknown }).text : undefined;
    const key = 'key' in item ? (item as { key: unknown }).key : undefined;
    if ((text === undefined) === (key === undefined)) {
      return { ok: false, message: `--sequence item ${index + 1} must contain exactly one of text or key` };
    }
    if (text !== undefined) {
      if (typeof text !== 'string') return { ok: false, message: `--sequence item ${index + 1} text must be a string` };
      inputs.push({ kind: 'text', text });
    } else {
      if (typeof key !== 'string') return { ok: false, message: `--sequence item ${index + 1} key must be a string` };
      inputs.push({ kind: 'key', key });
    }
  }

  return { ok: true, value: inputs };
}

function encodeSendInputs(inputs: SendInput[], raw: boolean): ParseResult<{ input: string; inputCount: number }> {
  let input = '';
  for (const item of inputs) {
    if (item.kind === 'text') {
      input += raw ? item.text : interpretTextEscapes(item.text);
    } else {
      const key = encodeKey(item.key);
      if (!key.ok) return key;
      input += key.value;
    }
  }
  return { ok: true, value: { input, inputCount: inputs.length } };
}

function interpretTextEscapes(input: string): string {
  return input.replace(/\\([nrt\\])/g, (_match, escape: string) => {
    switch (escape) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '\\':
        return '\\';
      default:
        return escape;
    }
  });
}

function encodeKey(input: string): ParseResult<string> {
  const key = input.trim().toLowerCase();
  switch (key) {
    case 'enter':
      return { ok: true, value: '\r' };
    case 'escape':
    case 'esc':
      return { ok: true, value: '\x1b' };
    case 'tab':
      return { ok: true, value: '\t' };
    case 'backspace':
      return { ok: true, value: '\x7f' };
    case 'delete':
      return { ok: true, value: '\x1b[3~' };
    case 'up':
      return { ok: true, value: '\x1b[A' };
    case 'down':
      return { ok: true, value: '\x1b[B' };
    case 'right':
      return { ok: true, value: '\x1b[C' };
    case 'left':
      return { ok: true, value: '\x1b[D' };
  }

  const ctrl = /^ctrl-([a-z])$/.exec(key);
  if (ctrl) {
    return { ok: true, value: String.fromCharCode(ctrl[1].charCodeAt(0) - 96) };
  }

  return { ok: false, message: `unsupported key '${input}'` };
}

function renderSendResponse(response: SendSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      surface_id: response.surfaceId,
      surface_ref: response.surfaceRef,
      input_count: response.inputCount,
    });
  }

  const noun = response.inputCount === 1 ? 'input' : 'inputs';
  return `${response.status} ${response.surfaceRef}  [${response.inputCount} ${noun}]\n`;
}
