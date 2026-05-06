import { BOLD, PROMPT, RESET, fg } from '../ansi';
import type { FakeScenario } from './fake-adapter';

// --- Helpers for building scenarios ---

export interface AlertScenarioChunk {
  at: number;
  data: string;
}

export interface AlertScenarioOptions {
  name?: string;
  exitCode?: number;
}

function typeChars(text: string, msPerChar = 80): { delay: number; data: string }[] {
  return [...text].map((ch) => ({ delay: msPerChar, data: ch }));
}

function instant(text: string, delay = 0): { delay: number; data: string } {
  return { delay, data: text };
}

/** Build a fake scenario from absolute event times for alert-focused tests. */
export function makeAlertScenario(
  chunks: readonly AlertScenarioChunk[],
  options?: AlertScenarioOptions,
): FakeScenario {
  if (chunks.length === 0) {
    throw new Error('makeAlertScenario requires at least one chunk');
  }

  let previousAt = 0;
  return {
    name: options?.name ?? 'alert-scenario',
    chunks: chunks.map((chunk, index) => {
      if (!Number.isFinite(chunk.at) || chunk.at < 0) {
        throw new Error(`Chunk ${index} has an invalid "at" value`);
      }
      if (chunk.at < previousAt) {
        throw new Error(`Chunk ${index} is earlier than the previous chunk`);
      }

      const delay = index === 0 ? chunk.at : chunk.at - previousAt;
      previousAt = chunk.at;
      return { delay, data: chunk.data };
    }),
    exitCode: options?.exitCode,
  };
}

/** Collapse a scenario into a single chunk with all data concatenated and delay 0.
 *  Use this for Chromatic / regression tests where you want instant output. */
export function flattenScenario(scenario: FakeScenario): FakeScenario {
  const allData = scenario.chunks.map((c) => c.data).join('');
  return {
    name: scenario.name,
    chunks: [{ delay: 0, data: allData }],
    exitCode: scenario.exitCode,
  };
}

// --- Scenarios ---

/** Simple shell prompt — waits 500ms then shows prompt. Stays alive for interaction. */
export const SCENARIO_SHELL_PROMPT: FakeScenario = {
  name: 'shell-prompt',
  chunks: [instant(PROMPT, 500)],
  endsWithPrompt: true,
};

/** Types `ls -la` then shows colorized directory listing. */
export const SCENARIO_LS_OUTPUT: FakeScenario = {
  name: 'ls-output',
  chunks: [
    instant(PROMPT, 500),
    ...typeChars('ls -la'),
    instant('\r\n', 50),
    instant(
      [
        `total 48`,
        `${fg(34)}drwxr-xr-x${RESET}  12 user staff   384 Mar 16 10:30 ${BOLD}${fg(34)}.${RESET}`,
        `${fg(34)}drwxr-xr-x${RESET}   6 user staff   192 Mar 15 09:15 ${BOLD}${fg(34)}..${RESET}`,
        `${fg(34)}drwxr-xr-x${RESET}   8 user staff   256 Mar 16 10:28 ${BOLD}${fg(34)}.git${RESET}`,
        `-rw-r--r--${RESET}   1 user staff   247 Mar 16 10:30 CLAUDE.md`,
        `-rw-r--r--${RESET}   1 user staff  1842 Mar 16 09:45 package.json`,
        `${fg(34)}drwxr-xr-x${RESET}   4 user staff   128 Mar 16 10:28 ${BOLD}${fg(34)}src${RESET}`,
        `-rw-r--r--${RESET}   1 user staff   524 Mar 15 14:20 tsconfig.json`,
        `${fg(34)}drwxr-xr-x${RESET}   3 user staff    96 Mar 16 10:25 ${BOLD}${fg(34)}docs${RESET}`,
        `-rw-r--r--${RESET}   1 user staff  3201 Mar 16 10:30 vite.config.ts`,
      ].join('\r\n') + '\r\n',
      100,
    ),
    instant(PROMPT, 200),
  ],
  endsWithPrompt: true,
};

