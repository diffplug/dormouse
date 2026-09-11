import type { Terminal } from '@xterm/xterm';
import type { SerializeAddon } from '@xterm/addon-serialize';

export interface TerminalGrid { cols: number; rows: number }

/** The pinned serializer omits mouse encoding. Read xterm's resolved state,
 * including resets, rather than infer it from output chunks. This private
 * accessor is pinned by real-xterm round-trip tests in terminal-transfer.test.ts.
 */
export function serializeTransferTerminal(terminal: Terminal, serialize: SerializeAddon): string {
  const encoding = (terminal as unknown as {
    _core: { mouseStateService: { activeEncoding: string } };
  })._core.mouseStateService.activeEncoding;
  const mode = encoding === 'SGR' ? 1006 : encoding === 'SGR_PIXELS' ? 1016 : null;
  return serialize.serialize() + (mode === null ? '' : `\x1b[?${mode}h`);
}
