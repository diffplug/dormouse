/** Private `surface.send` command wiring and input-byte rendering. */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  ParseResult,
  SendSurfaceResponse,
} from './types.js';
import {
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface SendFlags {
  readonly key?: string;
  readonly raw?: boolean;
  readonly sequence?: string;
  readonly stdin?: boolean;
  readonly surface?: string;
  readonly text?: string;
}

type SendInput =
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string };

export const sendCommand: Command = {
  name: 'send',
  command: buildCommand<SendFlags, [string?], DorCommandContext>({
    docs: {
      brief: 'Send text or key input to a terminal surface.',
      fullDescription: `By default, a positional argument is sent as text. Special keys must be sent with --key so values like "enter" are never confused with literal text.

If --surface is omitted, Dormouse uses the caller surface from DORMOUSE_SURFACE_ID, then the focused surface.

Exactly one input source is required: TEXT, --text, --key, --stdin, or --sequence.

Text input interprets backslash escapes for \\n, \\r, \\t, and \\\\ unless --raw is set. Prefer --key enter when submitting a prompt.

Supported keys: enter, escape, esc, tab, backspace, delete, up, down, left, right, ctrl-a through ctrl-z.

Sequence input is an ordered JSON array of {"text":"..."} and {"key":"..."} objects.

Examples:
  dor send "echo hello"
  dor send --key enter
  dor send --surface surface:3 --key ctrl-c
  cat script.sh | dor send --surface surface:3 --stdin
  dor send --surface surface:3 --sequence '[{"text":"npm test"},{"key":"enter"}]'`,
    },
    parameters: {
      flags: {
        key: { kind: 'parsed', parse: stringParser, brief: 'Send a named key or chord.', optional: true },
        raw: { kind: 'boolean', brief: 'Do not interpret backslash escapes in text input.', optional: true, withNegated: false },
        sequence: { kind: 'parsed', parse: stringParser, brief: 'Send an ordered JSON sequence of text and key events.', optional: true, placeholder: 'json' },
        stdin: { kind: 'boolean', brief: 'Read text from standard input and send it as text.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Target surface.', optional: true, placeholder: 'id|ref|index' },
        text: { kind: 'parsed', parse: stringParser, brief: 'Send literal text.', optional: true },
      },
      positional: {
        kind: 'tuple',
        parameters: [
          { parse: stringParser, brief: 'Text to send.', optional: true, placeholder: 'text' },
        ],
      },
    },
    func: runSendCommand,
  }),
};

async function runSendCommand(this: DorCommandContext, flags: SendFlags, text?: string): Promise<void | Error> {
  const inputs = await collectSendInputs(flags, text, this.options.readStdin);
  if (!inputs.ok) return new Error(inputs.message);

  const encoded = encodeSendInputs(inputs.value, flags.raw === true);
  if (!encoded.ok) return new Error(encoded.message);
  if (encoded.value.input.length === 0) return new Error('input cannot be empty');

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  try {
    const response = await client.sendSurface({
      surface: flags.surface,
      input: encoded.value.input,
      inputCount: encoded.value.inputCount,
    });
    writeStdout(this, renderSendResponse(response));
    return undefined;
  } catch (error) {
    return new Error(error instanceof Error ? error.message : String(error));
  }
}

async function collectSendInputs(
  flags: SendFlags,
  positionalText: string | undefined,
  readStdin: (() => Promise<string>) | undefined,
): Promise<ParseResult<SendInput[]>> {
  const sources = [
    positionalText !== undefined,
    flags.text !== undefined,
    flags.key !== undefined,
    flags.stdin === true,
    flags.sequence !== undefined,
  ].filter(Boolean).length;

  if (sources !== 1) {
    return { ok: false, message: 'dor send requires exactly one input source' };
  }

  if (positionalText !== undefined) return { ok: true, value: [{ kind: 'text', text: positionalText }] };
  if (flags.text !== undefined) return { ok: true, value: [{ kind: 'text', text: flags.text }] };
  if (flags.key !== undefined) return { ok: true, value: [{ kind: 'key', key: flags.key }] };
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

function renderSendResponse(response: SendSurfaceResponse): string {
  const noun = response.inputCount === 1 ? 'input' : 'inputs';
  return `${response.status} ${response.surfaceRef}  [${response.inputCount} ${noun}]\n`;
}
