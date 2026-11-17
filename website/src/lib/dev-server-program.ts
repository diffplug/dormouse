import { BOLD, DIM, RESET, fg } from "dormouse-lib/lib/ansi";
import type { OpenPort } from "dormouse-lib/lib/platform/types";
import type { InteractiveProgram, SendOutput } from "./tutorial-shell";

/**
 * The pretend dev server the Ports and browsers section has the user run
 * (`npm run dev`). Like Vite, each one takes the first free port from 5173, so
 * two of them listen on different ports, which their panes' properties show.
 * It serves nothing: the playground cannot frame a page it has no server for.
 */

/** The names `startDevServer` runs, for the shell to complete and suggest. */
export const DEV_SERVER_PROGRAMS = ["npm"] as const;

const FIRST_PORT = 5173;
const INTERRUPT = "\x03";
const EXIT_INTERRUPTED = 130;
const EXIT_USAGE = 1;

/** Ports a running dev server holds, across every pane of the page. */
const portsInUse = new Set<number>();

interface PortReporter {
  setOpenPorts(id: string, ports: OpenPort[]): void;
}

class DevServerProgram implements InteractiveProgram {
  private port: number | null = null;

  constructor(
    private readonly ports: PortReporter,
    private readonly terminalId: string,
    private readonly send: SendOutput,
    private readonly onExit: (exitCode?: number) => void,
  ) {}

  start(): void {
    let port = FIRST_PORT;
    let banner = `\r\n${DIM}> playground@0.0.0 dev\r\n> vite${RESET}\r\n\r\n`;
    while (portsInUse.has(port)) {
      banner += `Port ${port} is in use, trying another one...\r\n`;
      port++;
    }
    portsInUse.add(port);
    this.port = port;
    this.ports.setOpenPorts(this.terminalId, [{ protocol: "tcp", family: "IPv4", address: "127.0.0.1", port, pid: 1, processName: "node" }]);
    this.send(
      `${banner}\r\n  ${fg(32)}${BOLD}VITE${RESET} ${fg(32)}v7.1.2${RESET}  ${DIM}ready in 212 ms${RESET}\r\n\r\n`
      + `  ${fg(32)}➜${RESET}  ${BOLD}Local${RESET}:   ${fg(36)}http://localhost:${BOLD}${port}${RESET}${fg(36)}/${RESET}\r\n`
      + `  ${fg(32)}➜${RESET}  ${DIM}press Ctrl+C to stop${RESET}\r\n`,
    );
  }

  handleInput(data: string): void {
    if (!data.includes(INTERRUPT)) return;
    this.send("^C\r\n");
    this.dispose();
    this.onExit(EXIT_INTERRUPTED);
  }

  dispose(): void {
    if (this.port === null) return;
    portsInUse.delete(this.port);
    this.port = null;
    this.ports.setOpenPorts(this.terminalId, []);
  }
}

/** `npm run dev` as a dev server; any other `npm` command says what runs here. */
export function startDevServer(
  name: string,
  args: string[],
  ports: PortReporter,
  terminalId: string,
  send: SendOutput,
  onExit: (exitCode?: number) => void,
): InteractiveProgram | null {
  if (name !== "npm") return null;
  if (args.length === 2 && args[0] === "run" && args[1] === "dev") return new DevServerProgram(ports, terminalId, send, onExit);
  return {
    start: () => {
      send("The playground's npm only runs `npm run dev`.\r\n");
      onExit(EXIT_USAGE);
    },
    handleInput: () => {},
    dispose: () => {},
  };
}
