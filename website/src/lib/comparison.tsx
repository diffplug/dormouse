/**
 * Everything `/comparison` says: one write-up per alternative, then the table.
 *
 * The page links readers here to suggest corrections, so this file is the one
 * place a claim is stated — `website/src/pages/Comparison.tsx` only renders it.
 * Every table row must answer for every tool; the `Record` makes a missing one
 * a type error rather than a blank cell.
 */
import type { ReactNode } from "react";
import { LINK_CLASS } from "../components/docs-tokens";
import { sitePath } from "./site-meta";

export type Support = "yes" | "partial" | "no" | "unknown";

/** A bare verdict, or one with a few words of qualification under it. */
export type Cell = Support | { support: Support; note: string };

export type Tool = {
  id: ToolId;
  name: string;
  /** Where the name links. Omitted for Dormouse, which the reader is already on. */
  href?: string;
  /** What the tool is, in a few words, under its name. */
  blurb: string;
};

export type ToolId = "dormouse" | "cmux" | "herdr" | "claude-desktop" | "codex-app";

export type ComparisonRow = { label: string; cells: Record<ToolId, Cell> };

export type ComparisonGroup = { title: string; rows: readonly ComparisonRow[] };

/** Repo-relative path of this file, for the page's "let us know" link. */
export const COMPARISON_SOURCE_PATH = "website/src/lib/comparison.tsx";

/** Columns, left to right. Dormouse first; the page highlights it. */
export const TOOLS: readonly Tool[] = [
  { id: "dormouse", name: "Dormouse", blurb: "Terminal for VS Code and desktop" },
  { id: "cmux", name: "cmux", href: "https://github.com/manaflow-ai/cmux", blurb: "Native macOS terminal" },
  { id: "herdr", name: "herdr", href: "https://herdr.dev", blurb: "Multiplexer inside your terminal" },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    href: "https://claude.com/download",
    blurb: "Anthropic's desktop app",
  },
  {
    id: "codex-app",
    name: "Codex app",
    href: "https://developers.openai.com/codex/app",
    blurb: "OpenAI's desktop app",
  },
];

