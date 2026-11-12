/** Private `surface.send` command wiring and input-byte rendering. */

import { validateInputEvents, SEND_INPUT_TIMEOUT_MS, type SendInputEvent } from '../input-events.js';
import { buildCommand } from '@stricli/core';
import { commandError } from './errors.js';
import type {
  Command,
  DorCommandContext,
  ParseResult,
  SendSurfaceResponse,
  WorkspaceScopedFlags,
} from './types.js';
import {
  errorMessage,
  renderJson,
  requireControlClient,
  stringParser,
  workspaceFlag,
  workspaceParam,
  writeStdout,
} from './shared.js';

interface SendFlags extends WorkspaceScopedFlags {
  readonly json?: boolean;
  readonly key?: string[];
  readonly sequence?: string;
  readonly stdin?: boolean;
  readonly text?: string[];
}

/** The shared parser has consumed values into --option=value tokens; this
 * ordered walk is independent of stricli's per-flag arrays. */
function inlineInputs(args: readonly string[]): Array<SendInputEvent | { stdin: true }> {
  const inputs: Array<SendInputEvent | { stdin: true }> = [];
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--stdin' || /^--stdin=true$/i.test(arg)) inputs.push({ stdin: true });
    else if (arg.startsWith('--text=')) inputs.push({ text: arg.slice(7) });
    else if (arg.startsWith('--key=')) inputs.push({ key: arg.slice(6) });
  }
  return inputs;
}

export function validateSendFlags(args: string[]): ParseResult<void> {
  if (args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--')).includes('--raw')) {
    return { ok: false, message: '--raw was removed; --text is always literal' };
  }
  return { ok: true, value: undefined };
}

const SEND_USAGE = [
  '<surface> (--text value | --key name | --stdin)... [--json] [--workspace ref]',
  '<surface> --sequence json [--json] [--workspace ref]',
];

export const sendCommand: Command = {
  name: 'send',
  preParse: validateSendFlags,
  helpPatches: [
    {
      // stricli's root line puts <surface> last and lists --sequence beside
      // the event flags it cannot combine with.
      scope: 'root',
      findReplace: ['  dor send [--json] [--key value]<TO-EOL>', SEND_USAGE.map(usage => `  dor send ${usage}\n`).join('')],
    },
  ],
  command: buildCommand<SendFlags, [string], DorCommandContext>({
    docs: {
      brief: 'Send text or key input to a terminal surface.',
      customUsage: SEND_USAGE,
      fullDescription: `Sends an ordered batch of text and key events to a terminal surface. Repeat --text and --key in any order. --stdin inserts standard input at its position and may occur once. --sequence is an alternative to these flags.

All text is literal: no backslash decoding, newline conversion, implicit Enter, or paste wrapping. Shell quoting and JSON parsing are the only decoding layers. --raw has been removed.

The complete batch is validated before anything is sent. Text arrives in short bursts; named keys wait for prior text to settle. Cursor keys use the terminal's active cursor-key mode. A batch stays together in the host queue. A lone ctrl-c interrupts pending input immediately; ctrl-c inside a larger batch stays ordered.

"sent" means the final write reached the live PTY, not that the program processed it. A failed or cancelled batch may have been partially delivered: do not retry automatically. Use dor await for program completion.

Supported keys: enter, escape, esc, tab, backspace, delete, up, down, left, right, ctrl-a through ctrl-z.

Sequence input is an ordered JSON array of {"text":"..."} and {"key":"..."} objects.

Option values are literal arguments, including empty strings, leading dashes, and line breaks. --text=value and --text value are equivalent.

JSON output:
  {
    "status": "sent",
    "surface_id": "...",
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
        json: { kind: 'boolean', brief: 'Print a JSON result or error object.', optional: true, withNegated: false },
        key: { kind: 'parsed', variadic: true, parse: stringParser, brief: 'Send a named key or chord.', optional: true },
        sequence: { kind: 'parsed', parse: stringParser, brief: 'Send an ordered JSON sequence of text and key events.', optional: true, placeholder: 'json' },
        stdin: { kind: 'boolean', brief: 'Read text from standard input and send it as text.', optional: true, withNegated: false },
        text: { kind: 'parsed', variadic: true, parse: stringParser, brief: 'Send literal text; repeat to add another event.', optional: true },
        workspace: workspaceFlag,
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
  const inputs = await collectSendInputs(flags, this.commandArgs, this.options.readStdin);
  if (!inputs.ok) return new Error(inputs.message);

  if (!inputs.value.some(event => 'key' in event || event.text.length > 0)) return new Error('input cannot be empty');

  const client = requireControlClient(this.options, SEND_INPUT_TIMEOUT_MS + 5_000);
  if (client instanceof Error) return client;

  try {
    const response = await client.sendSurface({
      surface,
      events: inputs.value,
      ...workspaceParam(flags.workspace),
    });
    writeStdout(this, renderSendResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return commandError(error);
  }
}

async function collectSendInputs(flags: SendFlags, args: readonly string[], readStdin?: () => Promise<string>): Promise<ParseResult<SendInputEvent[]>> {
  const inline = inlineInputs(args);
  if (flags.sequence !== undefined) {
    if (inline.length) return { ok: false, message: '--sequence cannot be combined with --text, --key, or --stdin' };
    try { return validateInputEvents(JSON.parse(flags.sequence)); }
    catch (error) { return { ok: false, message: `invalid --sequence JSON: ${errorMessage(error)}` }; }
  }
  if (inline.filter(event => 'stdin' in event).length > 1) return { ok: false, message: '--stdin may be given only once' };
  const checked = validateInputEvents(inline.map(event => 'stdin' in event ? { text: '' } : event));
  if (!checked.ok) return checked;
  if (inline.some(event => 'stdin' in event) && !readStdin) return { ok: false, message: 'stdin is not available' };
  const events: SendInputEvent[] = [];
  for (const event of inline) events.push('stdin' in event ? { text: await readStdin!() } : event);
  return { ok: true, value: events };
}

function renderSendResponse(response: SendSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      surface_id: response.surfaceId,
      input_count: response.inputCount,
    });
  }

  const noun = response.inputCount === 1 ? 'input' : 'inputs';
  return `${response.status} ${response.surfaceId}  [${response.inputCount} ${noun}]\n`;
}
