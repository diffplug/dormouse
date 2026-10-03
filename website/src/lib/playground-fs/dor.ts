/**
 * The desktop playground's `dor` (docs/specs/tutorial.md -> Playground
 * filesystem): the real CLI over the playground's `CliHost` and a control
 * client that sends each request to the Wall, and the private `__view-*`
 * entries a built-in Tool runs, which announce virtual viewers instead of ports.
 */
import { errorLine, printable } from "dor/commands/terminal-text";
import { errorMessage } from "dor/commands/shared";
import type { PickerTerminal } from "dor/commands/types";
import { builtinHandler, VIEW_ERROR_ARGV } from "dor-tools-builtin/file-viewer-format";
import { viewerAnnouncement } from "dor-tools-builtin/viewer-http";
import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import type { InteractiveProgram } from "../tutorial-shell";
import { PlaygroundControlClient } from "./control-client";
import type { VirtualFs } from "./vfs";
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

const errorText = (error: unknown) => `${errorLine(printable(errorMessage(error)))}\r\n`;
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

export function startPlaygroundDor(options: PlaygroundDorOptions): InteractiveProgram {
  const [verb = "", ...rest] = options.args;
  return builtinHandler("argv", verb) || verb === VIEW_ERROR_ARGV ? new DorViewer(options, verb, rest) : new DorCli(options);
}

/** A run that finishes once: `cleanup`, then its last output and exit code. */
abstract class DorProgram implements InteractiveProgram {
  private done = false;
  constructor(protected readonly options: PlaygroundDorOptions) {}
  abstract start(): void;
  abstract handleInput(data: string): void;
  protected abstract cleanup(): void;

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

/** `dor <args>`, run by the real CLI. Input goes to its picker while one is
 * drawn; otherwise Ctrl+C abandons the run, as it interrupts the real one. */
class DorCli extends DorProgram {
  private readonly client = new PlaygroundControlClient(this.options.terminalId);
  private input: ((chunk: string) => void) | null = null;
  private stopPicker: (() => void) | null = null;

  start(): void {
    const { adapter, terminalId, args, cwd, fs } = this.options;
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
    import("./cli")
      .then(({ runPlaygroundCli }) => runPlaygroundCli(args, { fs, cwd, terminalId, client: this.client, terminal }))
      .then(({ exitCode, stdout, stderr }) => this.finish(exitCode, crlf(stdout + stderr)), (error: unknown) => this.finish(1, errorText(error)));
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

/** `dor __view-file|__view-code|__view-folder <path>` and `dor __view-error
 * <target> <message>`: serves a virtual viewer until Ctrl+C, like the real
 * process serving a loopback port. */
class DorViewer extends DorProgram {
  private token: string | null = null;

  constructor(options: PlaygroundDorOptions, private readonly verb: string, private readonly args: string[]) { super(options); }

  start(): void {
    const { adapter, terminalId, viewers, cwd, relay } = this.options;
    const viewer = viewers.open(terminalId, this.verb, this.args, cwd);
    if (viewer instanceof Error) { this.finish(1, errorText(viewer)); return; }
    this.token = viewer.token;
    relay().then(() => {
      if (this.finished) return;
      // Reported before the announcement, whose scan must already find it.
      const port = nextPort++;
      adapter.setOpenPorts(terminalId, [{ protocol: "tcp", family: "IPv4", address: "127.0.0.1", port, pid: 1, processName: "dor" }]);
      adapter.sendOutput(terminalId, viewerAnnouncement({ port, path: viewer.path }, viewer.target));
    }, (error: unknown) => this.finish(1, errorText(error)));
  }

  handleInput(data: string): void {
    if (data.includes("\x03")) this.finish(0);
  }

  protected cleanup(): void {
    if (this.token) this.options.viewers.close(this.token);
    this.options.adapter.setOpenPorts(this.options.terminalId, []);
  }
}