export const COMPARISON: readonly ComparisonGroup[] = [
  {
    title: "Where it runs",
    rows: [
      {
        label: "macOS",
        cells: { dormouse: "yes", cmux: "yes", herdr: "yes", "claude-desktop": "yes", "codex-app": "yes" },
      },
      {
        label: "Windows",
        cells: {
          dormouse: "yes",
          cmux: "no",
          herdr: { support: "partial", note: "Preview" },
          "claude-desktop": "yes",
          "codex-app": "yes",
        },
      },
      {
        label: "Linux",
        cells: { dormouse: "yes", cmux: "no", herdr: "yes", "claude-desktop": "no", "codex-app": "no" },
      },
      {
        label: "Inside VS Code",
        cells: {
          dormouse: "yes",
          cmux: "no",
          herdr: { support: "partial", note: "In the integrated terminal" },
          "claude-desktop": { support: "no", note: "Separate extension" },
          "codex-app": { support: "no", note: "Separate extension" },
        },
      },
      {
        label: "Source available",
        cells: {
          dormouse: { support: "yes", note: "FSL, MIT after two years" },
          cmux: { support: "yes", note: "GPL-3.0" },
          herdr: { support: "yes", note: "AGPL-3.0" },
          "claude-desktop": "no",
          "codex-app": "no",
        },
      },
    ],
  },
  {
    title: "Terminals",
    rows: [
      {
        label: "Runs any CLI agent, unmodified",
        cells: {
          dormouse: "yes",
          cmux: "yes",
          herdr: "yes",
          "claude-desktop": { support: "no", note: "Claude only" },
          "codex-app": { support: "no", note: "Codex only" },
        },
      },
      {
        label: "Tiled panes",
        cells: { dormouse: "yes", cmux: "yes", herdr: "yes", "claude-desktop": "no", "codex-app": "no" },
      },
      {
        label: "Mouse-first selection and copy",
        cells: {
          dormouse: "yes",
          cmux: "partial",
          herdr: "partial",
          "claude-desktop": "unknown",
          "codex-app": "unknown",
        },
      },
      {
        label: "Sessions survive a restart",
        cells: {
          dormouse: "yes",
          cmux: "yes",
          herdr: { support: "yes", note: "Background server" },
          "claude-desktop": "partial",
          "codex-app": "partial",
        },
      },
      {
        label: "A CLI the agent can script",
        cells: {
          dormouse: { support: "yes", note: "dor" },
          cmux: "yes",
          herdr: "yes",
          "claude-desktop": "no",
          "codex-app": "no",
        },
      },
    ],
  },
  {
    title: "Alerts",
    rows: [
      {
        label: "Alerts when an agent needs you",
        cells: {
          dormouse: { support: "yes", note: "Zero configuration" },
          cmux: "yes",
          herdr: "yes",
          "claude-desktop": "yes",
          "codex-app": "yes",
        },
      },
      {
        label: "Spoken alerts",
        cells: {
          dormouse: { support: "yes", note: "Opt-in; system voice is free" },
          cmux: "unknown",
          herdr: "unknown",
          "claude-desktop": "unknown",
          "codex-app": "unknown",
        },
      },
      {
        label: "Push notifications",
        cells: {
          dormouse: { support: "yes", note: "To your phone, through Pocket" },
          cmux: { support: "partial", note: "Desktop only" },
          herdr: "unknown",
          "claude-desktop": "unknown",
          "codex-app": "unknown",
        },
      },
      {
        label: "Tracks your attention to minimize interruptions",
        cells: {
          dormouse: { support: "yes", note: "Only alerts for what you haven't seen" },
          cmux: "unknown",
          herdr: "unknown",
          "claude-desktop": "unknown",
          "codex-app": "unknown",
        },
      },
    ],
  },
  {
    title: "Browsers",
    rows: [
      {
        label: "Browser panes beside your terminals",
        cells: {
          dormouse: "yes",
          cmux: "yes",
          herdr: "no",
          "claude-desktop": { support: "no", note: "Uses your Chrome" },
          "codex-app": { support: "partial", note: "In-app browser" },
        },
      },
      {
        label: "An agent can drive them",
        cells: {
          dormouse: "yes",
          cmux: "yes",
          herdr: "no",
          "claude-desktop": { support: "partial", note: "Through Chrome" },
          "codex-app": "yes",
        },
      },
      {
        label: "Unmodified browser automation",
        cells: {
          dormouse: { support: "yes", note: "Playwright, agent-browser" },
          cmux: { support: "no", note: "Private Chromium fork" },
          herdr: "no",
          "claude-desktop": { support: "partial", note: "Chrome extension" },
          "codex-app": "unknown",
        },
      },
      {
        label: "Feels native, no lag",
        cells: {
          dormouse: { support: "partial", note: "Slight lag; the system browser has none" },
          cmux: "yes",
          herdr: "no",
          "claude-desktop": { support: "yes", note: "Your own Chrome" },
          "codex-app": "unknown",
        },
      },
    ],
  },
  {
    title: "Remote",
    rows: [
      {
        label: "Drive it from your phone",
        cells: {
          dormouse: { support: "yes", note: "Pocket" },
          cmux: "unknown",
          herdr: { support: "partial", note: "Over SSH" },
          "claude-desktop": "partial",
          "codex-app": { support: "partial", note: "Cloud tasks" },
        },
      },
      {
        label: "Self-hostable relay",
        cells: { dormouse: "yes", cmux: "no", herdr: "no", "claude-desktop": "no", "codex-app": "no" },
      },
    ],
  },
  {
    title: "Price",
    rows: [
      {
        label: "Free to use",
        cells: {
          dormouse: { support: "yes", note: "Hosted is paid" },
          cmux: "yes",
          herdr: "yes",
          "claude-desktop": { support: "partial", note: "Needs a Claude plan" },
          "codex-app": { support: "partial", note: "Needs a ChatGPT plan" },
        },
      },
    ],
  },
];

/** A claim, optionally with the reasons under it. */
export type Point = ReactNode | { point: ReactNode; because: readonly ReactNode[] };

/** One lead-in sentence and the points it introduces. */
export type VersusSection = { lead: ReactNode; points: readonly Point[] };

