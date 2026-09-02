/**
 * The build-time stand-in for the webview's CSP nonce.
 *
 * `vite.config.ts` hands this to Vite as `html.cspNonce`, so Vite stamps it onto
 * every script/style tag it emits and onto the `<meta property="csp-nonce">` its
 * runtime preload helper reads. `webview-html.ts` then replaces it with a fresh
 * per-render nonce as it serves the document.
 *
 * It lives in its own module because both ends must agree on the exact string
 * and neither can import the other: `vite.config.ts` runs in a plain Node build
 * with no `vscode` module to resolve, which importing `webview-html.ts` would
 * demand. Keep this file free of imports for the same reason.
 */
export const CSP_NONCE_PLACEHOLDER = '__DORMOUSE_CSP_NONCE__';
