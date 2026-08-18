/**
 * Stands in for the `vscode` module under test.
 *
 * The extension host modules worth unit-testing barely touch the API — most
 * import it as `import type`, which erases. What is left is the output channel
 * `log.ts` opens, so that is all this provides. Anything else is deliberately
 * absent: a test that reaches further should fail loudly rather than pass
 * against a fake that quietly does nothing.
 */

export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    dispose: () => {},
  }),
};