/** One tab: Dormouse beside one alternative, or one family of them. */
export type Versus = {
  /** The tab's anchor, which the rail links and a shared URL carries. */
  id: string;
  label: string;
  sections: readonly VersusSection[];
};

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Tabs, left to right, ahead of the table. The first opens by default. */
export const VERSUS: readonly Versus[] = [
  {
    id: "vs-cmux",
    label: "vs cmux",
    sections: [
      {
        lead: "We think you should be using either Dormouse or cmux, because:",
        points: [
          {
            point: "Running coding agents from a terminal beats running them from a GUI:",
            because: [
              "you have more power to coordinate multi-agent flows, and",
              "you are less exposed to vendor lock-in.",
            ],
          },
          "Browsers multiplexed next to your terminals are a huge unlock for watching agents and giving them feedback.",
        ],
      },
      {
        lead: "Some reasons you might prefer cmux:",
        points: [
          "Its terminal is native Rust (Ghostty's), while Dormouse's is xterm.js, the one inside VS Code.",
          <>
            Its browser is a <Ext href="https://github.com/manaflow-ai/cmux-v2">private fork</Ext> of Chromium (it used to
            be WebKit), which feels native and has an API agents can drive. Dormouse drives unmodified Playwright or
            agent-browser, which feels native to your agents but can lag slightly for you. You can open the system browser
            for no lag, but then Dormouse's layout does not manage it.
          </>,
          "It makes orchestrating a fleet of remote SSH boxes easy. Dormouse has not built that yet; it assumes most of your work happens on one or two machines.",
        ],
      },
      {
        lead: "Some reasons you might prefer Dormouse:",
        points: [
          "It drives real, unmodified Playwright or agent-browser rather than a private browser fork.",
          "If you like VS Code (or one of its forks), Dormouse and all of its browser features run there.",
          "If you prefer lightweight standalone apps, the Dormouse download is about 60MB against about 320MB for cmux.",
          <>
            You can <a href={sitePath("/playground")} className={LINK_CLASS}>try Dormouse in your browser</a> without
            installing anything.
          </>,
          "Its alerts track your attention: which panes you have interacted with, so it only dings for something you have not seen. Walk across the room to stretch and it speaks aloud; go for a walk and it can push a notification to your phone.",
        ],
      },
    ],
  },
  {
    id: "vs-desktop-apps",
    label: "vs Claude & Codex Desktop",
    sections: [
      {
        lead: "Claude Desktop and the Codex app wrap one vendor's agent in a polished GUI. Dormouse runs the same agents' CLIs, Claude Code and Codex, in a terminal:",
        points: [
          "A terminal coordinates multi-agent flows a chat window cannot, and any CLI agent can join.",
          "Your workflow is not tied to one vendor's app.",
        ],
      },
      {
        lead: "Some reasons you might prefer a desktop app:",
        points: [
          "Nothing to set up: sign in and start.",
          "Built-in diff review, worktrees, and cloud tasks, designed around that one agent.",
          "You never have to touch a terminal.",
        ],
      },
      {
        lead: "Some reasons you might prefer Dormouse:",
        points: [
          "Claude Code, Codex, and any other CLI agent run side by side in one layout.",
          "One alert model across all of them, which knows what you have already seen.",
          "Browser panes your agents drive, next to the terminals they run in.",
          "It runs inside VS Code, and on Linux.",
        ],
      },
    ],
  },
  {
    id: "vs-herdr",
    label: "vs herdr",
    sections: [
      {
        lead: "herdr and Dormouse agree that coding agents belong in real terminal panes, with a multiplexer that knows which agents need you.",
        points: [],
      },
      {
        lead: "Some reasons you might prefer herdr:",
        points: [
          "It runs inside the terminal you already use — Ghostty, kitty, WezTerm, even tmux — and over SSH.",
          "Its background server keeps agents running when your client disconnects.",
          "It is keyboard-first, for people who never want to reach for the mouse.",
        ],
      },
      {
        lead: "Some reasons you might prefer Dormouse:",
        points: [
          "Mouse-friendly: split, drag, select, and copy as you would in any app.",
          "Browser panes next to your terminals, which your agents can drive.",
          "It runs inside VS Code, and on your phone.",
        ],
      },
    ],
  },
  {
    id: "vs-tmux",
    label: "vs tmux & zellij",
    sections: [
      {
        lead: "Dormouse borrows tmux's model — panes, splits, and its keybinds — and adds the mouse, browsers, and agent alerts.",
        points: [],
      },
      {
        lead: "Some reasons you might prefer tmux or zellij:",
        points: [
          "They run anywhere a shell does, including over SSH, and sessions survive a disconnect.",
          "Years of plugins, configuration, and muscle memory.",
          "No GUI at all.",
        ],
      },
      {
        lead: "Some reasons you might prefer Dormouse:",
        points: [
          "Keep your tmux keybinds and use the mouse as well.",
          "Alerts when an agent in any pane needs you.",
          "Browser panes in the same layout as your terminals.",
          "You can still run tmux inside a Dormouse pane.",
        ],
      },
    ],
  },
];
