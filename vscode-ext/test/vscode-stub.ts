/**
 * Stands in for the `vscode` module under test.
 *
 * The extension host modules worth unit-testing barely touch the API — most
 * import it as `import type`, which erases. What is left is the output channel
 * `log.ts` opens and the `Uri.file` that `webview-html.ts` calls, so that is all
 * this provides. Anything else is deliberately absent: a test that reaches
 * further should fail loudly rather than pass against a fake that quietly does
 * nothing.
 */

export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    dispose: () => {},
  }),
};

/**
 * `getWebviewHtml` resolves the media directory through `Uri.file` before
 * handing it to `asWebviewUri`. The tests only ever compare the result as a
 * string, so a plain `fsPath` carrier is the whole contract.
 */
export const Uri = {
  file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }),
};
