/**
 * The terminal-protocol boundary of a process that owns a PTY: one
 * {@link TerminalProtocolParser} per PTY generation, fed from spawn, feeding the
 * owner's renderer and every remote sink from the same parse
 * (`docs/specs/terminal-escapes.md` → "Parsing location"). Both owners run it —
 * the VS Code extension host and the standalone sidecar — so a query is answered
 * once however many viewers are attached.
 */

import {
  TerminalProtocolParser,
  textProjectionOf,
  type TerminalColorProvider,
  type TerminalProtocolEvent,
} from './terminal-protocol';

/**
 * One chunk of processed PTY output: the projection pair `PtyDataDetail` carries
 * locally (`./platform/types.ts`), minus the id a sink does not need. `data` is
 * what a renderer writes; `textData` is the same chunk with string-control
 * payloads removed, **omitted when identical to `data`** and authoritative when
 * present, empty included.
 */
export interface ProcessedPtyChunk {
  /** Shared with every sink of this chunk, so nobody may edit it in place. */
  readonly data: string;
  readonly textData?: string;
}

/**
 * The most UTF-16 code units one `process` call is given; a larger PTY read is
 * split first. **Both projections ride one `terminal.data`**, so the budget is
 * halved before anything else: a parsed chunk can exceed this by the
 * incomplete-sequence buffer the parser was holding (`OSC_INCOMPLETE_LIMIT`,
 * 16 KiB), each of those code units can encode to three UTF-8 bytes, and
 * base64url adds a third again — 640 KiB for the pair, against the 1 MiB
 * `MAX_APP_MESSAGE_LENGTH` (`remote-lib-common/src/security/noise-transport.ts`)
 * that message and its JSON framing must fit. libuv reads 64 KiB, so this is a
 * ceiling on the pathological read rather than a routine split.
 */
export const MAX_PARSER_INPUT_CHARS = 64 * 1024;

export interface ProcessedPtyStreamOptions {
  /**
   * Resolves OSC 10/11/12 from the owner's terminal theme. Absent declines every
   * colour query, which leaves it in `visibleData` for xterm.js to answer.
   */
  colorProvider?: TerminalColorProvider;
  /**
   * Everything one chunk's parse produced, delivered once per chunk and never
   * per sink — a response fanned out per attachment would be written to the PTY
   * as many times as there are viewers. Not called for a chunk that produced
   * none, which is the common case.
   */
  onEvents(events: TerminalProtocolEvent[]): void;
  /**
   * The owner's own renderer feed. Attached from spawn by construction, so it is
   * never held mid-string. Never called with an empty renderer projection: a
   * chunk of nothing but consumed protocol is not output.
   */
  onChunk(chunk: ProcessedPtyChunk): void;
}

export interface ProcessedPtyStream {
  /** One raw PTY read, bounded to {@link MAX_PARSER_INPUT_CHARS} before parsing. */
  write(raw: string): void;
  /**
   * Add a sink beside the owner's own feed; returns the unsubscribe. **A sink
   * that subscribes inside a forwarded string control starts at the next ground
   * byte** — the tail of a sixel or inline-image payload, arriving without its
   * introducer, is painted as text by the renderer that receives it.
   *
   * A sink that throws costs itself the chunk and no one else anything.
   */
  subscribe(sink: (chunk: ProcessedPtyChunk) => void): () => void;
  /** Whether any {@link subscribe} sink is still attached. */
  readonly hasSinks: boolean;
}

interface Subscription {
  sink: (chunk: ProcessedPtyChunk) => void;
  /** Waiting out the string control that was open when it subscribed. */
  held: boolean;
}

export function createProcessedPtyStream(options: ProcessedPtyStreamOptions): ProcessedPtyStream {
  const parser = new TerminalProtocolParser(options.colorProvider);
  const subscriptions = new Set<Subscription>();

  function deliver(piece: string): void {
    const { visibleData, textData, events, resumedStringEnd } = parser.process(piece);
    if (events.length > 0) options.onEvents(events);
    const chunk = visibleData === '' ? null : chunkOf(visibleData, textData);
    // The owner first, and unguarded: it is the local pipe, and a fault there is
    // the owner's own to surface.
    if (chunk) options.onChunk(chunk);
    // Iterated live rather than copied: a sink can only unsubscribe itself from
    // here, which a Set tolerates mid-iteration.
    for (const subscription of subscriptions) {
      if (!subscription.held) {
        if (chunk) emit(subscription, chunk);
        continue;
      }
      if (resumedStringEnd === null) continue;
      subscription.held = false;
      const ground = visibleData.slice(resumedStringEnd);
      if (ground !== '') emit(subscription, chunkOf(ground, textData));
    }
  }

  /**
   * **A sink must never break the stream.** One throwing attachment would
   * otherwise cost every sink after it this chunk, and the rest of a split read
   * the owner's own renderer too.
   */
  function emit(subscription: Subscription, chunk: ProcessedPtyChunk): void {
    try {
      subscription.sink(chunk);
    } catch (error) {
      console.error('[processed-pty-stream] sink threw; dropping its chunk', error);
    }
  }

  return {
    write(raw) {
      for (const piece of boundPtyRead(raw)) deliver(piece);
    },

    subscribe(sink) {
      const subscription: Subscription = { sink, held: parser.isForwardingString };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },

    get hasSinks(): boolean {
      return subscriptions.size > 0;
    },
  };
}

/**
 * The pieces one PTY read is parsed as. A surrogate pair is never split: the
 * halves would be encoded separately downstream, and a lone surrogate does not
 * survive a UTF-8 round trip.
 */
export function boundPtyRead(raw: string, limit = MAX_PARSER_INPUT_CHARS): string[] {
  if (raw.length <= limit) return [raw];
  const pieces: string[] = [];
  for (let start = 0; start < raw.length; ) {
    let end = Math.min(start + limit, raw.length);
    if (end < raw.length && end - 1 > start && isHighSurrogate(raw.charCodeAt(end - 1))) end -= 1;
    pieces.push(raw.slice(start, end));
    start = end;
  }
  return pieces;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function chunkOf(visibleData: string, textData: string): ProcessedPtyChunk {
  const projection = textProjectionOf({ visibleData, textData });
  return projection === undefined ? { data: visibleData } : { data: visibleData, textData: projection };
}
