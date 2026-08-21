/**
 * `dor await` — block until a terminal surface finishes what it is doing, then
 * report why the wait ended. The wait itself lives in the host's `AlertManager`
 * (`docs/specs/alert.md` → Await); this command owns the caller-facing contract:
 * a machine-clean cause on stdout, a human narrative on stderr, and the exit
 * codes that distinguish "still out there and slow" from "it will never answer".
 */

import { buildCommand } from '@stricli/core';
import type {
  AwaitCause,
  AwaitSurfaceResponse,
  AwaitUntil,
  Command,
  DorCommandContext,
} from './types.js';
import {
  errorMessage,
  renderJson,
  requireControlClient,
  stringParser,
  writeStderr,
  writeStdout,
} from './shared.js';

interface AwaitFlags {
  readonly json?: boolean;
  readonly timeout?: number;
  readonly until: AwaitUntil;
}

/** The ceiling on a blocking call inside an agent loop — not an alert-tuning
 *  knob, and the one number `await` does not inherit from `cfg.alert`. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** Exit code for a wait that ran out its `--timeout`. */
const EXIT_TIMED_OUT = 2;
/** Exit code for a surface whose PTY exited before it finished. */
const EXIT_DIED = 3;

/**
 * The host's grace window, rendered for humans. Kept as a literal because the
 * CLI bundle must not import `lib`; the value is `AWAIT_GRACE_MS` in
 * `lib/src/lib/alert-manager.ts` (2000ms, derived from `cfg.alert`).
 */
const GRACE_WINDOW_TEXT = '2s';

const FULL_DESCRIPTION = `Waits until a terminal surface finishes what it is doing, then reports why the wait ended. Lets an agent block on a peer it launched with \`dor split\` instead of polling \`dor list\` in a loop.

Prints no terminal text. Follow with \`dor read\` to see the screen.

--until says what counts as finished:
  quiet  The surface settled, the running command exited, or the surface rang the bell. Use for agents that keep running, such as claude or codex.
  exit   The running command exited, and nothing else. Use for builds and test runs, which can fall silent mid-run without being finished.

Waiting absorbs the alert. A surface that finishes while awaited does not ring the bell, speak an alarm, or notify a paired phone, and is not marked TODO — the wait already delivered the news.

Text mode prints the cause alone on stdout: quiet, exit, bell, or idle. An idle result means nothing was running and nothing started, so there was never anything to wait for.

A one-line summary naming the cause and how long the wait took goes to stderr, so it stays out of the captured value: \`quiet: output stopped after 10m 15s\`. The duration is how long this command blocked, not how long the surface had been working.

JSON output:
  {
    "workspace_ref": "workspace:1",
    "surface_id": "...",
    "surface_ref": "surface:3",
    "cause": "quiet",
    "waited_ms": 615000,
    "detail": "output stopped after 10m 15s"
  }

Exits 0 on any resolution, 2 on timeout, and 3 if the surface died before finishing.

Examples:
  dor await surface:3 --until quiet
  dor await surface:3 --until quiet && dor read surface:3
  dor await surface:3 --until exit --timeout 1800
  CAUSE=$(dor await surface:3 --until quiet)`;

export const awaitCommand: Command = {
  name: 'await',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor await [--json] [--timeout seconds] (--until condition)<TO-EOL>',
        '  dor await <surface> --until condition [--json] [--timeout seconds]\n',
      ],
    },
  ],
  command: buildCommand<AwaitFlags, [string], DorCommandContext>({
    docs: {
      brief: 'Wait until a terminal surface finishes.',
      customUsage: ['<surface> --until condition [--json] [--timeout seconds]'],
      fullDescription: FULL_DESCRIPTION,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        timeout: { kind: 'parsed', parse: parseTimeoutSeconds, brief: 'Seconds to wait before giving up. Default 600.', optional: true, placeholder: 'seconds' },
        until: { kind: 'parsed', parse: parseUntil, brief: 'What to wait for: quiet or exit.', optional: false, placeholder: 'condition' },
      },
      positional: {
        kind: 'tuple',
        parameters: [
          { parse: stringParser, brief: 'Surface to wait on.', placeholder: 'surface' },
        ],
      },
    },
    func: runAwaitCommand,
  }),
};

