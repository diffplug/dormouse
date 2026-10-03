/**
 * Port → dev-server URL selection, shared by the `surface.resolveOpen` control
 * method (`dor agent-browser open <surface>` / `dor iframe <surface>`) and the pane
 * context menu's port list. One entry per distinct TCP port a process tree
 * binds; the host/URL choice matches what `dor agent-browser open` opens.
 */
import type { OpenPort } from '../../lib/platform/types';

/** One openable dev-server URL for a distinct listening port. */
export type PortUrlEntry = { port: number; host: string; url: string; processName?: string };

// A process bound here answers `localhost:<port>`: loopback (127.0.0.1 / ::1)
// or any-interface (0.0.0.0 / ::). A process bound to one specific non-loopback
// interface is excluded — it isn't reachable as localhost.
export function servesLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '0.0.0.0' || address === '::';
}

/** An http(s) origin and nothing more, so a path resolves against it unchanged. */
function isHttpOrigin(origin: string | undefined): origin is string {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
  } catch {
    return false;
  }
}

/**
 * Group TCP listeners into one openable URL per distinct port, sorted ascending
 * by port. Per port: a loopback-servable bind wins the host `localhost`;
 * otherwise pick a listener IPv4-first then address-lexicographic, bracketing
 * IPv6 (`[::1]`). The URL is `http://<host>:<port>/`, or a listener's own
 * `origin` where the platform scan supplied one. `processName` is the
 * selected listener's, falling back to the first defined one for that port.
 */
export function listenerUrlsByPort(ports: OpenPort[]): PortUrlEntry[] {
  const tcpPorts = ports.filter((entry) => entry.protocol === 'tcp');
  const distinctPorts = [...new Set(tcpPorts.map((entry) => entry.port))].sort((a, b) => a - b);
  return distinctPorts.map((port) => {
    const portListeners = tcpPorts.filter((entry) => entry.port === port);
    const loopbackListener = portListeners.find((entry) => servesLoopback(entry.address));
    const selectedListener = loopbackListener ?? [...portListeners].sort((a, b) => {
      if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    })[0];
    const host = loopbackListener
      ? 'localhost'
      : selectedListener.family === 'IPv6'
        ? `[${selectedListener.address}]`
        : selectedListener.address;
    const processName = selectedListener.processName
      ?? portListeners.find((entry) => entry.processName !== undefined)?.processName;
    const origin = portListeners.map((entry) => entry.origin).find(isHttpOrigin);
    return {
      port,
      host,
      url: origin ? `${origin}/` : `http://${host}:${port}/`,
      ...(processName !== undefined ? { processName } : {}),
    };
  });
}
