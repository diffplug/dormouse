import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initPlatform } from "./lib/platform";
import { resumeOrRestore } from "./lib/reconnect";
import { initAlertStateReceiver } from "./lib/terminal-registry";
import { installVscodeThemeVarResolver } from "./lib/themes/vscode-color-observer";
import { REMOTE_HOST_STORE_PREFIX, setHostStoreReady } from "./remote/host/store";
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
// Host-store hydration starts now but deliberately does not gate first paint:
// its read waits on an OS keychain, and a blank terminal for that long reads as
// a hang. `local-json-store` is synchronous by contract, so the keys must be in
// memory before the remote-Host modules read them — but that happens when the
// lazily-mounted Host calls `installRemoteHostConsoleHook`, well after render,
// so it awaits `hostStoreReady()` instead.
setHostStoreReady(platform.hydrateScopedStore?.(REMOTE_HOST_STORE_PREFIX));

resumeOrRestore(platform).then((result) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialPaneIds={result.paneIds} restoredLathLayout={result.lathLayout} initialDoors={result.doors} initialSurfaceRefs={result.surfaceRefs} initialSurfaceRefsNext={result.surfaceRefsNext} enableRemoteHost={isVscode} />
    </StrictMode>,
  );
});

platform.init();
