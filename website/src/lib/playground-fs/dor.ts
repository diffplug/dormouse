/**
 * The desktop playground's `dor` (docs/specs/tutorial.md -> Playground
 * filesystem): `open` / `o` against the snapshot, through the same
 * `surface.tool` request the real CLI sends, and the private `__view-*` entries
 * a built-in Tool runs, which announce virtual viewers instead of ports.
 */
import { runFilePicker } from "dor/commands/open-picker";
import { printable, renderToolResponse } from "dor/commands/terminal-text";
import type { PickerTerminal, ToolSurfaceResponse } from "dor/commands/types";
import { canonicalDorVerb, SURFACE_CONTROL_METHODS } from "dor/protocol";
import { builtinHandler, VIEW_ERROR_ARGV } from "dor-tools-builtin/file-viewer-format";
import { viewerAnnouncement } from "dor-tools-builtin/viewer-http";
import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { cancelDorControlRequest, dispatchDorControlRequest } from "dormouse-lib/lib/platform/dor-control-dispatch";
import type { ToolControlResult, ToolHostRequest } from "dormouse-lib/lib/platform/tool-types";
import type { InteractiveProgram } from "../tutorial-shell";
import { HOME, type VirtualFs } from "./vfs";
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
  toolControl(request: ToolHostRequest): Promise<ToolControlResult>;
  onExit(exitCode: number): void;
}

const USAGE = "Usage: dor open [--preview] [--fresh] [--minimize] [--tool <name>] [path]\r\n"
  + "This playground's dor knows only open (alias o); its files are a read-only copy of dor-tools-lib.\r\n";

/** Ports the virtual viewers report: never a real listener, only distinct per viewer. */
let nextPort = 40000;

const errorLine = (message: string) => `Error: ${printable(message)}\r\n`;
const crlf = (text: string) => text.replace(/\n/g, "\r\n");

export function startPlaygroundDor(options: PlaygroundDorOptions): InteractiveProgram {
  const [verb = "", ...rest] = options.args;
  if (canonicalDorVerb(verb) === "open") return new DorOpen(options, rest);
  if (builtinHandler("argv", verb) || verb === VIEW_ERROR_ARGV) return new DorViewer(options, verb, rest);
  const help = verb === "" || verb === "help" || verb === "--help";
  return new DorMessage(options, help ? 0 : 1, help ? USAGE : errorLine(`unknown command '${verb}'`) + USAGE);
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

class DorMessage extends DorProgram {
  constructor(options: PlaygroundDorOptions, private readonly exitCode: number, private readonly text: string) { super(options); }
  start(): void { this.finish(this.exitCode, this.text); }
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
  private requestId: string | null = null;
  private stopPicker: (() => void) | null = null;

  constructor(options: PlaygroundDorOptions, private readonly args: string[]) { super(options); }

  start(): void {
    const flags = parseOpenArgs(this.args);
    if (flags instanceof Error) { this.finish(1, errorLine(flags.message)); return; }
    if (flags.path !== undefined) { this.open(flags, flags.path, flags.tool); return; }
    const { adapter, terminalId, cwd, fs, toolControl } = this.options;
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
      handlers: async (file) => {
        const result = await toolControl({ op: "open-handlers", target: file, cwd, ...(flags.preview ? { preview: true } : {}) });
        if (result.status !== "open-handlers") throw new Error("unexpected tool host response");
        return result.handlers;
      },
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
    const requestId = this.requestId = crypto.randomUUID();
    dispatchDorControlRequest({
      requestId,
      surfaceId: this.options.terminalId,
      method: SURFACE_CONTROL_METHODS.tool,
      params: {
        file, tool, fresh: flags.fresh, minimized: flags.minimize, cwd: this.options.cwd,
        ...(flags.preview ? { preview: true } : {}),
      },
    }, ({ ok, result, error }) => {
      this.requestId = null;
      if (!ok) { this.finish(1, errorLine(error ?? "request failed")); return; }
      const response = result as ToolSurfaceResponse;
      const warnings = (response.warnings ?? []).map((warning) => `${printable(warning)}\r\n`).join("");
      this.finish(0, warnings + crlf(renderToolResponse(response, flags.json)));
    });
  }

  handleInput(data: string): void {
    if (this.input) this.input(data);
    else if (data.includes("\x03") && this.requestId) this.finish(130);
  }

  protected cleanup(): void {
    this.stopPicker?.();
    if (this.requestId) cancelDorControlRequest(this.requestId);
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
    if (viewer instanceof Error) { this.finish(1, errorLine(viewer.message)); return; }
    this.token = viewer.token;
    relay().then(() => {
      if (this.finished) return;
      // Reported before the announcement, whose scan must already find it.
      const port = nextPort++;
      adapter.setOpenPorts(terminalId, [{ protocol: "tcp", family: "IPv4", address: "127.0.0.1", port, pid: 1, processName: "dor" }]);
      adapter.sendOutput(terminalId, viewerAnnouncement({ port, path: viewer.path }, viewer.target));
    }, (error: unknown) => {
      this.finish(1, errorLine(error instanceof Error ? error.message : String(error)));
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
