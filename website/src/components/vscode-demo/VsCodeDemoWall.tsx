import { useEffect, useState } from "react";
import { Wall } from "dormouse-lib/components/Wall";
import { WorkspaceVisibleContext } from "dormouse-lib/components/wall/wall-context";
import { initPlatform } from "dormouse-lib/lib/platform";
import { disposeSession, initAlertStateReceiver } from "dormouse-lib/lib/terminal-registry";
import { seedLaunchedCommand } from "dormouse-lib/lib/terminal-state-store";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import type { LathPersistedLayout } from "dormouse-lib/lib/lath/persistence";
import type { PersistedDoor } from "dormouse-lib/lib/session-types";
import "dormouse-lib/wall.css";
import { APP_TYPE_SCALE, paintDemoTheme } from "../demo-theme";

/**
 * The real Wall inside the homepage's VS Code window, on the fake PTY: an agent
 * beside the page it just changed and the dev server serving it, with two
 * minimized watchers in the Baseboard. Each terminal's output is written once
 * on spawn; nothing plays. The window around it is `inert`, and the Wall is
 * mounted inactive so it never takes the homepage's keyboard or focus.
 */

const AGENT = "vscode-demo-agent";
const WEB = "vscode-demo-web";
const DEV = "vscode-demo-dev";
const TESTS = "vscode-demo-tests";
const TYPES = "vscode-demo-types";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const CWD = "/Users/you/acorn";
const PROMPT = `${DIM}~/acorn${RESET} ${YELLOW}❯${RESET} `;

const lines = (...rows: string[]) => rows.join("\r\n");

/** A shell prompt that ran `command`, marked with the VS Code shell-integration
 *  sequences Dormouse's own integration emits, so each header derives its
 *  command and cwd as it would from a real shell. */
const ran = (command: string) =>
  `\x1b]7;file://localhost${CWD}\x07\x1b]633;A\x07${PROMPT}\x1b]633;B\x07${command}\r\n\x1b]633;E;${command}\x07\x1b]633;C\x07`;

/** The agent pane's width in columns, near enough: the window never lays out
 *  narrower than `MIN_LAYOUT_WIDTH`, and scales instead. */
const AGENT_COLUMNS = 38;

/** Word-wrap `text` as an agent CLI does, which xterm.js would break mid-word. */
function wrap(text: string, indent = ""): string[] {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    if (row && row.length + 1 + word.length > AGENT_COLUMNS - indent.length) {
      rows.push(row);
      row = word;
    } else row = row ? `${row} ${word}` : word;
  }
  rows.push(row);
  return rows.map((r, i) => (i === 0 ? r : indent + r));
}

/** Each Session's command, and what it has printed. */
const SESSIONS: Record<string, { command: string; data?: string }> = {
  [AGENT]: {
    command: "claude",
    data: lines(
      `${YELLOW}>${RESET} ${wrap("add a dark mode toggle to settings, then check it in the browser", "  ").join("\r\n")}`,
      "",
      `${YELLOW}●${RESET} Edit ${BOLD}src/pages/Settings.tsx${RESET} ${GREEN}+24${RESET} ${RED}-3${RESET}`,
      `${YELLOW}●${RESET} Edit ${BOLD}src/theme.ts${RESET} ${GREEN}+11${RESET}`,
      `${YELLOW}●${RESET} Ran ${BOLD}dor agent-browser open surface:3${RESET}`,
      `  ${DIM}→ localhost:5173/settings${RESET}`,
      `${YELLOW}●${RESET} Ran ${BOLD}dor agent-browser snapshot${RESET}`,
      `  ${DIM}switch "Dark mode" [checked]${RESET}`,
      "",
      ...wrap("Done. The toggle is in Settings and follows the system theme until you choose. The page is open in the pane beside this one."),
      "",
      `${YELLOW}>${RESET} `,
    ),
  },
  [DEV]: {
    command: "pnpm dev",
    data: lines(
      "",
      `  ${GREEN}${BOLD}VITE${RESET} ${GREEN}v7.1.4${RESET}  ${DIM}ready in${RESET} ${BOLD}284${RESET} ${DIM}ms${RESET}`,
      "",
      `  ${GREEN}➜${RESET}  ${BOLD}Local${RESET}:   ${CYAN}http://localhost:${BOLD}5173${RESET}${CYAN}/${RESET}`,
      `  ${GREEN}➜${RESET}  ${DIM}${BOLD}Network${RESET}${DIM}: use ${RESET}${BOLD}--host${RESET}${DIM} to expose${RESET}`,
      `${DIM}3:42:07 PM${RESET} ${CYAN}${BOLD}[vite]${RESET} ${GREEN}hmr update${RESET} ${DIM}/src/pages/Settings.tsx${RESET}`,
      `${DIM}3:42:09 PM${RESET} ${CYAN}${BOLD}[vite]${RESET} ${GREEN}hmr update${RESET} ${DIM}/src/theme.ts${RESET}`,
    ),
  },
  // Doors: minimized, so never spawned; their state is seeded instead.
  [TESTS]: { command: "pnpm vitest" },
  [TYPES]: { command: "pnpm tsc --watch" },
};

