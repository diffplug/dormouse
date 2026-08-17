/**
 * The boot global carrying agent recovery commands from the VS Code extension
 * host into the webview (`docs/specs/transport.md` → "The recovery command").
 *
 * The name and the read live here, together, because the writer and the reader
 * sit in different packages — `vscode-ext/src/webview-html.ts` injects it,
 * `lib/src/lib/platform/vscode-adapter.ts` reads it — and a string duplicated
 * across that boundary fails *silently*: nothing errors, recovery simply never
 * happens, which is the exact bug this payload exists to prevent and the hardest
 * one to notice. Sharing the constant makes a mismatch a compile error instead.
 * Same reason `HOST_MESSAGE_TOKEN_GLOBAL` is shared (`vscode-message-token.ts`).
 */

/** Global the host injects the captured recovery commands into. */
export const RECOVERY_COMMANDS_GLOBAL = '__DORMOUSE_RECOVERY__';

/**
 * Read the injected `surfaceId -> invocation` map, or `{}` when absent.
 *
 * Shape-checked rather than trusted: this is host-written, but the values reach
 * `restoreTerminal`, so a malformed payload must degrade to "no recovery" rather
 * than to an entry nobody validated. The command itself is revalidated again
 * through `normalizeResumeCommand` before it is typed.
 */
export function readInjectedRecoveryCommands(): Record<string, string> {
  const raw = (globalThis as unknown as Record<string, unknown>)[RECOVERY_COMMANDS_GLOBAL];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const commands: Record<string, string> = {};
  for (const [id, command] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof command === 'string' && command.length > 0) commands[id] = command;
  }
  return commands;
}
