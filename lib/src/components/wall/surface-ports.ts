/**
 * The opt-in port scan behind `dor list --ports` / `--port`
 * (`docs/specs/dor-cli.md` → "Current Implemented Commands"), shared by the Wall
 * answering for its own Workspace and the Window answering `--all` across them.
 */

import { hasTerminal, type Surface, type SurfacePort } from 'dor/commands/types';
import { getPlatform } from '../../lib/platform';
import type { OpenPort } from '../../lib/platform/types';

function toSurfacePort(port: OpenPort): SurfacePort {
  return {
    family: port.family,
    address: port.address,
    port: port.port,
    pid: port.pid,
    ...(port.processName ? { processName: port.processName } : {}),
  };
}

/**
 * Enumerate every terminal Surface's listening ports, in **one host call where
 * the adapter can batch it** (`getOpenPortsMany`) and one call per Surface in
 * parallel where it cannot. The scan shells out per process table, so a listing
 * spanning Workspaces must not pay for it once per row. A failure degrades to no
 * ports for the Surfaces it covered, never a rejected listing.
 */
export async function attachSurfacePorts<T extends Surface>(surfaces: T[]): Promise<T[]> {
  const platform = getPlatform();
  const terminals = surfaces.filter((surface) => hasTerminal(surface.kind));
  if (terminals.length === 0) return surfaces;

  const batched = platform.getOpenPortsMany;
  if (batched) {
    let ports: Record<string, OpenPort[]> = {};
    try {
      ports = await batched.call(platform, terminals.map((surface) => surface.id));
    } catch { ports = {}; }
    return surfaces.map((surface) => (hasTerminal(surface.kind)
      ? { ...surface, ports: (ports[surface.id] ?? []).map(toSurfacePort) }
      : surface));
  }

  return Promise.all(surfaces.map(async (surface) => {
    if (!hasTerminal(surface.kind)) return surface;
    try {
      const ports = await platform.getOpenPorts(surface.id);
      return { ...surface, ports: ports.map(toSurfacePort) };
    } catch {
      return { ...surface, ports: [] };
    }
  }));
}
