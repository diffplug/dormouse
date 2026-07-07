import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initPlatform } from "./lib/platform";
import { resumeOrRestore } from "./lib/reconnect";
import { initAlertStateReceiver } from "./lib/terminal-registry";
import { installVscodeThemeVarResolver } from "./lib/themes/vscode-color-observer";
import App from "./App";
import "./index.css";

const platform = initPlatform();

if (typeof acquireVsCodeApi === "function") {
  installVscodeThemeVarResolver();
}

// Wire up alert state before reconnect so state messages are handled
initAlertStateReceiver();

// Request PTY list before rendering so Wall can restore existing sessions.
// On non-VSCode platforms (or first launch), this resolves immediately with no IDs.
resumeOrRestore(platform).then((result) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialPaneIds={result.paneIds} restoredLathLayout={result.lathLayout} initialDoors={result.doors} />
    </StrictMode>,
  );
});

platform.init();
