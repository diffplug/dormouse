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
import { isBrowserProvider } from 'dor-lib-common/browser-providers';
import { builtinHandler, VIEW_ERROR_ARGV } from 'dor-tools-builtin/file-viewer-format';
import { agentBrowserCommand } from './commands/agent-browser.js';
import { appCommand } from './commands/app.js';
import { awaitCommand } from './commands/await.js';
import { ensureCommand } from './commands/ensure.js';
import { iframeCommand } from './commands/iframe.js';
import { moveCommand } from './commands/move.js';
import { killCommand } from './commands/kill.js';
import { listCommand } from './commands/list.js';
import { readCommand } from './commands/read.js';
import { reopenCommand } from './commands/reopen.js';
import { sendCommand } from './commands/send.js';
import { skillCommand } from './commands/skill.js';
import { splitCommand } from './commands/split.js';
import { toolCommand } from './commands/tool.js';
import { openCommand } from './commands/open.js';
import { playwrightCommand } from './commands/playwright.js';
import { versionCommand } from './commands/version.js';
import { workspaceCommand } from './commands/workspace.js';
import { canonicalDorVerb } from './protocol.js';
import type {
  CliEnv,
  CliOptions,
  CliResult,
  Command,
  DorCommandContext,
  HelpPatch,
} from './commands/types.js';


const COMMANDS = [
  splitCommand,
  ensureCommand,
  toolCommand,
  openCommand,
  versionCommand,
  skillCommand,
  sendCommand,
  readCommand,
  awaitCommand,
  killCommand,
  reopenCommand,
  moveCommand,
  iframeCommand,
  agentBrowserCommand,
  playwrightCommand,
  listCommand,
  workspaceCommand,
  appCommand,
] as const satisfies readonly Command[];


/** `dor <rawArgv>` on `options.host`: every command, help, and the built-in
 * Tools' private entries. The Node CLI (`cli.ts`) and the website playground
 * both run it. */
export async function runCli(rawArgv: string[], options: CliOptions): Promise<CliResult> {
  // `dor o` is `dor open` from here on, so preParse, help patches, and the
  // command lookup see one name.
  const [verb, ...rest] = normalizeVersionAlias(rawArgv);
  const argv = verb === undefined ? [] : [canonicalDorVerb(verb), ...rest];
  // `dor agent-browser <args...>` and `dor playwright <args...>` forward args verbatim to the
  // provider's CLI, so they must never reach stricli's flag parser. Only a bare
  // `--help`/`-h` (or `dor help agent-browser`, normalized above) falls through
  // to stricli.
  if (isBrowserProvider(argv[0]) && !isPassthroughHelpInvocation(argv)) {
    return options.host.runBrowserCli(argv[0], argv.slice(1), options);
  }
  // `dor __view-file <file>` and the other `BUILTIN_HANDLERS` verbs are the
  // built-in Tools' private entries (docs/specs/dor-tools-builtin.md). Their
  // servers outlive this call; title and announcement are the only output.
  // `builtin:folder`'s page selects and activates files with OSC 367 `open`.
  const builtin = builtinHandler('argv', argv[0]);
  if (builtin && argv.length === 2) {
    const { runFileViewer, runFolderViewer } = await options.host.loadBuiltinViewers();
    const stdout = builtin.opens === 'folder' ? await runFolderViewer(argv[1]) : await runFileViewer(argv[1], builtin.format);
    return { stdout, stderr: '', exitCode: 0 };
  }
  // `dor __view-error <target> <message>` is the page a failed OSC 367 `open`
  // shows in the preview slot.
  if (argv[0] === VIEW_ERROR_ARGV && argv.length === 3) {
    const { runErrorViewer } = await options.host.loadBuiltinViewers();
    return { stdout: await runErrorViewer(argv[1], argv[2]), stderr: '', exitCode: 0 };
  }

  const helpTarget = getHelpTarget(argv);
  const [commandName, ...args] = rewriteHelpArgv(argv);


  // Some commands need argv validated *before* stricli parses it (the `--` command
  // tail in `dor ensure`, `dor send`'s input-flag ordering). Each owns that check
  // as `Command.preParse`, defined next to its flags in the command module; here we
  // just dispatch it. A help invocation never runs the command func, so it skips it.
  const command = commandName ? COMMANDS.find((entry) => entry.name === commandName) : undefined;
  if (command?.preParse && helpTarget === undefined) {
    const check = command.preParse(args);
    if (!check.ok) return fail(check.message);
  }

  const capture = createCaptureProcess(options.env);
  await runStricli(APPLICATION, commandName ? [commandName, ...args] : [], {
    process: capture.process,
    forCommand: (): DorCommandContext => ({
      process: capture.process,
      options,
      commandArgs: args,
    }),
  });

  return {
    exitCode: normalizeExitCode(capture.process.exitCode),
    stdout: applyHelpPatches(capture.stdout(), helpTarget),
    stderr: capture.stderr(),
  };
}


/** Map a bare top-level `--version`/`-v` to the `version` command, as most CLIs
 * accept it (dor has no conflicting `-v`). Only the sole-argument form is
 * rewritten; a trailing `--version` on a subcommand stays that command's concern. */
function normalizeVersionAlias(argv: string[]): string[] {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    return ['version'];
  }
  return argv;
}

/** A browser provider's own `--help`, the only argument of its passthrough dor reads. */
function isPassthroughHelpInvocation(argv: string[]): boolean {
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

function isCommandName(value: string): boolean {
  return COMMANDS.some((command) => command.name === value);
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

const DOR_TEXT: ApplicationText = {
  ...text_en,
  commandErrorResult: (error, _ansiColor) => errorLine(error.message),
  exceptionWhileLoadingCommandContext: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileLoadingCommandFunction: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileParsingArguments: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  exceptionWhileRunningCommand: (error, _ansiColor) => `Error: ${errorMessage(error)}`,
  noCommandRegisteredForInput: ({ input }) => `Error: unknown command '${input}'`,
};

const APPLICATION = buildApplication(
  buildRouteMap({
    routes: Object.fromEntries(COMMANDS.map((command) => [command.name, command.command])),
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

interface CaptureProcess extends StricliProcess {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
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
