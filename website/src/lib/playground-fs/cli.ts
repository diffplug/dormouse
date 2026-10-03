/**
 * The real `dor` CLI (`dor/src/cli-core.ts`) on the desktop playground's
 * `CliHost` (docs/specs/tutorial.md -> Playground filesystem). Loaded the first
 * time a shell runs `dor`: it is most of the playground's bulk.
 */
import { runCli } from "dor/cli-core";
import { fail } from "dor/commands/shared";
import type { CliHost, CliResult, ControlClient, PickerTerminal } from "dor/commands/types";
import changelog from "../../data/changelog.json";
import SKILL_MARKDOWN from "../../../../dor/skill.md?raw";
import { HOME, normalizePath, type VirtualFs } from "./vfs";

export const UNSUPPORTED = "UNSUPPORTED IN PLAYGROUND";

const unsupported = (what: string): never => {
  throw new Error(`${what} is ${UNSUPPORTED}`);
};

/** What the playground's machine is: the snapshot, the page's control
 * channel, and nothing that needs Node. */
function playgroundHost(fs: VirtualFs): CliHost {
  return {
    platform: "linux",
    cwd: () => HOME,
    homedir: () => HOME,
    resolvePath: (base, path) => normalizePath(path.startsWith("/") ? path : `${base}/${path}`),
    // Every run passes its client; the env names no socket.
    connect: () => unsupported("the dor control socket"),
    listFiles: async (cwd, { onFiles }) => {
      onFiles(fs.files(cwd));
      return { truncated: false };
    },
    readTextFile: () => unsupported("dor skill --install"),
    writeTextFile: () => unsupported("dor skill --install"),
    runBrowserCli: async (provider) => fail(`dor ${provider} is ${UNSUPPORTED}`),
    // The playground serves `dor __view-*` itself (`dor.ts`).
    loadBuiltinViewers: () => unsupported("the built-in Tools' runtime"),
    // The latest released Dormouse, which is what the site serves.
    versionMetadata: { version: changelog.releases[0]?.version ?? "unknown", commit: "playground", commitsSinceVersion: 0 },
    skillMarkdown: SKILL_MARKDOWN,
  };
}

export interface PlaygroundCliRun {
  fs: VirtualFs;
  cwd: string;
  terminalId: string;
  client: ControlClient;
  /** The picker draws here when `dor open` runs without a path. */
  terminal: PickerTerminal;
}

export function runPlaygroundCli(argv: string[], { fs, cwd, terminalId, client, terminal }: PlaygroundCliRun): Promise<CliResult> {
  return runCli(argv, {
    host: playgroundHost(fs),
    client,
    terminal,
    env: { PWD: cwd, HOME, DORMOUSE_SURFACE_ID: terminalId },
  });
}
