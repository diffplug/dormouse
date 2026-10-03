import { isBrowserProvider, type BrowserAutomationProvider } from 'dor-lib-common';
import { builtinHandler, VIEW_ERROR_ARGV } from 'dor-tools-builtin/file-viewer-format';
import { agentBrowserCommand, runAgentBrowserCli } from './commands/agent-browser.js';
import { appCommand } from './commands/app.js';
import { awaitCommand } from './commands/await.js';
import { ensureCommand } from './commands/ensure.js';
import { iframeCommand } from './commands/iframe.js';
import { moveCommand } from './commands/move.js';
import { killCommand } from './commands/kill.js';
import { listCommand } from './commands/list.js';
import { readCommand } from './commands/read.js';
import { sendCommand } from './commands/send.js';
import { skillCommand } from './commands/skill.js';
import { splitCommand } from './commands/split.js';
import { toolCommand } from './commands/tool.js';
import { openCommand } from './commands/open.js';
import { playwrightCommand, runPlaywrightCli } from './commands/playwright.js';
import { versionCommand } from './commands/version.js';
import { workspaceCommand } from './commands/workspace.js';
import { buildDorApplication, runDorCommand } from './cli-app.js';
import { canonicalDorVerb } from './protocol.js';
import { getHelpTarget, isPassthroughHelpInvocation, normalizeVersionAlias, type HelpTarget } from './help-route.js';
import type {
  CliOptions,
  CliResult,
  Command,
  HelpPatch,
} from './commands/types.js';

export type {
  AppRestartResponse,
  AwaitCause,
  AwaitSurfaceOutcome,
  AwaitSurfaceRequest,
  AwaitSurfaceResponse,
  AwaitUntil,
  BrowserExec,
  BrowserExecResult,
  BrowserSurfaceRequest,
  BrowserSurfaceResponse,
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
  MoveSurfaceRequest,
  MoveSurfaceResponse,
  KillSurfaceConfirmation,
  KillSurfaceRequest,
  KillSurfaceResponse,
  ListScope,
  ListSurfacesRequest,
  ListSurfacesResponse,
  ListWorkspacesRequest,
  ListWorkspacesResponse,
  NewWorkspaceRequest,
  CloseWorkspaceRequest,
  RenameWorkspaceRequest,
  SwitchWorkspaceRequest,
  WorkspaceMutationResponse,
  WorkspaceRow,
  ReadSurfaceRequest,
  ReadSurfaceResponse,
  ResolvedSplitDirection,
  ResolveOpenTargetRequest,
  ResolveOpenTargetResponse,
  SendSurfaceRequest,
  SendSurfaceResponse,
  SplitDirection,
  SplitSurfaceRequest,
  SplitSurfaceResponse,
  Surface,
  SurfaceActivity,
  SurfaceKind,
  SurfacePort,
  SurfaceRenderMode,
  SurfaceView,
  ToolSurfaceRequest,
  ToolSurfaceResponse,
  VersionMetadata,
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
  moveCommand,
  iframeCommand,
  agentBrowserCommand,
  playwrightCommand,
  listCommand,
  workspaceCommand,
  appCommand,
] as const satisfies readonly Command[];

const APPLICATION = buildDorApplication(COMMANDS);

export async function runCli(rawArgv: string[], options: CliOptions = {}): Promise<CliResult> {
  // `dor o` is `dor open` from here on, so preParse, help patches, and the
  // command lookup see one name.
  const [verb, ...rest] = normalizeVersionAlias(rawArgv);
  const argv = verb === undefined ? [] : [canonicalDorVerb(verb), ...rest];
  // Private host helper: stdout stays on a host-owned pipe, never a terminal
  // or control-socket response. The marker separates shell startup chatter.
  if (argv[0] === '__launch-env' && argv.length === 2 && /^[a-f0-9]{32}$/.test(argv[1])) {
    const env = { ...(options.env ?? process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    // A JSON copy loses process.env's case-insensitive Windows lookup.
    if (process.platform === 'win32') {
      for (const key of Object.keys(env)) {
        const canonical = key.toUpperCase();
        if ((canonical === 'PATH' || canonical === 'PATHEXT') && key !== canonical) {
          env[canonical] = env[key];
          delete env[key];
        }
      }
    }
    return { stdout: `\n${argv[1]}:${Buffer.from(JSON.stringify(env)).toString('base64')}\n`, stderr: '', exitCode: 0 };
  }

  // `dor agent-browser <args...>` and `dor playwright <args...>` forward args verbatim to the
  // provider's CLI, so they must never reach stricli's flag parser. Only a bare
  // `--help`/`-h` (or `dor help agent-browser`, normalized above) falls through
  // to stricli.
  if (isBrowserProvider(argv[0]) && !isPassthroughHelpInvocation(argv)) {
    return BROWSER_CLIS[argv[0]](argv.slice(1), options);
  }
  // `dor __view-file <file>` and the other `BUILTIN_HANDLERS` verbs are the
  // built-in Tools' private entries (docs/specs/dor-tools-builtin.md). Their
  // servers outlive this call; title and announcement are the only output.
  // `builtin:folder`'s page selects and activates files with OSC 367 `open`.
  const builtin = builtinHandler('argv', argv[0]);
  if (builtin && argv.length === 2) {
    const { runFileViewer, runFolderViewer } = await loadBuiltinViewers();
    const stdout = builtin.opens === 'folder' ? await runFolderViewer(argv[1]) : await runFileViewer(argv[1], builtin.format);
    return { stdout, stderr: '', exitCode: 0 };
  }
  // `dor __view-error <target> <message>` is the page a failed OSC 367 `open`
  // shows in the preview slot.
  if (argv[0] === VIEW_ERROR_ARGV && argv.length === 3) {
    const { runErrorViewer } = await loadBuiltinViewers();
    return { stdout: await runErrorViewer(argv[1], argv[2]), stderr: '', exitCode: 0 };
  }

  const helpTarget = getHelpTarget(argv, isCommandName);
  const [commandName, ...args] = rewriteHelpArgv(argv);

  const result = await runDorCommand(APPLICATION, COMMANDS, commandName, args, options, helpTarget !== undefined);
  return { ...result, stdout: applyHelpPatches(result.stdout, helpTarget) };
}

/** Resolve from the running CLI, never a workspace package or the caller's cwd.
 * The URL import leaves the builtins outside dor.js and in this same process. */
function loadBuiltinViewers(): Promise<typeof import('dor-tools-builtin/runtime')> {
  return import(new URL('./builtin/runtime.js', import.meta.url).href);
}

/** Each browser provider's passthrough, run under its id as the command. */
const BROWSER_CLIS: Record<BrowserAutomationProvider, (args: string[], options: CliOptions) => Promise<CliResult>> = {
  'agent-browser': runAgentBrowserCli,
  playwright: runPlaywrightCli,
};

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