async function runAwaitCommand(this: DorCommandContext, flags: AwaitFlags, surface: string): Promise<void | Error> {
  const timeoutSeconds = flags.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  // The host enforces the ceiling and answers `timeout`, so the client must sit
  // above it (see `SocketControlClient.awaitSurface`).
  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  let response: AwaitSurfaceResponse;
  try {
    response = await client.awaitSurface({ surface, until: flags.until, timeoutMs: timeoutSeconds * 1000 });
  } catch (error) {
    return new Error(errorMessage(error));
  }

  switch (response.outcome) {
    case 'resolved': {
      const cause = response.cause;
      if (!cause) return new Error('await resolved without a cause');
      const detail = narrative(cause, flags.until, response.waitedMs);
      // stdout carries the bare cause so `CAUSE=$(dor await …)` stays the whole
      // idiom; the narrative goes to stderr, the explain-what-happened channel,
      // even on success.
      writeStdout(this, flags.json === true
        ? renderJson({
          workspace_ref: response.workspaceRef,
          surface_id: response.surfaceId,
          surface_ref: response.surfaceRef,
          cause,
          waited_ms: response.waitedMs,
          detail,
        })
        : `${cause}\n`);
      writeStderr(this, `${cause}: ${detail}\n`);
      return undefined;
    }
    case 'timeout':
      // Reports the `--timeout` value as given, not the measured wait: "you asked
      // for 600s and got none of it" is the fact the caller can act on.
      return failWith(this, EXIT_TIMED_OUT, `timed out after ${timeoutSeconds}s waiting for ${response.surfaceRef} to ${flags.until === 'exit' ? 'exit' : 'go quiet'}`);
    case 'died':
      return failWith(this, EXIT_DIED, `${response.surfaceRef} exited after ${formatDuration(response.waitedMs)}`);
  }
}

/**
 * Fail with an exit code other than `dor`'s usual 1. stricli assigns its own
 * exit code with `??=`, so a code set here survives a `void` return — which is
 * also why this writes the `Error:` line itself instead of returning an Error
 * (that path is hard-wired to 1).
 */
function failWith(context: DorCommandContext, exitCode: number, message: string): undefined {
  writeStderr(context, `Error: ${message}\n`);
  context.process.exitCode = exitCode;
  return undefined;
}

/** The stderr narrative, minus its `<cause>: ` prefix — the JSON `detail` field. */
function narrative(cause: AwaitCause, until: AwaitUntil, waitedMs: number): string {
  switch (cause) {
    case 'quiet':
      return `output stopped after ${formatDuration(waitedMs)}`;
    case 'exit':
      return `command exited after ${formatDuration(waitedMs)}`;
    case 'bell':
      return `surface rang after ${formatDuration(waitedMs)}`;
    case 'idle':
      // Says what the grace window was actually testing for, which differs by
      // `--until`: output under quiet, a command start under exit.
      return until === 'exit'
        ? `no command started within ${GRACE_WINDOW_TEXT}`
        : `no output within ${GRACE_WINDOW_TEXT}, nothing was running`;
  }
}

/** `45s` under a minute, `10m 15s` / `3m 02s` above it. */
function formatDuration(waitedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, waitedMs) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function parseUntil(input: string): AwaitUntil {
  if (input === 'quiet' || input === 'exit') return input;
  throw new SyntaxError(`invalid --until '${input}' (expected quiet or exit)`);
}

function parseTimeoutSeconds(input: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    throw new SyntaxError(`invalid --timeout '${input}'`);
  }
  return value;
}
