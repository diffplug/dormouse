/**
 * Port → dev-server URL selection, shared by the `surface.resolveOpen` control
 * method (`dor agent-browser open <surface>` / `dor iframe <surface>`) and the pane
 * context menu's port list. One entry per distinct TCP port a process tree
 * binds; the host/URL choice matches what `dor agent-browser open` opens.
 */
import type { OpenPort } from '../../lib/platform/types';

/** One openable dev-server URL for a distinct listening port. */
export type PortUrlEntry = { port: number; host: string; url: string; processName?: string };

/** Whether a bind can answer on loopback: a loopback or wildcard address. */
export function servesLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '0.0.0.0' || address === '::';
}

/** A wildcard's same-family loopback, for a host that sent no `connectAddress`. */
const WILDCARD_LOOPBACK: Partial<Record<string, string>> = { '0.0.0.0': '127.0.0.1', '::': '::1' };

/** One numeric URL per port: prefer loopback, then IPv4, then address order.
 * Never substitute localhost: DNS may select another process's listener.
 * A wildcard uses the host's `connectAddress`; null (all shadowed) is skipped.
 */
export function listenerUrlsByPort(ports: OpenPort[]): PortUrlEntry[] {
  const tcpPorts = ports.filter((entry) => entry.protocol === 'tcp' && entry.connectAddress !== null);
  const distinctPorts = [...new Set(tcpPorts.map((entry) => entry.port))].sort((a, b) => a - b);
  return distinctPorts.map((port) => {
    const portListeners = tcpPorts.filter((entry) => entry.port === port);
    const selectedListener = [...portListeners].sort((a, b) => {
      const loopback = Number(servesLoopback(b.address)) - Number(servesLoopback(a.address));
      if (loopback) return loopback;
      if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    })[0];
    const address = selectedListener.connectAddress
      ?? WILDCARD_LOOPBACK[selectedListener.address] ?? selectedListener.address;
    const host = address.includes(':') ? `[${address}]` : address;
    const processName = selectedListener.processName
      ?? portListeners.find((entry) => entry.processName !== undefined)?.processName;
    return {
      port,
      host,
      url: `http://${host}:${port}/`,
      ...(processName !== undefined ? { processName } : {}),
    };
  });
}
