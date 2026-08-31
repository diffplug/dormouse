/**
 * The serving trigger: a tool Surface grows a browser in place once its command
 * binds a port (`docs/specs/dor-tool.md` -> Serving).
 *
 * Only tool-designated Sessions are scanned. An ordinary terminal that opens a
 * port never transforms — that is the Dev-Server Chip's job, and panes must not
 * flip under the user (`docs/specs/dor-tool.md` -> Security).
 */
import { useEffect } from 'react';
import { getPlatform } from '../../lib/platform';
import { getTerminalPaneState } from '../../lib/terminal-registry';
import { browserUrlFromParams, isToolParams, toolKeysEqual } from './browser-surface';
import { attachAgentBrowserSession } from './connect-port';
import { listenerUrlsByPort } from './port-url';
import { getToolAnnounce } from '../../lib/tool-announce-store';
import { sessionForKey } from 'dor-lib-common/agent-browser';
import type { LathWallEngine } from './lath-wall-engine';
import type { DooredItem } from './wall-types';

// A serving command usually binds within a second or two of starting, but a
// cold `pnpm` boot can take much longer, so this keeps polling for as long as
// the command runs. The scan shells out per Surface (lsof / PowerShell), so the
// cadence is deliberately slow and only tools without a URL are scanned.
const POLL_MS = 1500;

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

        // A runtime re-key re-labels this Surface and nothing else — it never
        // dedupes (docs/specs/dor-tool.md -> Identity and dedupe). The host
        // keeps its own namespace, so the payload cannot claim another tool.
        if (announce?.key && !toolKeysEqual(leaf.params?.toolKey, announce.key)) {
          lath.store.updateParams(leaf.id, { toolKey: announce.key });
        }

        const hasUrl = browserUrlFromParams(leaf.params) !== null;
        const running = getTerminalPaneState(leaf.id).currentCommand !== null;

        // Command exit retires the browser and the pane flips back to a prompt
        // above the tool's dying words. Re-running revives it on the same
        // Surface, because the params, not the id, changed.
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
        // The announcement disambiguates; the scan supplies the number, so an
        // announced port that nothing bound frames nothing.
        const entries = listenerUrlsByPort(ports);
        const wanted = announce?.port ?? null;
        const entry = wanted === null
          ? entries[0]
          : entries.find((candidate) => candidate.port === wanted);
        if (!entry) continue;

        if (leaf.params?.toolRender !== 'ab-screencast') {
          lath.store.updateParams(leaf.id, { url: entry.url, renderMode: 'iframe' });
          continue;
        }

        // An agent-drivable tool needs a real browser behind it. Bind the
        // session to the tool's *own* Surface rather than creating a second
        // one: a tool's browser is a param of its own leaf, which is what keeps
        // its id stable while its capabilities come and go.
        //
        // Show the destination immediately; the panel's session-less branch
        // renders `Connecting to browser session…` while the daemon boots, and
        // cannot race it (see docs/specs/dor-browser.md -> Instant create).
        lath.store.updateParams(leaf.id, { url: entry.url, renderMode: 'ab-screencast' });
        await attachAgentBrowserSession({
          url: entry.url,
          platform,
          session: sessionForKey(`tool.${leaf.id}`),
          surfaceId: leaf.id,
          refreshSurface: (id, patch) => {
            if (!cancelled) lath.store.updateParams(id, patch);
          },
        });
        if (cancelled) return;
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
