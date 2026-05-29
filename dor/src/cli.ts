import {
  buildApplication,
  buildRouteMap,
  run as runStricli,
  text_en,
  type ApplicationText,
  type StricliProcess,
} from '@stricli/core';
import { ensureCommand } from './commands/ensure.js';
import { listPaneSurfacesCommand } from './commands/list-pane-surfaces.js';
import { listPanesCommand } from './commands/list-panes.js';
import { splitCommand } from './commands/split.js';
import { fail } from './commands/shared.js';
import type {
  CliEnv,
  CliOptions,
  CliResult,
  Command,
  DorCommandContext,
  ParseResult,
} from './commands/types.js';

export type {
  CliEnv,
  CliOptions,
  CliResult,
  Command,
  ControlClient,
  DorCommandContext,
  EnsureSurfaceRequest,
  EnsureSurfaceResponse,
  IdFormat,
  ListSurfacesRequest,
  ListSurfacesResponse,
  ResolvedSplitDirection,
  SplitDirection,
  SplitSurfaceRequest,
  SplitSurfaceResponse,
  Surface,
} from './commands/types.js';

const COMMANDS = [
  splitCommand,
  ensureCommand,
  listPanesCommand,
  listPaneSurfacesCommand,
] as const satisfies readonly Command[];

const ROUTES = {
  split: splitCommand.command,
  ensure: ensureCommand.command,
  'list-panes': listPanesCommand.command,
  'list-pane-surfaces': listPaneSurfacesCommand.command,
};

const DOR_TEXT: ApplicationText = {
  ...text_en,
  commandErrorResult: (error, _ansiColor) => `Error: ${error.message}`,
  exceptionWhileLoadingCommandContext: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileLoadingCommandFunction: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileParsingArguments: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileRunningCommand: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  noCommandRegisteredForInput: ({ input }) => `Error: unknown command '${input}'`,
};

const APPLICATION = buildApplication(
  buildRouteMap({
    routes: ROUTES,
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
);

interface CaptureProcess extends StricliProcess {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliResult> {
  const helpTarget = getHelpTarget(argv);
  const [commandName, ...args] = argv[0] === 'help' ? ['--help'] : argv;

  if (commandName === 'ensure' && !args.includes('-h') && !args.includes('--help')) {
    const delimiterCheck = validateEnsureDelimiter(args);
    if (!delimiterCheck.ok) return fail(delimiterCheck.message);
  }

  const capture = createCaptureProcess(options.env);
  await runStricli(APPLICATION, commandName ? [commandName, ...args] : [], {
    process: capture.process,
    forCommand: (): DorCommandContext => ({
      process: capture.process,
      options,
    }),
  });

  return {
    exitCode: normalizeExitCode(capture.process.exitCode),
    stdout: applyHelpPatches(capture.stdout(), helpTarget),
    stderr: capture.stderr(),
  };
}

type HelpTarget =
  | { scope: 'root' }
  | { scope: 'command'; commandName: string };

function getHelpTarget(argv: string[]): HelpTarget | undefined {
  if (argv.length === 0 || argv[0] === 'help' || (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))) {
    return { scope: 'root' };
  }

  const commandName = argv[0];
  if (commandName && isCommandName(commandName) && argv.some((arg) => arg === '--help' || arg === '-h')) {
    return { scope: 'command', commandName };
  }

  return undefined;
}

function isCommandName(value: string): value is keyof typeof ROUTES {
  return value in ROUTES;
}

function applyHelpPatches(stdout: string, target: HelpTarget | undefined): string {
  if (!target) return stdout;

  let patched = stdout;
  for (const command of COMMANDS) {
    if (target.scope === 'command' && command.name !== target.commandName) {
      continue;
    }
    for (const patch of command.helpPatches ?? []) {
      if (patch.scope === target.scope) {
        patched = applyHelpPatch(patched, patch.findReplace, patch.remove);
      }
    }
  }
  return patched;
}

function applyHelpPatch(stdout: string, findReplace: readonly string[] | undefined, remove: readonly string[] | undefined): string {
  let patched = stdout;

  if (findReplace) {
    if (findReplace.length % 2 !== 0) {
      throw new Error('help patch findReplace must contain find/replace pairs');
    }
    for (let index = 0; index < findReplace.length; index += 2) {
      const find = findReplace[index] ?? '';
      if (!find) {
        throw new Error('help patch findReplace must not use an empty find pattern');
      }
      patched = applyHelpPattern(patched, find, findReplace[index + 1] ?? '');
    }
  }

  for (const find of remove ?? []) {
    if (!find) {
      throw new Error('help patch remove must not use an empty find pattern');
    }
    patched = applyHelpPattern(patched, find, '');
  }

  return patched;
}

function applyHelpPattern(stdout: string, findPattern: string, replace: string): string {
  const regex = new RegExp(findPattern, 'gm');
  return stdout.replace(regex, () => replace);
}

function validateEnsureDelimiter(args: string[]): ParseResult<void> {
  const delimiterIndex = args.indexOf('--');
  if (delimiterIndex === -1) {
    return { ok: false, message: 'dor ensure requires -- <command...>' };
  }

  for (let index = 0; index < delimiterIndex; index += 1) {
    const arg = args[index];
    if (arg === '--json' || arg === '--minimize') {
      continue;
    }
    if (arg === '--title' || arg === '--surface') {
      const value = args[index + 1];
      if (!value || value.startsWith('-') || index + 1 >= delimiterIndex) {
        return { ok: false, message: `${arg} requires a value` };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      return { ok: false, message: `unknown option '${arg}'` };
    }
    return { ok: false, message: `unexpected argument '${arg}' before --` };
  }

  const command = args.slice(delimiterIndex + 1).join(' ').trim();
  if (!command) {
    return { ok: false, message: 'dor ensure requires a command after --' };
  }

  return { ok: true, value: undefined };
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
  return numeric === 0 || Number.isNaN(numeric) ? 0 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
