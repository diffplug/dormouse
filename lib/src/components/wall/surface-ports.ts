/**
 * Batched terminal port scans: the opt-in scan behind `dor list --ports` /
 * `--port` (`docs/specs/dor-cli.md` → "Current Implemented Commands"), the
 * Dev-Server Chip, and Tool serving.
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
 * Listening ports for every terminal id, in **one host call where the adapter
 * can batch it** (`getOpenPortsMany`) and one call per id in parallel where it
 * cannot. The scan shells out per process table, so a caller spanning many
 * terminals must not pay for it once per id. An id whose scan failed is absent
 * from the answer, never a rejection.
 */
export async function openPortsByTerminal(ids: string[]): Promise<Record<string, OpenPort[]>> {
  if (ids.length === 0) return {};
  const platform = getPlatform();
  if (platform.getOpenPortsMany) {
    try {
      return await platform.getOpenPortsMany(ids);
    } catch { return {}; }
  }
  const entries = await Promise.all(ids.map(async (id) => {
    try {
      return [[id, await platform.getOpenPorts(id)] as const];
    } catch {
      return [];
    }
  }));
  return Object.fromEntries(entries.flat());
}

/** Every terminal Surface's listening ports, from one `openPortsByTerminal`. */
export async function attachSurfacePorts<T extends Surface>(surfaces: T[]): Promise<T[]> {
  const terminals = surfaces.filter((surface) => hasTerminal(surface.kind));
  const ports = await openPortsByTerminal(terminals.map((surface) => surface.id));
  return surfaces.map((surface) => (hasTerminal(surface.kind)
    ? { ...surface, ports: (ports[surface.id] ?? []).map(toSurfacePort) }
    : surface));
}
