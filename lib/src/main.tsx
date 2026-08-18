import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initPlatform } from "./lib/platform";
import { resumeOrRestore } from "./lib/reconnect";
import { initAlertStateReceiver } from "./lib/terminal-registry";
import { installVscodeThemeVarResolver } from "./lib/themes/vscode-color-observer";
import { REMOTE_HOST_STORE_PREFIX } from "./remote/host/store";
import App from "./App";
import "./index.css";

const platform = initPlatform();

// This entry serves the VS Code webview and the lib dev server. Only the
// former can be a remote Host: the dev server has no PTYs behind it, and the
// extension host is what arbitrates the single-Host lease across webviews.
const isVscode = typeof acquireVsCodeApi === "function";

if (isVscode) {
  installVscodeThemeVarResolver();
}

// Wire up alert state before reconnect so state messages are handled
initAlertStateReceiver();

// Request PTY list before rendering so Wall can restore existing sessions.
// On non-VSCode platforms (or first launch), this resolves immediately with no IDs.
//
// The Host store is hydrated in the same wait: `local-json-store` is
// synchronous by contract, so a host that keeps those keys outside the webview
// (VS Code → extension-host SecretStorage) must have them in memory before the
// remote-Host modules read them at mount. Adapters without the hook resolve
// immediately and keep localStorage.
Promise.all([
  resumeOrRestore(platform),
  platform.hydrateScopedStore?.(REMOTE_HOST_STORE_PREFIX),
]).then(([result]) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialPaneIds={result.paneIds} restoredLathLayout={result.lathLayout} initialDoors={result.doors} initialSurfaceRefs={result.surfaceRefs} initialSurfaceRefsNext={result.surfaceRefsNext} enableRemoteHost={isVscode} />
    </StrictMode>,
  );
});

platform.init();
