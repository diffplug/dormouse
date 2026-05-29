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
    stdout: capture.stdout(),
    stderr: capture.stderr(),
  };
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
