/**
 * The standalone Burrow's direct-path peer: `node-datachannel`'s W3C polyfill,
 * running next to the PTYs (`docs/specs/remote-api.md` → Transport → "Direct
 * path", `docs/specs/standalone.md` → "Burrow service").
 *
 * Host code, so nothing here imports the webview library — only the structural
 * `DirectPeerLike` seam, as a type. The polyfill satisfies that seam without
 * adaptation; the only thing this module adds is *when* the addon is loaded and
 * what happens when it will not load.
 *
 * **The addon is never touched before the first offer.** It is a native library
 * with its own thread pool: loading it at boot would cost every sidecar start,
 * including the overwhelming majority that never see a Client. So the load
 * happens inside the first factory call, once per process, and a Burrow that
 * gets no `direct-offer` never opens it at all.
 */

import { createRequire } from 'node:module';
import type { DirectPeerFactory, DirectPeerLike } from '../../remote/direct/direct-peer';

/** The one polyfill export a direct path needs. */
interface DirectPolyfill {
  readonly RTCPeerConnection: new (config: { iceServers: [] }) => DirectPeerLike;
}

/** The addon's own module, for the teardown the polyfill does not expose. */
interface DirectAddon {
  readonly cleanup: () => void;
}

interface NativeDirect {
  readonly polyfill: DirectPolyfill;
  readonly addon: DirectAddon;
}

export interface NativeDirectPeerOptions {
  /**
   * A file to resolve the addon relative to, for a caller that does not sit
   * beside the `node_modules` holding it. The sidecar bundle does — it is
   * emitted into `standalone/sidecar/`, whose `package.json` declares the
   * platform package — so the shipped Burrow passes nothing and the loader
   * below uses the bundle's own `require`. A test running this file from source
   * under `lib/` names the sidecar instead.
   */
  readonly resolveFrom?: string;
  /** Where a load failure is reported; `console.warn` by default. */
  readonly warn?: (message: string) => void;
}

/**
 * The addon once some factory has loaded it. Process-wide rather than
 * per-factory: one native library, one thread pool, one teardown.
 */
let native: NativeDirect | null = null;
/**
 * Whether the addon is off the table for the rest of the process — a load that
 * threw, or a teardown that has already run. Either way the factory answers
 * `null` and the Burrow declines every offer, staying relayed.
 */
let declined = false;

/**
 * Both modules, required lazily.
 *
 * **The specifiers must survive bundling as bare `require` calls.** The addon's
 * loader resolves its platform package and `detect-libc` relative to its own
 * `__dirname`, so inlining the library into `burrow.cjs` would move that
 * `__dirname` out of the installed package and leave nothing to find. The
 * esbuild `external` entries in `standalone/scripts/build-sidecar-proxy.mjs`
 * are what keeps them bare, and that build asserts it.
 */
function requireNative(resolveFrom: string | undefined): NativeDirect {
  if (resolveFrom !== undefined) {
    const required = createRequire(resolveFrom);
    return {
      polyfill: required('node-datachannel/polyfill') as DirectPolyfill,
      addon: required('node-datachannel') as DirectAddon,
    };
  }
  return {
    polyfill: require('node-datachannel/polyfill') as DirectPolyfill,
    addon: require('node-datachannel') as DirectAddon,
  };
}

/**
 * A {@link DirectPeerFactory} over the native polyfill.
 *
 * **A load failure is warned once and declines forever after.** A missing
 * platform package or a wrong ABI is a property of the installation, not of the
 * offer, so retrying it per session would warn on every connection and cost a
 * native load attempt each time — and the Burrow's answer is the same either
 * way: `direct-decline`, and the session stays on the relay.
 */
export function createNativeDirectPeerFactory(
  options: NativeDirectPeerOptions = {},
): DirectPeerFactory {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return () => {
    if (!native && !declined) {
      try {
        native = requireNative(options.resolveFrom);
      } catch (error) {
        declined = true;
        warn(`[burrow] no direct path: the WebRTC addon did not load: ${String(error)}`);
      }
    }
    // `iceServers: []` here and nowhere else: host candidates only, never a
    // public STUN or TURN default (`docs/specs/remote-api.md` → "Direct path").
    return native ? new native.polyfill.RTCPeerConnection({ iceServers: [] }) : null;
  };
}

/**
 * Tear the addon down, if some factory ever loaded it.
 *
 * The native side runs its own threads, which outlive every peer and would keep
 * a process from exiting on their own. Terminal: a peer built on a cleaned-up
 * addon is not one this process can use, so the factory declines afterwards.
 */
export function disposeNativeDirectPeers(): void {
  const loaded = native;
  native = null;
  declined = true;
  if (!loaded) return;
  try {
    loaded.addon.cleanup();
  } catch {
    // Already down; nothing here can be reported to anyone useful.
  }
}
