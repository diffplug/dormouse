import { browserLeafMeta, terminalLeafMeta } from "dormouse-lib/components/wall/lath-wall-engine";
import { BOLD, DIM, OSC_COMMAND_START, OSC_PROMPT_END, OSC_PROMPT_START, RESET, fg, oscCommandLine, oscCwd } from "dormouse-lib/lib/ansi";
import type { LathPersistedLayout } from "dormouse-lib/lib/lath/persistence";
import type { OpenPort } from "dormouse-lib/lib/platform/types";
import type { PersistedDoor } from "dormouse-lib/lib/session-types";
import { wrap } from "../../lib/wrap";
import { YOUTUBE_MUSIC_VIDEO, youtubeEmbedUrl } from "../../lib/youtube";

/**
 * What each homepage VS Code demo shows: its Sessions, how the Wall lays them
 * out, and anything opened once they have painted. Each terminal's output is
 * written once on spawn; nothing plays.
 */

export type SceneName = "video" | "agent" | "ports";

export interface DemoSession {
  command: string;
  /** What it printed after its command line. Absent for a Door, which never
   *  spawns: its state is seeded instead. */
  data?: string;
  ports?: OpenPort[];
  /** A title it set (OSC 0), as an agent CLI names its task. */
  title?: string;
  /** Marked TODO once it spawns. */
  todo?: boolean;
}

export interface DemoScene {
  /** Its own, so the demos' Walls never answer for each other. */
  workspaceId: string;
  sessions: Record<string, DemoSession>;
  layout: LathPersistedLayout;
  doors?: PersistedDoor[];
  /** Panes whose headers a cursor right-clicks in turn, on a loop while the
   *  window is on screen, each opening its terminal context. */
  contextTour?: string[];
}

export const CWD = "/Users/you/acorn";

const GREEN = fg(32);
const RED = fg(31);
const YELLOW = fg(33);
const CYAN = fg(36);
const PROMPT = `${DIM}~/acorn${RESET} ${YELLOW}❯${RESET} `;

const lines = (...rows: string[]) => rows.join("\r\n");

/** A shell prompt that ran `command`, marked with the shell-integration
 *  sequences Dormouse's own integration emits, so each header derives its
 *  command and cwd as it would from a real shell. */
export const ran = (command: string) =>
  `${oscCwd(CWD)}${OSC_PROMPT_START}${PROMPT}${OSC_PROMPT_END}${command}\r\n${oscCommandLine(command)}${OSC_COMMAND_START}`;

const listening = (port: number, pid: number): OpenPort => ({ protocol: "tcp", family: "IPv4", address: "127.0.0.1", port, pid, processName: "node" });

const vite = (port: number, ...after: string[]) => lines(
  "",
  `  ${GREEN}${BOLD}VITE${RESET} ${GREEN}v7.1.4${RESET}  ${DIM}ready in${RESET} ${BOLD}284${RESET} ${DIM}ms${RESET}`,
  "",
  `  ${GREEN}➜${RESET}  ${BOLD}Local${RESET}:   ${CYAN}http://localhost:${BOLD}${port}${RESET}${CYAN}/${RESET}`,
  `  ${GREEN}➜${RESET}  ${DIM}${BOLD}Network${RESET}${DIM}: use ${RESET}${BOLD}--host${RESET}${DIM} to expose${RESET}`,
  ...after,
);

const hmr = (time: string, file: string) => `${DIM}${time}${RESET} ${CYAN}${BOLD}[vite]${RESET} ${GREEN}hmr update${RESET} ${DIM}${file}${RESET}`;

const metaFor = (sessions: Record<string, DemoSession>, ...ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, terminalLeafMeta(sessions[id].command)]));

const doorsFor = (sessions: Record<string, DemoSession>, ...ids: string[]): PersistedDoor[] =>
  ids.map((id) => ({ id, ...terminalLeafMeta(sessions[id].command) }));

// --- "Tmux with browsers": two Workspaces in one VS Code window, the music
// video in an editor tab and an agent in the bottom panel, its dev server a Door. ---

// Surface ids as the app mints them, distinct across the demos since they
// share the registry.
const W = {
  video: "surface:1",
  agent: "surface:2",
  dev: "surface:3",
};

