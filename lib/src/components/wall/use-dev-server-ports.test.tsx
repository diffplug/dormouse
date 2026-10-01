/**
 * @vitest-environment jsdom
 *
 * The dev-server correlation loop is per WINDOW, not per Wall: the wanted-port
 * store and the resolutions span every Workspace, so a per-Wall loop would
 * answer another Workspace's port with "no match" and poll `lsof` forever
 * (docs/specs/dor-browser.md → "Dev-Server Chip").
 */
import { act, useMemo, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDevServerPortCorrelation } from './use-dev-server-ports';
import {
  getDevServerResolution,
  releaseDevServerPort,
  requestDevServerPort,
} from './agent-browser-ports';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { OpenPort } from '../../lib/platform/types';
import type { LathWallEngine } from './lath-wall-engine';
import type { DooredItem } from './wall-types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PORT = 5173;
let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;
let openPorts: ReturnType<typeof vi.fn>;

function tcp(port: number): OpenPort[] {
  return [{ protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port, pid: 1 }];
}

/** Just enough engine for the loop: one Wall's visible terminal panes. */
function fakeLath(paneIds: string[]): LathWallEngine {
  return {
    listPanes: () => paneIds.map((id) => ({ id, title: id, params: undefined })),
    getMeta: () => undefined,
  } as unknown as LathWallEngine;
}

function Harness({ paneIds }: { paneIds: string[] }) {
  const lath = useMemo(() => fakeLath(paneIds), [paneIds]);
  const doorsRef = useRef<DooredItem[]>([]);
  useDevServerPortCorrelation({ lath, doorsRef });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  platform = new FakePtyAdapter();
  openPorts = vi.fn(async () => [] as OpenPort[]);
  platform.getOpenPorts = openPorts as unknown as FakePtyAdapter['getOpenPorts'];
  setPlatform(platform);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  releaseDevServerPort(PORT);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settleScan(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

describe('dev-server port correlation across Walls', () => {
  it('resolves a port served by another Wall, scanning every candidate once', async () => {
    openPorts.mockImplementation(async (id: string) => (id === 'b1' ? tcp(PORT) : []));
    requestDevServerPort(PORT);
    await act(async () => {
      root.render(<><Harness paneIds={['a1']} /><Harness paneIds={['b1']} /></>);
    });
    await settleScan();

    // The Wall that owns the serving pane wins, and the Wall that does not own it
    // never publishes "no match" over the top.
    expect(getDevServerResolution(PORT)?.paneId).toBe('b1');
    const ids = openPorts.mock.calls.map(([id]) => id);
    expect([...ids].sort()).toEqual(['a1', 'b1']);
  });

  it('settles once matched, so a second Wall does not keep polling for it', async () => {
    openPorts.mockImplementation(async (id: string) => (id === 'b1' ? tcp(PORT) : []));
    requestDevServerPort(PORT);
    await act(async () => {
      root.render(<><Harness paneIds={['a1']} /><Harness paneIds={['b1']} /></>);
    });
    await settleScan();
    const afterFirstScan = openPorts.mock.calls.length;

    // Well past the pending-refresh cadence: a settled port is never rescanned.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(openPorts.mock.calls.length).toBe(afterFirstScan);
    expect(getDevServerResolution(PORT)?.paneId).toBe('b1');
  });
});
