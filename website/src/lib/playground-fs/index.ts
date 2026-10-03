import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import type { InteractiveProgram } from "../tutorial-shell";
import { startPlaygroundDor } from "./dor";
import { createPlaygroundFs, PLAYGROUND_CWD } from "./snapshot";
import { connectViewerRelay } from "./sw-relay";
import { playgroundIframeUrl, playgroundToolControl } from "./tool-control";
import { PlaygroundViewers } from "./viewers";

export { PLAYGROUND_CWD };

/**
 * Gives the desktop playground its read-only filesystem (docs/specs/tutorial.md
 * -> Playground filesystem): installs the adapter's `toolControl` and
 * `createIframeProxyUrl`, starts the viewer relay, and returns the `dor` program.
 */
export function installPlaygroundFs(adapter: FakePtyAdapter) {
  const fs = createPlaygroundFs();
  const viewers = new PlaygroundViewers(fs, (id, data) => adapter.sendOutput(id, data), () => location.origin);
  const toolControl = playgroundToolControl(fs);
  adapter.toolControl = toolControl;
  adapter.createIframeProxyUrl = playgroundIframeUrl;
  const relay = connectViewerRelay(viewers);
  // A failure surfaces when a viewer starts; nothing else waits on it.
  relay.catch(() => {});
  return {
    fs,
    startDor: (terminalId: string, args: string[], cwd: string, onExit: (exitCode?: number) => void): InteractiveProgram =>
      startPlaygroundDor({ adapter, terminalId, args, cwd, fs, viewers, relay, toolControl, onExit }),
    dispose: () => {
      delete adapter.toolControl;
      delete adapter.createIframeProxyUrl;
      void relay.then((disconnect) => disconnect(), () => {});
    },
  };
}
