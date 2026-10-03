/**
 * The desktop playground's `dor` (docs/specs/tutorial.md -> Playground
 * filesystem): the real CLI's commands that need no Node, run through its own
 * stricli application over `PlaygroundControlClient`; `open` / `o` with the
 * real picker over the snapshot; and the private `__view-*` entries a built-in
 * Tool runs, which announce virtual viewers instead of ports.
 */
import { runFilePicker } from "dor/commands/open-picker";
import { errorLine, printable, renderJson, renderToolResponse, renderVersion, renderVersionJson } from "dor/commands/terminal-text";
import { getHelpTarget, isPassthroughHelpInvocation, normalizeVersionAlias } from "dor/help-route";
import { buildDorApplication, runDorCommand } from "dor/cli-app";
import { appCommand } from "dor/commands/app";
import { awaitCommand } from "dor/commands/await";
import { ensureCommand } from "dor/commands/ensure";
import { iframeCommand } from "dor/commands/iframe";
import { killCommand } from "dor/commands/kill";
import { listCommand } from "dor/commands/list";
import { moveCommand } from "dor/commands/move";
import { readCommand } from "dor/commands/read";
import { sendCommand } from "dor/commands/send";
import { splitCommand } from "dor/commands/split";
import { toolCommand } from "dor/commands/tool";
import type { PickerTerminal } from "dor/commands/types";
import { workspaceCommand } from "dor/commands/workspace";
import { canonicalDorVerb } from "dor/protocol";
import { isBrowserProvider } from "dor-lib-common/browser-providers";
import { builtinHandler, VIEW_ERROR_ARGV } from "dor-tools-builtin/file-viewer-format";
import { viewerAnnouncement } from "dor-tools-builtin/viewer-http";
import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import changelog from "../../data/changelog.json";
import type { InteractiveProgram } from "../tutorial-shell";
import { PlaygroundControlClient } from "./control-client";
import { HOME, type VirtualFs } from "./vfs";
import { DOR_COMMANDS, dorHelp, dorSkill } from "./dor-reference";
import type { PlaygroundViewers } from "./viewers";

export interface PlaygroundDorOptions {
  adapter: FakePtyAdapter;
  terminalId: string;
  args: string[];
  cwd: string;
  fs: VirtualFs;
  viewers: PlaygroundViewers;
  /** Settles once the service worker can serve viewers; connects it on first call. */
  relay(): Promise<unknown>;
  onExit(exitCode: number): void;
}

/** Ports the virtual viewers report: never a real listener, only distinct per viewer. */
let nextPort = 40000;

const errorText = (message: string) => `${errorLine(printable(message))}\r\n`;
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
const UNSUPPORTED = "UNSUPPORTED IN PLAYGROUND";

/** The real CLI's commands that load without Node: the Wall answers their requests. */
const CLI_COMMANDS = [
  splitCommand, ensureCommand, toolCommand, sendCommand, readCommand, awaitCommand,
  killCommand, moveCommand, iframeCommand, listCommand, workspaceCommand, appCommand,
];
const CLI_APPLICATION = buildDorApplication(CLI_COMMANDS);

/** The commands the playground prints for itself, each taking at most `--json`. */
const SERVED = new Map<string, (json: boolean) => string | Promise<string>>([
  ["version", (json) => {
    // The latest released Dormouse, which is what the site serves.
    const metadata = { version: changelog.releases[0]?.version ?? "unknown", commit: "playground", commitsSinceVersion: 0 };
    return json ? renderVersionJson(metadata) : renderVersion(metadata);
  }],
  ["skill", async (json) => (json ? renderJson({ markdown: await dorSkill() }) : dorSkill())],
]);

/** The real CLI's verbs where the playground can serve them, routed as
 * `dor/src/cli.ts` routes them; its other commands fail as unsupported here
 * rather than unknown. */
