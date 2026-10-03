import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import type { InteractiveProgram } from "../tutorial-shell";
import { startPlaygroundDor } from "./dor";
import { createPlaygroundFs, PLAYGROUND_CWD } from "./snapshot";
import { connectViewerRelay } from "./sw-relay";
import { playgroundIframeUrl, playgroundToolControl } from "./tool-control";
import { PlaygroundViewers } from "./viewers";

/**
 * Gives the desktop playground its read-only filesystem (docs/specs/tutorial.md
 * -> Playground filesystem): installs the adapter's `toolControl` and
 * `createIframeProxyUrl`, and returns the shells' filesystem and the `dor`
 * program. The service worker registers when the first viewer starts.
 */
export function installPlaygroundFs(adapter: FakePtyAdapter) {
  const fs = createPlaygroundFs();
  const viewers = new PlaygroundViewers(fs, (id, data) => adapter.sendOutput(id, data), location.origin);
  adapter.toolControl = playgroundToolControl(fs);
  adapter.createIframeProxyUrl = playgroundIframeUrl;
  let relay: Promise<() => void> | undefined;
  const connect = () => relay ??= connectViewerRelay(viewers);
  return {
    shellFs: { fs, cwd: PLAYGROUND_CWD },
    startDor: (terminalId: string, args: string[], cwd: string, onExit: (exitCode?: number) => void): InteractiveProgram =>
      startPlaygroundDor({ adapter, terminalId, args, cwd, fs, viewers, relay: connect, onExit }),
    dispose: () => {
      delete adapter.toolControl;
      delete adapter.createIframeProxyUrl;
      void relay?.then((disconnect) => disconnect(), () => {});
    },
  };
}
