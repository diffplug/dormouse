/**
 * The serving trigger: a tool Surface grows a browser in place once its command
 * binds a port (`docs/specs/dor-tool.md` -> Serving).
 *
 * The port scan is the primary trigger and the only one correct under
 * contention: it reports the port a command *bound*, where an announcement
 * would report what it intended. Storybook launched with `-p 6006` in a second
 * worktree lands on 6007, and framing 6006 there would frame the other
 * checkout's server.
 *
 * Only tool-designated Sessions are scanned. An ordinary terminal that opens a
 * port never transforms — that is the Dev-Server Chip's job, and panes must not
 * flip under the user (`docs/specs/dor-tool.md` -> Security).
 */
import { useEffect } from 'react';
import { getPlatform } from '../../lib/platform';
import { getTerminalPaneState } from '../../lib/terminal-registry';
import { isToolParams } from './browser-surface';
import { listenerUrlsByPort } from './port-url';
import { getToolAnnounce } from '../../lib/tool-announce-store';
import type { LathWallEngine } from './lath-wall-engine';
import type { DooredItem } from './wall-types';

// A serving command usually binds within a second or two of starting, but a
// cold `pnpm` boot can take much longer, so this keeps polling for as long as
// the command runs. The scan shells out per Surface (lsof / PowerShell), so the
// cadence is deliberately slow and only tools without a URL are scanned.
const POLL_MS = 1500;

/** Element-wise comparison; a null key never matches. */
function toolKeysEqual(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((el, i) => el === b[i]);
}

type ToolLeaf = { id: string; params: Record<string, unknown> | undefined };

function toolLeaves(lath: LathWallEngine, doors: DooredItem[]): ToolLeaf[] {
  const leaves: ToolLeaf[] = [];
  for (const pane of lath.listPanes()) {
    if (isToolParams(pane.params)) leaves.push({ id: pane.id, params: pane.params });
  }
  for (const door of doors) {
    const params = lath.getMeta(door.id)?.params;
    if (isToolParams(params)) leaves.push({ id: door.id, params });
  }
  return leaves;
}

export function useToolServing({
  lath,
  doorsRef,
}: {
  lath: LathWallEngine;
  doorsRef: React.MutableRefObject<DooredItem[]>;
}): void {
  useEffect(() => {
    const platform = getPlatform();
    if (!platform.getOpenPorts) return;
    let cancelled = false;

    const tick = async () => {
      for (const leaf of toolLeaves(lath, doorsRef.current)) {
        if (cancelled) return;
        const announce = getToolAnnounce(leaf.id);

        // A runtime re-key re-labels this Surface and nothing else. It never
        // dedupes: by the time a key can change, both Surfaces may hold work,
        // and a collision resolved by killing either destroys some of it
        // (docs/specs/dor-tool.md -> Identity and dedupe). The host keeps its
        // own namespace, so the payload cannot claim to be another tool.
        if (announce?.key && !toolKeysEqual(leaf.params?.toolKey, announce.key)) {
          lath.store.updateParams(leaf.id, { toolKey: announce.key });
        }

        const hasUrl = typeof (leaf.params as { url?: unknown } | undefined)?.url === 'string';
        const running = getTerminalPaneState(leaf.id).currentCommand !== null;

        // Command exit retires the browser and the pane flips back to a prompt
        // above the tool's dying words — the correct debugging posture. Re-running
        // revives it on the same Surface, because the params, not the id, changed.
        if (hasUrl && !running) {
          lath.store.updateParams(leaf.id, { url: undefined, showTerminal: undefined });
          continue;
        }
        if (hasUrl || !running) continue;

        let ports;
        try {
          ports = await platform.getOpenPorts!(leaf.id);
        } catch {
          continue; // A scan that fails is a scan that finds nothing yet.
        }
        if (cancelled) return;
        // The announcement disambiguates; the scan supplies the number. A tool
        // that binds vite, a bridge, and a control socket says which one to
        // frame, and an announced port nothing bound frames nothing — under
        // worktree contention the tool's intent and its result diverge, and the
        // scan is the one that is right.
        const entries = listenerUrlsByPort(ports);
        const wanted = announce?.port ?? null;
        const entry = wanted === null
          ? entries[0]
          : entries.find((candidate) => candidate.port === wanted);
        if (!entry) continue;
        lath.store.updateParams(leaf.id, { url: entry.url, renderMode: 'iframe' });
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [lath, doorsRef]);
}
