import { collectTerminalSemanticEvents, TerminalProtocolParser } from '../terminal-protocol';
import { applyTerminalSemanticEvents } from '../terminal-state-store';
import { themeColorProvider } from '../terminal-theme';
import { recordToolEvents } from '../tool-events';
import type { PlatformAdapter } from './types';

/** How long a replay collection waits for the host's name before parsing
 *  without it, as today: an OSC 7 naming any host then reads as remote. */
export const REPLAY_HOST_TIMEOUT_MS = 500;

/** The host machine's name, from its `terminalContext` `home` answer. */
let localHost: string | undefined;
/** Whether the host has answered; until then each collection asks again. */
let answered = false;
export function setReplayLocalHost(name: string | undefined): void {
  localHost = name;
  answered = name !== undefined;
}

/** Learns the host's name for the replays a collection is about to parse,
 *  waiting at most `timeoutMs`; a host that fails or is slow is asked again
 *  by the next collection. Null when there is nothing to wait for. */
export function learnReplayLocalHost(
  platform: Pick<PlatformAdapter, 'terminalContext'>,
  timeoutMs = REPLAY_HOST_TIMEOUT_MS,
): Promise<void> | null {
  if (answered || !platform.terminalContext) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = platform.terminalContext({ op: 'home' }).then((info) => {
    localHost = info.hostname;
    answered = true;
  }, () => {});
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  return Promise.race([answer, deadline]).finally(() => clearTimeout(timer));
}

/**
 * One `pty:replay`, parsed where it lands. Replay arrives as raw buffered
 * output, the one stream its host does not parse for the renderer, so a
 * one-shot parser rebuilds the renderer's Tool and semantic state from it and
 * strips what xterm.js must not see; the visible text is returned. Its reports
 * and responses are dropped: the host's own parse already fed its alerts and
 * answered (`docs/specs/terminal-escapes.md` → "Parsing location"). It still
 * takes the theme, because a *declined* colour query is not consumed and would
 * reach xterm.js instead, and answering is the owner's alone.
 */
export function parseReplay(id: string, data: string): string {
  const parsed = new TerminalProtocolParser(themeColorProvider, localHost).process(data);
  recordToolEvents(id, parsed.events);
  applyTerminalSemanticEvents(id, collectTerminalSemanticEvents(parsed.events));
  return parsed.visibleData;
}
