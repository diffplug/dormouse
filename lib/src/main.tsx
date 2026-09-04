import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initPlatform } from "./lib/platform";
import { resumeOrRestore } from "./lib/reconnect";
import { initAlertStateReceiver } from "./lib/terminal-registry";
import { installVscodeThemeVarResolver } from "./lib/themes/vscode-color-observer";
import { installPeerSurfaceResponder } from "./remote/burrow/peer-surfaces";
import App from "./App";
import "./index.css";

const platform = initPlatform();

// This entry serves the VS Code webview and the lib dev server. Only the
// former has a Burrow behind it: the Host runs in the extension host,
// next to the PTYs, and the dev server has neither.
const isVscode = typeof acquireVsCodeApi === "function";

if (isVscode) {
  installVscodeThemeVarResolver();
  // Every webview answers for its own terminals — that is what lets the phone
  // see a whole window rather than one webview's panes.
  installPeerSurfaceResponder();
}

// Wire up alert state before reconnect so state messages are handled
initAlertStateReceiver();

// Request PTY list before rendering so Wall can restore existing sessions.
// On non-VSCode platforms (or first launch), this resolves immediately with no IDs.
resumeOrRestore(platform).then((result) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialPaneIds={result.paneIds} restoredLathLayout={result.lathLayout} initialDoors={result.doors} initialSurfaceRefs={result.surfaceRefs} initialSurfaceRefsNext={result.surfaceRefsNext} enableBurrow={isVscode} />
    </StrictMode>,
  );
});

platform.init();