/** The panel's terminal is about this wide in columns. */
const PANEL_COLUMNS = 80;

const VIDEO: DemoScene = {
  workspaceId: "vscode-demo-editor",
  sessions: {},
  layout: {
    version: 1,
    tree: { root: { kind: "leaf", id: W.video } },
    leafMeta: { [W.video]: browserLeafMeta("Dormouse music video", { url: youtubeEmbedUrl(YOUTUBE_MUSIC_VIDEO) }) },
  },
};

const AGENT_SESSIONS: Record<string, DemoSession> = {
  [W.agent]: {
    command: "claude",
    title: "✳ Dark mode toggle",
    todo: true,
    data: lines(
      `${YELLOW}>${RESET} add a dark mode toggle to settings`,
      "",
      `${YELLOW}●${RESET} Edit ${BOLD}src/pages/Settings.tsx${RESET} ${GREEN}+24${RESET} ${RED}-3${RESET}`,
      `${YELLOW}●${RESET} Edit ${BOLD}src/theme.ts${RESET} ${GREEN}+11${RESET}`,
      `${YELLOW}●${RESET} Ran ${BOLD}pnpm vitest run src/theme.test.ts${RESET}`,
      `  ${DIM}✓ 6 passed${RESET}`,
      "",
      ...wrap("Done. The toggle is in Settings and follows the system theme until you choose, and the dev server has picked up both files.", PANEL_COLUMNS),
      "",
      `${DIM}✻ Worked for 41s · done 11:25 AM${RESET}`,
      `${DIM}${"─".repeat(PANEL_COLUMNS)}${RESET}`,
      `${YELLOW}>${RESET} `,
    ),
  },
  [W.dev]: { command: "pnpm dev" },
};

const AGENT: DemoScene = {
  workspaceId: "vscode-demo-panel",
  sessions: AGENT_SESSIONS,
  layout: {
    version: 1,
    tree: { root: { kind: "leaf", id: W.agent } },
    leafMeta: metaFor(AGENT_SESSIONS, W.agent),
  },
  doors: doorsFor(AGENT_SESSIONS, W.dev),
};

// --- "Terminals that know their ports": two dev servers, one above the other, each
// right-clicked in turn to show the ports its own process tree listens on. ---

const P = {
  web: "surface:4",
  api: "surface:5",
};

const PORTS_SESSIONS: Record<string, DemoSession> = {
  [P.web]: {
    command: "pnpm dev",
    data: vite(3000, hmr("10:14:52 AM", "/src/pages/Login.tsx"), hmr("10:15:06 AM", "/src/pages/Login.tsx")),
    ports: [listening(3000, 5120), listening(24678, 5120)],
  },
  [P.api]: {
    command: "wrangler dev",
    data: lines(
      "",
      ` ${BOLD}⛅️ wrangler${RESET} 4.38.0`,
      `${DIM}───────────────────${RESET}`,
      "Your Worker has access to the following bindings:",
      `- D1 Databases:`,
      `  - DB: acorn-db ${DIM}(local)${RESET}`,
      `${GREEN}[wrangler:info]${RESET} Ready on ${CYAN}http://localhost:8787${RESET}`,
      `${GREEN}[wrangler:info]${RESET} GET /api/habits ${GREEN}200${RESET} OK ${DIM}(12ms)${RESET}`,
    ),
    ports: [listening(8787, 5288), listening(9229, 5288)],
  },
};

const PORTS: DemoScene = {
  workspaceId: "vscode-demo-ports",
  sessions: PORTS_SESSIONS,
  layout: {
    version: 1,
    tree: {
      root: {
        kind: "split",
        dir: "col",
        children: [
          { node: { kind: "leaf", id: P.web }, weight: 0.5 },
          { node: { kind: "leaf", id: P.api }, weight: 0.5 },
        ],
      },
    },
    leafMeta: metaFor(PORTS_SESSIONS, P.web, P.api),
  },
  contextTour: [P.web, P.api],
};

export const SCENES: Record<SceneName, DemoScene> = { video: VIDEO, agent: AGENT, ports: PORTS };