/** Demonstrates all 16 ANSI colors with labels. */
export const SCENARIO_ANSI_COLORS: FakeScenario = {
  name: 'ansi-colors',
  chunks: [
    instant(PROMPT, 500),
    ...typeChars('colortest'),
    instant('\r\n', 50),
    instant(`\r\n${BOLD}  Standard colors:${RESET}\r\n`, 200),
    ...[
      ['Black', 30], ['Red', 31], ['Green', 32], ['Yellow', 33],
      ['Blue', 34], ['Magenta', 35], ['Cyan', 36], ['White', 37],
    ].map(([name, code]) =>
      instant(`  ${fg(code as number)}████${RESET} ${name}\r\n`, 100),
    ),
    instant(`\r\n${BOLD}  Bright colors:${RESET}\r\n`, 200),
    ...[
      ['Bright Black', 90], ['Bright Red', 91], ['Bright Green', 92], ['Bright Yellow', 93],
      ['Bright Blue', 94], ['Bright Magenta', 95], ['Bright Cyan', 96], ['Bright White', 97],
    ].map(([name, code]) =>
      instant(`  ${fg(code as number)}████${RESET} ${name}\r\n`, 100),
    ),
    instant(`\r\n`, 100),
    instant(PROMPT, 200),
  ],
  endsWithPrompt: true,
};

/** Shows a long-running process with progress dots. */
export const SCENARIO_LONG_RUNNING: FakeScenario = {
  name: 'long-running',
  chunks: [
    instant(PROMPT, 500),
    ...typeChars('npm install'),
    instant('\r\n', 50),
    instant(`${fg(33)}Installing dependencies...${RESET} `, 300),
    ...Array.from({ length: 10 }, () => instant('.', 500)),
    instant(` ${fg(32)}done!${RESET}\r\n`, 200),
    instant(`\r\nadded 847 packages in 5.2s\r\n\r\n`, 100),
    instant(PROMPT, 200),
  ],
  endsWithPrompt: true,
};

/**
 * Boxed paragraph for Copy Rewrapped vs Copy Raw demonstration. The frame
 * is pure box-drawing characters so `rewrap.ts` strips them; the text
 * inside wraps across lines so Rewrapped joins them with single spaces.
 */
export const SCENARIO_BOXED_PARAGRAPH: FakeScenario = {
  name: 'boxed-paragraph',
  chunks: [
    instant(
      [
        '',
        `${fg(36)}┌─────────────────────────────────────────┐${RESET}`,
        `${fg(36)}│${RESET}  ${BOLD}Release notes — v1.4.0${RESET}                ${fg(36)}│${RESET}`,
        `${fg(36)}├─────────────────────────────────────────┤${RESET}`,
        `${fg(36)}│${RESET}  MouseTerm now keeps a tab visible       ${fg(36)}│${RESET}`,
        `${fg(36)}│${RESET}  even while a long-running command is    ${fg(36)}│${RESET}`,
        `${fg(36)}│${RESET}  hidden in the baseboard, so background  ${fg(36)}│${RESET}`,
        `${fg(36)}│${RESET}  work never gets lost.                   ${fg(36)}│${RESET}`,
        `${fg(36)}│${RESET}                                          ${fg(36)}│${RESET}`,
        `${fg(36)}│${RESET}  Drag-select the paragraph above and     ${fg(36)}│${RESET}`,
        `${fg(36)}│${RESET}  try Copy Raw vs Copy Rewrapped.         ${fg(36)}│${RESET}`,
        `${fg(36)}└─────────────────────────────────────────┘${RESET}`,
        '',
      ].join('\r\n'),
      400,
    ),
  ],
};

/** Rapid output burst — tests xterm.js scroll performance. */
export const SCENARIO_FAST_OUTPUT: FakeScenario = {
  name: 'fast-output',
  chunks: [
    instant(PROMPT, 500),
    ...typeChars('cat package.json'),
    instant('\r\n', 50),
    ...Array.from({ length: 5 }, (_, i) =>
      instant(
        Array.from({ length: 20 }, (_, j) => {
          const line = i * 20 + j + 1;
          return `${fg(90)}${String(line).padStart(4)}${RESET} │ ${'  '.repeat(j % 3)}${
            j % 2 === 0
              ? `"${['name', 'version', 'type', 'scripts', 'dependencies'][j % 5]}": ${fg(32)}"value-${line}"${RESET},`
              : `${fg(33)}${line * 7}${RESET},`
          }`;
        }).join('\r\n') + '\r\n',
        50,
      ),
    ),
    instant(PROMPT, 200),
  ],
};