export function startPlaygroundDor(options: PlaygroundDorOptions): InteractiveProgram {
  const [first, ...rest] = normalizeVersionAlias(options.args);
  const argv = first === undefined ? [] : [canonicalDorVerb(first), ...rest];
  const verb = argv[0] ?? "";
  const help = isBrowserProvider(verb) && !isPassthroughHelpInvocation(argv) ? undefined : getHelpTarget(argv, (name) => DOR_COMMANDS.has(name));
  if (help) return new DorText(options, 0, () => dorHelp(help.scope === "root" ? "" : help.commandName));
  if (verb === "open") return new DorOpen(options, rest);
  if (builtinHandler("argv", verb) || verb === VIEW_ERROR_ARGV) return new DorViewer(options, verb, rest);
  if (CLI_COMMANDS.some((command) => command.name === verb)) return new DorCli(options, verb, rest);
  const served = SERVED.get(verb);
  const json = rest.length === 1 && rest[0] === "--json";
  if (served && (rest.length === 0 || json)) return new DorText(options, 0, () => served(json));
  const message = DOR_COMMANDS.has(verb) ? `dor ${(served ? argv : [verb]).join(" ")} is ${UNSUPPORTED}` : `unknown command '${first}'`;
  return new DorText(options, 1, () => errorText(message));
}

/** A run that finishes once: `cleanup`, then its last output and exit code. */
abstract class DorProgram implements InteractiveProgram {
  private done = false;
  constructor(protected readonly options: PlaygroundDorOptions) {}
  abstract start(): void;
  handleInput(_data: string): void {}
  protected cleanup(): void {}

  get finished(): boolean { return this.done; }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    this.cleanup();
  }

  protected finish(exitCode: number, text = ""): void {
    if (this.done) return;
    this.dispose();
    if (text) this.options.adapter.sendOutput(this.options.terminalId, text);
    this.options.onExit(exitCode);
  }
}

/** Prints text, once it loads, then exits with `exitCode`. */
class DorText extends DorProgram {
  constructor(options: PlaygroundDorOptions, private readonly exitCode: number, private readonly text: () => string | Promise<string>) { super(options); }
  start(): void {
    Promise.resolve().then(this.text).then((text) => this.finish(this.exitCode, crlf(text)), (error: unknown) => {
      this.finish(1, errorText(error instanceof Error ? error.message : String(error)));
    });
  }
}

interface OpenFlags { preview: boolean; fresh: boolean; minimize: boolean; json: boolean; tool?: string; path?: string }

function parseOpenArgs(args: string[]): OpenFlags | Error {
  const flags: OpenFlags = { preview: false, fresh: false, minimize: false, json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--preview" || arg === "--fresh" || arg === "--minimize" || arg === "--json") flags[arg.slice(2) as "preview"] = true;
    else if (arg === "--tool") {
      if (index + 1 >= args.length) return new Error("--tool needs a name");
      flags.tool = args[++index];
    } else if (arg.startsWith("--tool=")) flags.tool = arg.slice("--tool=".length);
    else if (arg.startsWith("-")) return new Error(`unknown flag '${arg}'`);
    else if (flags.path === undefined) flags.path = arg;
    else return new Error(`unexpected argument '${arg}'`);
  }
  if (flags.preview && (flags.fresh || flags.minimize)) {
    return new Error(`--preview cannot be combined with ${flags.fresh ? "--fresh" : "--minimize"}`);
  }
  return flags;
}

/** `dor open [path]`: the picker when the path is omitted, then one `surface.tool` request. */
class DorOpen extends DorProgram {
  private input: ((chunk: string) => void) | null = null;
  private readonly client = new PlaygroundControlClient(this.options.terminalId);
  private stopPicker: (() => void) | null = null;

  constructor(options: PlaygroundDorOptions, private readonly args: string[]) { super(options); }