const terminal = (title: string) => ({ component: "terminal", tabComponent: "terminal", title });

function demoLayout(url: string): LathPersistedLayout {
  return {
    version: 1,
    tree: {
      root: {
        kind: "split",
        dir: "row",
        children: [
          { node: { kind: "leaf", id: AGENT }, weight: 0.47 },
          {
            node: {
              kind: "split",
              dir: "col",
              children: [
                { node: { kind: "leaf", id: WEB }, weight: 0.62 },
                { node: { kind: "leaf", id: DEV }, weight: 0.38 },
              ],
            },
            weight: 0.53,
          },
        ],
      },
    },
    leafMeta: {
      [AGENT]: terminal(SESSIONS[AGENT].command),
      [WEB]: { component: "browser", tabComponent: "surface", title: "Acorn", params: { url } },
      [DEV]: terminal(SESSIONS[DEV].command),
    },
  };
}

const DOORS: PersistedDoor[] = [TESTS, TYPES].map((id) => ({ id, ...terminal(SESSIONS[id].command) }));

export default function VsCodeDemoWall() {
  useRestoredTheme(undefined, paintDemoTheme);
  const [layout, setLayout] = useState<LathPersistedLayout | null>(null);

  useEffect(() => {
    const fake = initPlatform("fake");
    const ids = Object.keys(SESSIONS);
    // Only its own Sessions: the Pocket demo shares the adapter and the registry.
    const disposeOwn = () => {
      for (const id of ids) {
        disposeSession(id);
        fake.clearScenario(id);
      }
    };
    disposeOwn();
    initAlertStateReceiver();
    for (const [id, { command, data }] of Object.entries(SESSIONS)) {
      if (data === undefined) seedLaunchedCommand(id, command, CWD);
      else fake.setScenario(id, { name: command, chunks: [{ delay: 0, data: ran(command) + data }] });
    }
    fake.setOpenPorts(DEV, [{ protocol: "tcp", family: "IPv4", address: "127.0.0.1", port: 5173, pid: 4173, processName: "node" }]);
    // The file, not its directory: the dev server serves `public/` by exact path.
    setLayout(demoLayout(new URL("/demo-app/index.html", window.location.origin).href));
    return disposeOwn;
  }, []);

  if (!layout) return null;
  return (
    <div className="relative flex h-full min-h-0 w-full" style={APP_TYPE_SCALE}>
      {/* Shown but inactive, as an outgoing Workspace is while it fades: its
          terminals stay attached, and it takes no window input. */}
      <WorkspaceVisibleContext.Provider value={true}>
        <Wall restoredLathLayout={layout} initialDoors={DOORS} initialMode="passthrough" active={false} />
      </WorkspaceVisibleContext.Provider>
    </div>
  );
}
