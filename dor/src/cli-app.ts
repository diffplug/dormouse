// Browser-safe: the website playground runs the commands that need no Node
// through this same application.
import {
  buildApplication,
  buildRouteMap,
  help,
  run as runStricli,
  text_en,
  type ApplicationText,
  type StricliProcess,
} from '@stricli/core';
import { errorLine, errorMessage, fail } from './commands/shared.js';
import type { CliEnv, CliOptions, CliResult, Command, DorCommandContext } from './commands/types.js';

const DOR_TEXT: ApplicationText = {
  ...text_en,
  commandErrorResult: (error, _ansiColor) => errorLine(error.message),
  exceptionWhileLoadingCommandContext: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileLoadingCommandFunction: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileParsingArguments: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileRunningCommand: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  noCommandRegisteredForInput: ({ input }) => `Error: unknown command '${input}'`,
};

/** The `dor` stricli application over `commands`, in their order. */
export function buildDorApplication(commands: readonly Command[]) {
  return buildApplication(
  buildRouteMap({
    routes: Object.fromEntries(commands.map((command) => [command.name, command.command])),
    docs: {
      brief: 'control Dormouse from a terminal',
      fullDescription: 'Dormouse bundles the dor CLI into every terminal it launches.',
    },
  }),
  {
    name: 'dor',
    scanner: {
      allowArgumentEscapeSequence: true,
      caseStyle: 'allow-kebab-for-camel',
    },
    documentation: {
      disableAnsiColor: true,
    },
    localization: {
      text: DOR_TEXT,
    },
  },
  // Replaces stricli's default integration set, which also registers
  // `--help-all`/`-H`. That flag bypasses the `helpPatches` in `applyHelpPatches`
  // (which only fire for `--help`/`-h`), so it printed raw generated usage lines
  // that contradict what the commands accept — `dor ensure ... <command>...`
  // without the `--` that `validateEnsureDelimiter` requires, and the
  // mutually-exclusive `split`/`send` flags shown as freely combinable. Dropping
  // it leaves `--help` as the single documented help surface.
  {
    help: help({
      brief: text_en.briefs.help,
      alias: 'h',
      defaultForRouteMap: true,
      includeHidden: false,
      // stricli would derive these from `documentation`, but an explicit
      // integration set opts out of that defaulting, so restate them.
      formatting: {
        useAliasInUsageLine: false,
        onlyRequiredInUsageLine: false,
        caseStyle: 'convert-camel-to-kebab',
      },
    }),
  },
);
}

interface CaptureProcess extends StricliProcess {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

/** Runs `commandName` with `args` (already routed: aliases canonical, `help`
 * rewritten) through `app`; `help` says the run only prints help. */
export async function runDorCommand(
  app: ReturnType<typeof buildDorApplication>,
  commands: readonly Command[],
  commandName: string | undefined,
  args: string[],
  options: CliOptions,
  help: boolean,
): Promise<CliResult> {
  // Some commands need argv validated *before* stricli parses it (the `--` command
  // tail in `dor ensure`, `dor send`'s input-flag ordering). Each owns that check
  // as `Command.preParse`, defined next to its flags in the command module; here we
  // just dispatch it. `helpTarget` already captured whether this is a help
  // invocation (in which case the command func never runs), so `help` skips it.
  const command = commandName ? commands.find((entry) => entry.name === commandName) : undefined;
  if (command?.preParse && !help) {
    const check = command.preParse(args);
    if (!check.ok) return fail(check.message);
  }

  const capture = createCaptureProcess(options.env);
  await runStricli(app, commandName ? [commandName, ...args] : [], {
    process: capture.process,
    forCommand: (): DorCommandContext => ({
      process: capture.process,
      options,
      commandArgs: args,
    }),
  });

  return {
    exitCode: normalizeExitCode(capture.process.exitCode),
    stdout: capture.stdout(),
    stderr: capture.stderr(),
  };
}

function createCaptureProcess(env: CliEnv | undefined): {
  process: CaptureProcess;
  stdout(): string;
  stderr(): string;
} {
  let stdout = '';
  let stderr = '';
  const process: CaptureProcess = {
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    env: sanitizeEnv(env),
  };

  return {
    process,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function sanitizeEnv(env: CliEnv | undefined): Readonly<Partial<Record<string, string>>> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function normalizeExitCode(exitCode: number | string | null | undefined): number {
  const numeric = typeof exitCode === 'number'
    ? exitCode
    : typeof exitCode === 'string'
      ? Number(exitCode)
      : 0;
  if (numeric === 0) return 0;
  // Commands that need a verdict richer than pass/fail set `process.exitCode`
  // themselves and return void — stricli assigns its own with `??=`, so theirs
  // survives (`dor await`: 2 for a timeout, 3 for a dead surface). Pass such a
  // code through, and collapse everything else to 1: stricli's own codes are all
  // negative and all mean "usage or target error", as does any other shape that
  // could not be a deliberate verdict (NaN, fractional, shell-reserved).
  return Number.isInteger(numeric) && numeric > 0 && numeric < 126 ? numeric : 1;
}
