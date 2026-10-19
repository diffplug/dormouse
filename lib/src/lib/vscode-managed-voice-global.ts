/**
 * The boot global telling a VS Code webview whether this build has managed
 * voice (`docs/specs/vscode.md` -> "Managed voice"). The relay origin that
 * decides it is baked into the extension host's bundle, never the webview's,
 * so the host says it here. Shared for the reason `vscode-recovery-global.ts`
 * gives: the writer and the reader sit in different packages.
 */

/** Global the host sets to `true` in a Hosted build. */
export const MANAGED_VOICE_GLOBAL = '__DORMOUSE_MANAGED_VOICE__';

/** Whether the host said this build has managed voice; anything but `true` is no. */
export function readInjectedManagedVoice(): boolean {
  return (globalThis as unknown as Record<string, unknown>)[MANAGED_VOICE_GLOBAL] === true;
}
