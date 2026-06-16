import {
  buildApplication,
  buildRouteMap,
  run as runStricli,
  text_en,
  type ApplicationText,
  type StricliProcess,
} from '@stricli/core';
import { agentBrowserCommand, runAgentBrowserCli } from './commands/agent-browser.js';
import { ensureCommand } from './commands/ensure.js';
import { iframeCommand } from './commands/iframe.js';
import { killCommand } from './commands/kill.js';
import { listPaneSurfacesCommand } from './commands/list-pane-surfaces.js';
import { listPanesCommand } from './commands/list-panes.js';
import { readCommand } from './commands/read.js';
import { sendCommand } from './commands/send.js';
import { splitCommand } from './commands/split.js';
import { versionCommand } from './commands/version.js';
import { errorMessage, fail } from './commands/shared.js';
import type {
  CliEnv,
  CliOptions,
  CliResult,
  Command,
  DorCommandContext,
  HelpPatch,
  ParseResult,
} from './commands/types.js';

export type {
  AgentBrowserExec,
  AgentBrowserExecResult,
  AgentBrowserSurfaceRequest,
  AgentBrowserSurfaceResponse,
  CliEnv,
  CliOptions,
  CliResult,
  Command,
  ControlClient,
  DorCommandContext,
  EnsureSurfaceRequest,
  EnsureSurfaceResponse,
  IdFormat,
  IframeSurfaceRequest,
  IframeSurfaceResponse,
  KillSurfaceConfirmation,
  KillSurfaceRequest,
  KillSurfaceResponse,
  ListSurfacesRequest,
  ListSurfacesResponse,
  ReadSurfaceRequest,
  ReadSurfaceResponse,
  ResolvedSplitDirection,
  SendSurfaceRequest,
  SendSurfaceResponse,
  SplitDirection,
  SplitSurfaceRequest,
  SplitSurfaceResponse,
  Surface,
  SurfaceType,
  VersionMetadata,
} from './commands/types.js';

const COMMANDS = [
  splitCommand,
  ensureCommand,
  versionCommand,
  sendCommand,
  readCommand,
  killCommand,
  iframeCommand,
  agentBrowserCommand,
  listPanesCommand,
  listPaneSurfacesCommand,
] as const satisfies readonly Command[];

const ROUTES = {
  split: splitCommand.command,
  ensure: ensureCommand.command,
  version: versionCommand.command,
  send: sendCommand.command,
  read: readCommand.command,
  kill: killCommand.command,
  iframe: iframeCommand.command,
  'agent-browser': agentBrowserCommand.command,
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

export async function runCli(rawArgv: string[], options: CliOptions = {}): Promise<CliResult> {
  const argv = normalizeAgentBrowserAlias(rawArgv);

  // `dor ab <args...>` forwards args verbatim to agent-browser, so they must
  // never reach stricli's flag parser. Only a bare `--help`/`-h` (or
  // `dor help agent-browser`, normalized above) falls through to stricli.
  if (argv[0] === 'agent-browser' && !isAgentBrowserHelpInvocation(argv)) {
    return runAgentBrowserCli(argv.slice(1), options);
  }

  const helpTarget = getHelpTarget(argv);
  const [commandName, ...args] = rewriteHelpArgv(argv);

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

/** `ab` is the documented short alias for `agent-browser`, in any help form. */
function normalizeAgentBrowserAlias(argv: string[]): string[] {
  if (argv[0] === 'ab') return ['agent-browser', ...argv.slice(1)];
  if (argv[0] === 'help' && argv[1] === 'ab') return ['help', 'agent-browser', ...argv.slice(2)];
  return argv;
}

function isAgentBrowserHelpInvocation(argv: string[]): boolean {
  return argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h');
}

type HelpTarget =
  | { scope: 'root' }
  | { scope: 'command'; commandName: string };

function getHelpTarget(argv: string[]): HelpTarget | undefined {
  if (argv[0] === 'help') {
    const subject = argv[1];
    return subject && isCommandName(subject)
      ? { scope: 'command', commandName: subject }
      : { scope: 'root' };
  }
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))) {
    return { scope: 'root' };
  }

  const commandName = argv[0];
  if (commandName && isCommandName(commandName) && argv.some((arg) => arg === '--help' || arg === '-h')) {
    return { scope: 'command', commandName };
  }

  return undefined;
}

function rewriteHelpArgv(argv: string[]): string[] {
  if (argv[0] !== 'help') return argv;
  const subject = argv[1];
  return subject && isCommandName(subject) ? [subject, '--help'] : ['--help'];
}

function isCommandName(value: string): value is keyof typeof ROUTES {
  return value in ROUTES;
}

function applyHelpPatches(stdout: string, target: HelpTarget | undefined): string {
  if (!target) return stdout;

  if (target.scope === 'command') {
    const [usage, detail] = splitCommandHelp(stdout);
    return `${applyScopedHelpPatches(usage, target, 'command-usage')}${applyScopedHelpPatches(detail, target, 'command-detail')}`;
  }

  return applyScopedHelpPatches(stdout, target, 'root');
}

function applyScopedHelpPatches(stdout: string, target: HelpTarget, scope: HelpPatch['scope']): string {
  let patched = stdout;
  for (const command of COMMANDS) {
    if (target.scope === 'command' && command.name !== target.commandName) {
      continue;
    }
    for (const patch of command.helpPatches ?? []) {
      if (patch.scope === scope) {
        patched = applyHelpPatch(patched, patch.findReplace, patch.remove);
      }
    }
  }
  return patched;
}

function splitCommandHelp(stdout: string): [usage: string, detail: string] {
  const usageEnd = stdout.indexOf('\n\n');
  if (usageEnd === -1) {
    return [stdout, ''];
  }
  return [stdout.slice(0, usageEnd), stdout.slice(usageEnd)];
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
  const regex = compileHelpPattern(findPattern);
  return stdout.replace(regex, () => replace);
}

const HELP_PATTERN_TOKENS: Readonly<Record<string, string>> = {
  LS: '^[ \\t]*',
  'TO-EOL': '[^\\n]*(?:\\n|$)',
  WS: '[ \\t]+',
};

function compileHelpPattern(pattern: string): RegExp {
  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const tokenStart = pattern.indexOf('<', index);
    if (tokenStart === -1) {
      source += escapeRegExp(pattern.slice(index));
      break;
    }

    source += escapeRegExp(pattern.slice(index, tokenStart));
    const tokenEnd = pattern.indexOf('>', tokenStart + 1);
    if (tokenEnd === -1) {
      throw new Error(`help patch pattern has unterminated token starting at offset ${tokenStart}`);
    }

    const token = pattern.slice(tokenStart + 1, tokenEnd);
    const tokenSource = HELP_PATTERN_TOKENS[token];
    if (!tokenSource) {
      throw new Error(`unknown help patch token <${token}>`);
    }
    source += tokenSource;
    index = tokenEnd + 1;
  }

  return new RegExp(source, 'gm');
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
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
    if (arg === '--cwd' || arg === '--surface') {
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
