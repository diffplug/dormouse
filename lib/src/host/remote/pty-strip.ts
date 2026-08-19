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
 */

import { TerminalProtocolParser } from '../../lib/terminal-protocol';

/**
 * A per-attachment stripper. Stateful — an OSC split across two PTY chunks is
 * held until it completes — so one is created per stream and never shared.
 */
export function createPtyStrip(): (data: string) => string {
  // No color provider: OSC 10/11/12 queries fall through untouched, exactly as
  // they do for a webview whose theme cannot answer them.
  const parser = new TerminalProtocolParser();
  return (data) => parser.process(data).visibleData;
}
