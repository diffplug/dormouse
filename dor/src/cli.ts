import { ensureCommand } from './commands/ensure.js';
import { listPaneSurfacesCommand } from './commands/list-pane-surfaces.js';
import { listPanesCommand } from './commands/list-panes.js';
import { splitCommand } from './commands/split.js';
import { fail, ok } from './commands/shared.js';
import type {
  CliOptions,
  CliResult,
  Command,
} from './commands/types.js';

export type {
  CliEnv,
  CliOptions,
  CliResult,
  Command,
  ControlClient,
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

const COMMANDS: Command[] = [
  splitCommand,
  ensureCommand,
  listPanesCommand,
  listPaneSurfacesCommand,
];

const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliResult> {
  const [commandName, ...args] = argv;
  if (!commandName || commandName === '-h' || commandName === '--help' || commandName === 'help') {
    return ok(printHelp());
  }

  const command = COMMAND_BY_NAME.get(commandName);
  if (!command) {
    return fail(`unknown command '${commandName}'`);
  }

  if (args.includes('-h') || args.includes('--help')) {
    return ok(command.usage);
  }

  return command.run(args, options);
}

function printHelp(): string {
  const commands = COMMANDS.map((command) => `  ${command.name}`).join('\n');
  return `dor - control Dormouse from a terminal

Usage:
  dor <command> [options]

Commands:
${commands}
`;
}