  start(): void {
    const flags = parseOpenArgs(this.args);
    if (flags instanceof Error) { this.finish(1, errorText(flags.message)); return; }
    if (flags.path !== undefined) { this.open(flags, flags.path, flags.tool); return; }
    const { adapter, terminalId, cwd, fs } = this.options;
    const terminal: PickerTerminal = {
      columns: () => adapter.getPtySize(terminalId).cols,
      rows: () => adapter.getPtySize(terminalId).rows,
      write: (text) => adapter.sendOutput(terminalId, text),
      listen: (onInput, onResize) => {
        this.input = onInput;
        const stopResize = adapter.onPtyResize(({ id }) => { if (id === terminalId) onResize(); });
        this.stopPicker = () => { this.input = null; stopResize(); };
        return this.stopPicker;
      },
    };
    void runFilePicker({
      terminal,
      listFiles: async (onFiles) => { onFiles(fs.files(cwd)); return { truncated: false }; },
      handlers: (file) => this.client.openHandlers({ target: file, cwd, ...(flags.preview ? { preview: true } : {}) }),
      fixedTool: flags.tool,
      home: HOME,
    }).then((choice) => {
      if (this.finished) return;
      // A cancel opens nothing and prints nothing, but is not a success.
      if (!choice) this.finish(1);
      else this.open(flags, choice.file, choice.tool ?? flags.tool);
    });
  }

  private open(flags: OpenFlags, file: string, tool: string | undefined): void {
    this.client.toolSurface({
      file, tool, fresh: flags.fresh, minimized: flags.minimize, cwd: this.options.cwd,
      ...(flags.preview ? { preview: true } : {}),
    }).then((response) => {
      const warnings = (response.warnings ?? []).map((warning) => `${printable(warning)}\r\n`).join("");
      this.finish(0, warnings + crlf(renderToolResponse(response, flags.json)));
    }, (error: unknown) => this.finish(1, errorText(error instanceof Error ? error.message : String(error))));
  }

  handleInput(data: string): void {
    if (this.input) this.input(data);
    else if (data.includes("\x03")) this.finish(130);
  }

  protected cleanup(): void {
    this.stopPicker?.();
    this.client.cancel();
  }
}

/** One of `CLI_COMMANDS`, run by the real CLI's parser and renderers. */
class DorCli extends DorProgram {
  private readonly client = new PlaygroundControlClient(this.options.terminalId);

  constructor(options: PlaygroundDorOptions, private readonly verb: string, private readonly args: string[]) { super(options); }

  start(): void {
    const { cwd, terminalId } = this.options;
    runDorCommand(CLI_APPLICATION, CLI_COMMANDS, this.verb, this.args, {
      client: this.client,
      env: { PWD: cwd, HOME, DORMOUSE_SURFACE_ID: terminalId },
    }, false).then(({ exitCode, stdout, stderr }) => this.finish(exitCode, crlf(stdout + stderr)));
  }

  handleInput(data: string): void {
    if (data.includes("\x03")) this.finish(130);
  }

  protected cleanup(): void {
    this.client.cancel();
  }
}

/** `dor __view-file|__view-code|__view-folder <path>` and `dor __view-error
 * <target> <message>`: serves a virtual viewer until Ctrl+C, like the real
 * process serving a loopback port. */
class DorViewer extends DorProgram {
  private token: string | null = null;

  constructor(options: PlaygroundDorOptions, private readonly verb: string, private readonly args: string[]) { super(options); }

  start(): void {
    const { adapter, terminalId, viewers, cwd, relay } = this.options;
    const viewer = viewers.open(terminalId, this.verb, this.args, cwd);
    if (viewer instanceof Error) { this.finish(1, errorText(viewer.message)); return; }
    this.token = viewer.token;
    relay().then(() => {
      if (this.finished) return;
      // Reported before the announcement, whose scan must already find it.
      const port = nextPort++;
      adapter.setOpenPorts(terminalId, [{ protocol: "tcp", family: "IPv4", address: "127.0.0.1", port, pid: 1, processName: "dor" }]);
      adapter.sendOutput(terminalId, viewerAnnouncement({ port, path: viewer.path }, viewer.target));
    }, (error: unknown) => {
      this.finish(1, errorText(error instanceof Error ? error.message : String(error)));
    });
  }

  handleInput(data: string): void {
    if (data.includes("\x03")) this.finish(0);
  }

  protected cleanup(): void {
    if (this.token) this.options.viewers.close(this.token);
    this.options.adapter.setOpenPorts(this.options.terminalId, []);
  }
}
