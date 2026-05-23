#!/usr/bin/env node

type ProcessLike = {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare const process: ProcessLike;

const COMMANDS = new Set([
  'new-split',
  'list-surfaces',
  'list-panels',
  'list-pane-surfaces',
  'focus-surface',
  'focus-panel',
]);

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string): number {
  process.stderr.write(`Error: ${message}\n`);
  return 1;
}

function printHelp(): void {
  print(`dor - control Dormouse from a terminal

Usage:
  dor <command> [options]

Commands:
  new-split <left|right|up|down>
  list-surfaces
  focus-surface <surface>

Aliases:
  list-panels, list-pane-surfaces
  focus-panel
`);
}

function printCommandHelp(command: string): number {
  switch (command) {
    case 'new-split':
      print('Usage: dor new-split <left|right|up|down> [--surface <id|ref|index>] [--panel <id|ref|index>] [--focus <true|false>] [--workspace <id|ref|index>] [--window <id|ref|index>]');
      return 0;
    case 'list-surfaces':
    case 'list-panels':
    case 'list-pane-surfaces':
      print('Usage: dor list-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>] [--pane <id|ref|index>]');
      return 0;
    case 'focus-surface':
    case 'focus-panel':
      print('Usage: dor focus-surface (--surface <id|ref|index> | --panel <id|ref|index>) [--workspace <id|ref|index>] [--window <id|ref|index>]');
      print('       dor focus-surface <id|ref|index>');
      return 0;
    default:
      return fail(`unknown command '${command}'`);
  }
}

function hasControlEndpoint(): boolean {
  return Boolean(process.env.DORMOUSE_CONTROL_SOCKET && process.env.DORMOUSE_CONTROL_TOKEN);
}

function main(argv: string[]): number {
  const [command, ...args] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    printHelp();
    return 0;
  }

  if (!COMMANDS.has(command)) {
    return fail(`unknown command '${command}'`);
  }

  if (args.includes('-h') || args.includes('--help')) {
    return printCommandHelp(command);
  }

  if (!hasControlEndpoint()) {
    return fail('Dormouse control endpoint is not available in this terminal yet.');
  }

  return fail(`command '${command}' is not implemented yet`);
}

process.exitCode = main(process.argv.slice(2));
