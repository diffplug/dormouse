/**
 * The strip-only terminal-protocol parser a Node-resident Host runs over each
 * PTY it streams to a Client.
 *
 * The phone renders the same bytes the laptop's own xterm renders, and the
 * webview strips before rendering (`docs/specs/terminal-escapes.md` → the
 * `pty:data` strip semantics). A raw PTY stream would therefore show the phone
 * OSC sequences the laptop never sees, so the stream is stripped here too.
 *
 * Every event the parser produces is discarded, responses included. The webview
 * that owns the terminal already answers its queries; a second answer from this
 * process would write duplicate bytes into the PTY's input and corrupt whatever
 * the program was parsing. Semantic events (cwd, prompt, title) are the
 * webview's to record for the same reason — this parser exists only to decide
 * which bytes are visible.
 *
 * "Discarded" and "not parsed" are different things, and the difference is a
 * bug: a query the parser declines stays in `visibleData` and reaches the
 * phone, which answers it. See {@link CONSUME_COLOR_QUERIES}.
 */

import { TerminalProtocolParser } from '../../lib/terminal-protocol';
import type { ProcessedPtyChunk } from '../../remote/host/host-surface-provider';

/**
 * A colour for the parser to answer OSC 10/11/12 queries with.
 *
 * The value is never sent anywhere: the response the parser generates is
 * discarded with every other event, and the local adapter stays the only thing
 * that answers a color query. It exists solely so the query is *consumed* —
 * without a provider the parser declines and leaves the query in `visibleData`,
 * where it reaches the phone's xterm, which answers it too and writes a second
 * reply into the PTY's input.
 */
const CONSUME_COLOR_QUERIES = (): string => '#000000';

/**
 * A per-attachment stripper. Stateful — an OSC split across two PTY chunks is
 * held until it completes — so one is created per stream and never shared.
 */
export function createPtyStrip(): (data: string) => ProcessedPtyChunk {
  const parser = new TerminalProtocolParser(CONSUME_COLOR_QUERIES);
  return (data) => {
    const { visibleData, textData } = parser.process(data);
    return textData === visibleData ? { data: visibleData } : { data: visibleData, textData };
  };
}
