/**
 * The real `dor` CLI's text, for the playground `dor` to print: each command's
 * `--help` (the snapshots `dor/test/cli-help.test.mjs` pins to the CLI) and
 * the bundled agent skill. The names load with the page; the text on first use.
 */
const SNAPSHOTS = import.meta.glob("../../../../dor/test/snapshots/help/*.md", {
  query: "?raw", import: "default",
}) as Record<string, () => Promise<string>>;

const HELP = new Map(Object.entries(SNAPSHOTS).map(([path, load]) => {
  const name = /([^/]+)\.md$/.exec(path)![1];
  return [name === "dor" ? "" : name, load];
}));

/** Every `dor` command name. */
export const DOR_COMMANDS: ReadonlySet<string> = new Set([...HELP.keys()].filter(Boolean));

/** `dor <command> --help`; `""` is `dor --help`. */
export async function dorHelp(command: string): Promise<string> {
  const text = /```text\n([\s\S]*?)\n```/.exec(await HELP.get(command)!())?.[1];
  if (text === undefined) throw new Error(`malformed help snapshot for '${command || "dor"}'`);
  return `${text}\n`;
}

/** What `dor skill` prints. */
export async function dorSkill(): Promise<string> {
  return (await import("../../../../dor/skill.md?raw")).default;
}
