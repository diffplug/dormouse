// Browser-safe: the website playground's dor routes help as the CLI does.

/** Map a bare top-level `--version`/`-v` to the `version` command, as most CLIs
 * accept it (dor has no conflicting `-v`). Only the sole-argument form is
 * rewritten; a trailing `--version` on a subcommand stays that command's concern. */
export function normalizeVersionAlias(argv: string[]): string[] {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    return ['version'];
  }
  return argv;
}

/** A browser provider's own `--help`, the only argument of its passthrough dor reads. */
export function isPassthroughHelpInvocation(argv: string[]): boolean {
  return argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h');
}

export type HelpTarget =
  | { scope: 'root' }
  | { scope: 'command'; commandName: string };

export function getHelpTarget(argv: string[], isCommandName: (value: string) => boolean): HelpTarget | undefined {
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
