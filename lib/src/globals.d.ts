// VSCode webview API — only available when running inside a VSCode webview.
// Declared here so that consuming packages can reference
// this single declaration instead of duplicating it in each vite-env.d.ts.
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
