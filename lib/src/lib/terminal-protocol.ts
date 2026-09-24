import { parseToolState, type ToolState } from './tool-state';
import type { ActivityNotification, ProtocolProgressUpdate } from './alert-manager';
import { parseColor } from './css-color';
import { sanitizeCommandLine, sanitizeText, truncateText } from './osc-sanitize';
import { isProtocolCommandStart, recordToolEvents } from './tool-events';
import { parseToolAnnounce, type ToolAnnounce } from './tool-announce';
import {
  STRING_CONTROL_INTRODUCER,
  STRING_CONTROL_INTRODUCER_SCAN,
  stringControlEndScan,
  stringControlKind,
  type StringControlKind,
} from './terminal-controls';
import {
  cwdFromOsc1337,
  cwdFromOsc633,
  cwdFromOsc7,
  cwdFromOsc9_9,
  terminalTitleFromNotification,
  type CommandRunSource,
  type TerminalSemanticEvent,
  type TerminalTitle,
} from './terminal-state';

export type TerminalProtocolEvent =
  | { kind: 'notification'; notification: ActivityNotification }
  | { kind: 'toolAnnounce'; announce: ToolAnnounce }
  | { kind: 'toolState'; state: ToolState }
  | { kind: 'progress'; progress: ProtocolProgressUpdate }
  | { kind: 'response'; data: string }
  | { kind: 'semantic'; event: TerminalSemanticEvent };

/** The terminal colors an OSC 10/11/12 query can ask about. */
export type TerminalColorTarget = 'foreground' | 'background' | 'cursor';

/** A resolved value for each queryable terminal color, as CSS color strings. */
export type TerminalColors = Record<TerminalColorTarget, string>;

/**
 * Resolves the active terminal theme color for an OSC 10/11/12 query, returned
 * as a CSS hex string (e.g. `#1e1e1e` / `#1e1e1eff` / `#abc`). Return `null` to
 * decline (the query is then forwarded to xterm.js unchanged).
 */
export type TerminalColorProvider = (target: TerminalColorTarget) => string | null;

export interface TerminalProtocolAlertSink {
  notifyFromProtocol(id: string, notification: ActivityNotification): void;
  updateProtocolProgress(id: string, progress: ProtocolProgressUpdate): void;
}

export interface TerminalProtocolParseResult {
  visibleData: string;
  events: TerminalProtocolEvent[];
  /**
   * `visibleData` with every OSC/DCS/SOS/PM/APC payload removed, for consumers
   * reading output as text (prompt detection). Every other control is left for
   * `stripTerminalControls` to interpret. Identical to `visibleData` whenever
   * the chunk carries no string control, which is the common case.
   */
  textData: string;
  /**
   * Where a consumer that joined *inside* the string control open when this
   * chunk arrived may start reading `visibleData`: `0` when none was open, the
   * offset just past that string once it ends, and `null` while it is still
   * unterminated. Only a forwarded string can be open — a consumed one never
   * reaches `visibleData` at all.
   */
  resumedStringEnd: number | null;
}

interface Osc99PendingNotification {
  title: string;
  body: string;
  updatedAt: number;
}

const OSC_INCOMPLETE_LIMIT = 16_384;
const NO_EVENTS: readonly TerminalProtocolEvent[] = Object.freeze([]);
// Standalone BEL, ESC, and the iTerm2 extended-DA query's C1 introducer
// (0x9B > q) — plus, derived from the shared grammar so a family added there
// cannot be missed here, every C1 string introducer.
const NEEDS_PARSE_RE = new RegExp(`[\\x07\\x1b\\x9b]|${STRING_CONTROL_INTRODUCER.source}`);
const OSC99_PENDING_TTL_MS = 60_000;
const OSC99_MAX_PENDING_IDS = 64;
const TITLE_LIMIT = 256;
const BODY_LIMIT = 4096;
// The shell-reported command line (`OSC 633 ; E`, `OSC 133 ; C`). Bounded and
// sanitized like every other value that comes off the wire and is then
// *retained*: it is re-tokenized on every header derivation and is the key
// `dor ensure --restart` matches on, and its decoding actively re-introduces
// control characters that the emit-side escaping had removed
// (`docs/specs/terminal-escapes.md`). See `commandLineEvents`.
const COMMAND_LINE_LIMIT = 2048;
const OSC99_PENDING_TITLE_LIMIT = 2048;
const OSC99_PENDING_BODY_LIMIT = 16_384;
const OSC99_SUPPORT_PAYLOAD = 'o=always:p=title,body';
const OSC99_RESPONSE_ID_RE = /^[^\s:;\x00-\x1f\x7f-\x9f]+$/;
// Every OSC id `parseOsc` claims. Anything else is xterm.js's, which is what
// lets an unterminated one stream instead of filling `pending`.
const OSC_CONSUMED_IDS = new Set(['0', '2', '7', '9', '10', '11', '12', '50', '52', '99', '133', '367', '633', '777']);
// The OSC 1337 subcommands ImageAddon owns; every other 1337 is consumed.
const OSC1337_FORWARDED = ['File=', 'MultipartFile=', 'FilePart=', 'FileEnd', 'ReportCellSize'] as const;
const TERMINAL_BELL_NOTIFICATION: ActivityNotification = { source: 'BEL', title: 'Terminal bell', body: null };
// Mirrors ITERM2_COMPAT_VERSION in standalone/sidecar/pty-core.js — pinned by
// mirrored-constants.test.ts (terminal-escapes.md: one compatibility version
// across env and device responses).
export const ITERM2_COMPAT_VERSION = '3.5.0';
export const ITERM2_DEVICE_ATTRIBUTES_RESPONSE = `\x1bP>|iTerm2 ${ITERM2_COMPAT_VERSION}\x1b\\`;

export class TerminalProtocolParser {
  /**
   * Bytes re-read at the head of the next chunk: an unterminated OSC this
   * parser will consume, or a partial `CSI > q` in ground text. **Never set
   * while {@link forwarding} is** — the two are assigned in branches that each
   * end the chunk, and `processForwarded` never reads this, so a byte held here
   * mid-string would rejoin the stream after the string it belonged inside.
   */
  private pending = '';
  /**
   * Non-null while a string control the parser does not consume streams
   * straight through to xterm.js. `kind` is remembered because BEL ends only an
   * OSC — resuming a sixel or a Kitty transmission as an OSC would cut it at
   * the first BEL in its payload. `heldEsc` holds a lone trailing ESC so a
   * split `ESC \` terminator, or a split cancel, is never emitted as text; at
   * most one character, so forwarding never grows.
   */
  private forwarding: { kind: StringControlKind; heldEsc: string } | null = null;
  // Once a consumed OSC exceeds its buffer cap, discard through its end. Its
  // tail is still payload, and its BEL terminator must not become a new alert.
  // Retain only a split ESC terminator/cancel, never the oversized payload.
  private discarding: { heldEsc: string } | null = null;
  private osc99Pending = new Map<string, Osc99PendingNotification>();

  /** Resolves OSC 10/11/12 queries; null lets xterm.js handle the sequence. */
  constructor(private readonly colorProvider?: TerminalColorProvider) {}

  /**
   * Whether a string control is streaming through to xterm.js right now, so a
   * consumer joining here would start mid-payload. Its counterpart is
   * {@link TerminalProtocolParseResult.resumedStringEnd}, which says where that
   * payload stops.
   */
  get isForwardingString(): boolean {
    return this.forwarding !== null;
  }

  process(data: string): TerminalProtocolParseResult {
    if (this.discarding !== null) {
      const text = this.discarding.heldEsc + data;
      const end = findStringControlEnd(text, 0, 'osc');
      if (!end) {
        this.discarding.heldEsc = text.endsWith('\x1b') ? '\x1b' : '';
        return { visibleData: '', textData: '', events: [], resumedStringEnd: 0 };
      }
      this.discarding = null;
      return this.process(text.slice(end.end));
    }
    if (this.forwarding !== null) return this.processForwarded(data);
    if (this.pending === '' && !NEEDS_PARSE_RE.test(data)) {
      return {
        visibleData: data,
        events: NO_EVENTS as TerminalProtocolEvent[],
        textData: data,
        resumedStringEnd: 0,
      };
    }
    const text = this.pending + data;
    this.pending = '';
    const events: TerminalProtocolEvent[] = [];
    let visibleData = '';
    // Ground text only: no string control contributes to it, whether consumed,
    // forwarded, or still streaming.
    let textData = '';
    let index = 0;

    while (index < text.length) {
      const control = findNextStringControl(text, index);
      if (!control) {
        // The chunk ends in ground text, so hold back a trailing partial
        // `CSI > q` for the next one rather than emitting it.
        const tail = stripStandaloneBells(text.slice(index), events);
        this.pending = takeDeviceAttributePendingSuffix(tail);
        const ground = answerDeviceAttributeQueries(
          this.pending ? tail.slice(0, -this.pending.length) : tail,
          events,
        );
        visibleData += ground;
        textData += ground;
        break;
      }

      // A gap ends where an introducer begins, so nothing of it is ever held.
      const gap = answerDeviceAttributeQueries(
        stripStandaloneBells(text.slice(index, control.index), events),
        events,
      );
      visibleData += gap;
      textData += gap;

      const controlEnd = findStringControlEnd(text, control.contentStart, control.kind);
      if (!controlEnd) {
        const incomplete = text.slice(control.index);
        // A sequence we will hand to xterm.js needs no terminator to be useful,
        // so stream it rather than spending `pending` on a payload that can be
        // megabytes (an inline image) and is bounded downstream anyway.
        const disposition =
          control.kind === 'osc' ? oscDispositionAt(text, control.contentStart) : 'forward';
        if (disposition === 'forward') {
          visibleData += this.beginForwarding(control.kind, incomplete);
        } else if (incomplete.length <= OSC_INCOMPLETE_LIMIT) {
          this.pending = incomplete;
        } else {
          this.discarding = { heldEsc: incomplete.endsWith('\x1b') ? '\x1b' : '' };
        }
        break;
      }

      const sequence = text.slice(control.index, controlEnd.end);
      if (control.kind !== 'osc') {
        // DCS/SOS/PM/APC carry sixel and Kitty graphics; none of it is ours,
        // cancelled or not — xterm.js applies its own abort semantics.
        visibleData += sequence;
      } else if (controlEnd.cancelled) {
        // Nothing an aborted OSC carried can be trusted, so it yields no event;
        // route it by id alone, since a payload that never finished cannot be
        // parsed to decide. Anything that is not certainly xterm.js's is
        // dropped rather than forwarded.
        if (oscDispositionAt(text, control.contentStart) === 'forward') visibleData += sequence;
      } else {
        const parsed = this.parseOsc(text.slice(control.contentStart, controlEnd.index));
        if (parsed === null) {
          visibleData += sequence;
        } else {
          events.push(...parsed);
        }
      }
      index = controlEnd.end;
    }

    return {
      visibleData,
      events: filterTerminalBellEvents(events),
      textData,
      // Nothing was open when this chunk arrived: whatever `pending` holds is
      // being consumed, so it reaches no consumer at all.
      resumedStringEnd: 0,
    };
  }

  private processForwarded(data: string): TerminalProtocolParseResult {
    const { kind, heldEsc } = this.forwarding!;
    const text = heldEsc + data;
    const controlEnd = findStringControlEnd(text, 0, kind);
    if (!controlEnd) {
      return {
        visibleData: this.beginForwarding(kind, text),
        events: NO_EVENTS as TerminalProtocolEvent[],
        textData: '',
        resumedStringEnd: null,
      };
    }

    // A cancel leaves `end` *at* the ESC that cancelled it, so those bytes are
    // re-read from ground and reach xterm.js as the sequence they actually are.
    this.forwarding = null;
    const parsedRest = this.process(text.slice(controlEnd.end));
    return {
      visibleData: text.slice(0, controlEnd.end) + parsedRest.visibleData,
      events: parsedRest.events,
      textData: parsedRest.textData,
      // The resumed payload is exactly the prefix above; the remainder was read
      // from ground, so a late consumer may start there — cancel included, since
      // the bytes that cancelled the string open a sequence of their own.
      resumedStringEnd: controlEnd.end,
    };
  }

  /**
   * Stream the rest of a string control straight to xterm.js, holding a lone
   * trailing ESC back so the next chunk decides whether it terminated the
   * string or cancelled it. Returns the bytes to emit now.
   */
  private beginForwarding(kind: StringControlKind, text: string): string {
    const heldEsc = text.endsWith('\x1b') ? '\x1b' : '';
    this.forwarding = { kind, heldEsc };
    return heldEsc ? text.slice(0, -1) : text;
  }

  private parseOsc(content: string): TerminalProtocolEvent[] | null {
    if (content === '7' || content.startsWith('7;')) return parseOsc7(content);
    if (content === '9' || content.startsWith('9;')) return this.parseOsc9(content);
    if (content === '133' || content.startsWith('133;')) return parseOsc133(content);
    if (content === '633' || content.startsWith('633;')) return parseOsc633(content);
    if (content === '1337' || content.startsWith('1337;')) return parseOsc1337(content);
    if (content === '0' || content.startsWith('0;')) return parseOscTitle(content, 'osc0');
    if (content === '2' || content.startsWith('2;')) return parseOscTitle(content, 'osc2');
    if (content === '99' || content.startsWith('99;')) return this.parseOsc99(content);
    if (content === '777' || content.startsWith('777;')) return this.parseOsc777(content);
    // OSC 367 is stripped whether or not it parses: a malformed announcement
    // must not print itself into the user's scrollback.
    if (content === '367') return [];
    if (content.startsWith('367;')) {
      const payload = content.slice('367;'.length);
      const announce = parseToolAnnounce(payload);
      if (announce) return [{ kind: 'toolAnnounce', announce }];
      const state = parseToolState(payload);
      return state ? [{ kind: 'toolState', state }] : [];
    }
    const colorResponse = this.parseColorQuery(content);
    if (colorResponse) return colorResponse;
    if (isKnownUnsupportedIterm2Osc(content)) return [];
    return null;
  }

  private parseColorQuery(content: string): TerminalProtocolEvent[] | null {
    // Intercept only the `?` report form; sets and unresolved colors pass through.
    const match = /^(10|11|12);\?$/.exec(content);
    if (!match || !this.colorProvider) return null;
    const code = match[1];
    const target: TerminalColorTarget = code === '10' ? 'foreground' : code === '11' ? 'background' : 'cursor';
    const data = formatOscColorResponse(code, this.colorProvider(target));
    return data ? [{ kind: 'response', data }] : null;
  }

  private parseOsc9(content: string): TerminalProtocolEvent[] {
    // A number alone or before `;` is a ConEmu subcommand, never a message.
    const subcommand = /^9;(\d+)(?:;|$)/.exec(content);
    if (!subcommand) {
      const body = sanitizeText(content.slice('9;'.length), BODY_LIMIT);
      return body
        ? [{ kind: 'notification', notification: { source: 'OSC 9', title: null, body } }]
        : [];
    }
    switch (subcommand[1]) {
      case '4': {
        const progress = parseOsc94(content);
        return progress ? [{ kind: 'progress', progress }] : [];
      }
      case '9': {
        // `9;9;<cwd>`; a bare `9;9` carries none.
        const cwd = cwdFromOsc9_9(content.slice(subcommand[0].length));
        return cwd ? [{ kind: 'semantic', event: { type: 'cwd', cwd } }] : [];
      }
      default:
        // Sleep, tab title, GuiMacro, the `9;12` prompt mark, ...
        return [];
    }
  }

  /**
   * rxvt/WezTerm notifications. The alert behavior is `docs/specs/alert.md` ->
   * "Terminal reports"; the grammar is here. Only the `notify` subcommand is
   * supported: the first field after it is the title and everything past the
   * next semicolon is the body, so semicolons inside a body survive — only the
   * first one separates.
   */
  private parseOsc777(content: string): TerminalProtocolEvent[] {
    if (!content.startsWith('777;notify;')) return [];
    const rest = content.slice('777;notify;'.length);
    const bodySeparator = rest.indexOf(';');
    const rawTitle = bodySeparator === -1 ? rest : rest.slice(0, bodySeparator);
    const rawBody = bodySeparator === -1 ? '' : rest.slice(bodySeparator + 1);
    const title = sanitizeText(rawTitle, TITLE_LIMIT);
    const body = sanitizeText(rawBody, BODY_LIMIT);
    if (!title && !body) return [];
    return [{ kind: 'notification', notification: { source: 'OSC 777', title, body } }];
  }

  /**
   * kitty desktop notifications. The alert behavior is `docs/specs/alert.md` ->
   * "Terminal reports"; the grammar is here.
   *
   * Metadata keys are single ASCII letters separated by `:`, and an unknown key
   * is ignored. `i` groups the chunks of one pending notification, `d` is the
   * done flag (default `1`), `e` selects plain (`0`) or base64 (`1`) payload
   * encoding, and `p` the payload type (default `title`). `title` / `body`
   * chunks append into the pending entry; the done flag completes it, and a
   * completion whose sanitized title or body is nonempty becomes one
   * notification. Without `i` there is no pending entry to append to, so only a
   * complete single-sequence notification is meaningful.
   *
   * Management payloads contribute no content and are consumed: `p=?` answers
   * the capability query with {@link OSC99_SUPPORT_PAYLOAD}, while `p=close`
   * and `p=alive` are dropped outright, touching no pending notification. Any
   * *other* unknown payload type still obeys the done flag — under the default
   * `d=1` it completes a pending same-`i` notification, which may then fire on
   * the title and body it had already accumulated.
   *
   * Incomplete chunk state is bounded, so a program that opens chunked
   * notifications and never finishes them cannot grow this map:
   * {@link OSC99_MAX_PENDING_IDS} ids, each expiring
   * {@link OSC99_PENDING_TTL_MS} after its last chunk, and each of the two
   * buffers capped as it appends.
   */
  private parseOsc99(content: string): TerminalProtocolEvent[] {
    this.expireOsc99Pending();

    if (!content.startsWith('99;')) return [];
    const afterProtocol = content.slice(3);
    const payloadSeparator = afterProtocol.indexOf(';');
    const rawMetadata = payloadSeparator === -1 ? afterProtocol : afterProtocol.slice(0, payloadSeparator);
    const rawPayload = payloadSeparator === -1 ? '' : afterProtocol.slice(payloadSeparator + 1);
    const metadata = parseOsc99Metadata(rawMetadata);
    const payloadType = metadata.get('p') ?? 'title';

    if (payloadType === '?') {
      return [{ kind: 'response', data: formatOsc99SupportResponse(metadata.get('i') ?? null) }];
    }
    if (payloadType === 'close' || payloadType === 'alive') return [];

    const id = sanitizeOsc99Id(metadata.get('i') ?? null);
    const done = metadata.get('d') !== '0';
    const encoding = metadata.get('e') ?? '0';
    const decodedPayload = encoding === '1'
      ? decodeBase64(rawPayload)
      : encoding === '0'
        ? rawPayload
        : null;
    if (decodedPayload === null) return [];

    let pending = id ? this.osc99Pending.get(id) : null;
    if (id && !pending) {
      pending = { title: '', body: '', updatedAt: Date.now() };
      this.osc99Pending.set(id, pending);
      this.enforceOsc99PendingCap();
    }

    const target = pending ?? { title: '', body: '', updatedAt: Date.now() };
    if (payloadType === 'title') {
      target.title = appendLimited(target.title, decodedPayload, OSC99_PENDING_TITLE_LIMIT);
    } else if (payloadType === 'body') {
      target.body = appendLimited(target.body, decodedPayload, OSC99_PENDING_BODY_LIMIT);
    } else if (!done) {
      if (pending) pending.updatedAt = Date.now();
      return [];
    }

    target.updatedAt = Date.now();

    if (!done) return [];
    if (id) this.osc99Pending.delete(id);

    const title = sanitizeText(target.title, TITLE_LIMIT);
    const body = sanitizeText(target.body, BODY_LIMIT);
    if (!title && !body) return [];
    return [{ kind: 'notification', notification: { source: 'OSC 99', title, body } }];
  }

  private expireOsc99Pending(): void {
    const cutoff = Date.now() - OSC99_PENDING_TTL_MS;
    for (const [id, pending] of this.osc99Pending) {
      if (pending.updatedAt < cutoff) this.osc99Pending.delete(id);
    }
  }

  private enforceOsc99PendingCap(): void {
    while (this.osc99Pending.size > OSC99_MAX_PENDING_IDS) {
      const oldest = this.osc99Pending.keys().next().value;
      if (oldest === undefined) break;
      this.osc99Pending.delete(oldest);
    }
  }
}

/**
 * The optional half of the projection pair a parse result carries to its
 * consumers: **omitted whenever it equals `visibleData`**, which is every chunk
 * with no string control in it. One helper because that rule holds at every
 * parse site and at every seam past them (`docs/specs/transport.md`).
 */
export function textProjectionOf(
  parsed: Pick<TerminalProtocolParseResult, 'visibleData' | 'textData'>,
): string | undefined {
  return parsed.textData === parsed.visibleData ? undefined : parsed.textData;
}

export function applyTerminalProtocolEvents(
  sink: TerminalProtocolAlertSink,
  id: string,
  events: TerminalProtocolEvent[],
): void {
  recordToolEvents(id, events);
  for (const event of events) {
    if (event.kind === 'notification') {
      sink.notifyFromProtocol(id, event.notification);
    } else if (event.kind === 'progress') {
      sink.updateProtocolProgress(id, event.progress);
    }
  }
}

/**
 * The notification, progress, Tool announcement and command-start events {@link applyTerminalProtocolEvents} acts
 * on. An owner whose `AlertManager` lives in another process — standalone's
 * sidecar, whose webview holds it — forwards exactly these; every other kind is
 * the owner's own to settle, a response above all.
 */
export function collectTerminalProtocolAlerts(
  events: TerminalProtocolEvent[],
): TerminalProtocolEvent[] {
  return events.filter((event) => event.kind === 'notification' || event.kind === 'progress' || event.kind === 'toolAnnounce' || event.kind === 'toolState'
    || isProtocolCommandStart(event));
}

export function collectTerminalProtocolResponses(events: TerminalProtocolEvent[]): string[] {
  return events.flatMap((event) => (event.kind === 'response' ? [event.data] : []));
}

// Keep ordering across successive PTY reads, including a clock adjustment. A
// realm-wide clock orders each of its streams without retaining per-PTY state.
const nextSemanticTimestamp = createOrderedEventTimestamp(() => Date.now());

export function collectTerminalSemanticEvents(
  events: TerminalProtocolEvent[],
  options: { now?: () => number } = {},
): TerminalSemanticEvent[] {
  const semanticEvents: TerminalSemanticEvent[] = [];
  const nextTimestamp = options.now ? createOrderedEventTimestamp(options.now) : nextSemanticTimestamp;
  for (const event of events) {
    if (event.kind === 'semantic') {
      semanticEvents.push(timestampSemanticEvent(event.event, nextTimestamp));
      continue;
    }
    if (event.kind !== 'notification') continue;
    const title = terminalTitleFromNotification(event.notification, nextTimestamp());
    if (!title) continue;
    semanticEvents.push({
      type: 'title',
      title,
    });
  }
  return semanticEvents;
}

function createOrderedEventTimestamp(now: () => number): () => number {
  let lastTimestamp = Number.NEGATIVE_INFINITY;
  return () => {
    const candidate = now();
    const timestamp = candidate > lastTimestamp ? candidate : lastTimestamp + 0.001;
    lastTimestamp = timestamp;
    return timestamp;
  };
}

function timestampSemanticEvent(
  event: TerminalSemanticEvent,
  nextTimestamp: () => number,
): TerminalSemanticEvent {
  switch (event.type) {
    case 'cwd':
      return { ...event, cwd: { ...event.cwd, updatedAt: nextTimestamp() } };
    case 'commandStart':
      return { ...event, startedAt: nextTimestamp() };
    case 'commandFinish':
      return { ...event, finishedAt: nextTimestamp() };
    case 'title':
      return { ...event, title: { ...event.title, updatedAt: nextTimestamp() } };
    default:
      return event;
  }
}

function stripStandaloneBells(segment: string, events: TerminalProtocolEvent[]): string {
  const bellIndex = segment.indexOf('\x07');
  if (bellIndex === -1) return segment;
  events.push({ kind: 'notification', notification: TERMINAL_BELL_NOTIFICATION });
  return segment.replace(/\x07/g, '');
}

/** Only text-bearing notification detail suppresses the batch's bells: a
 *  progress event may carry no summons at all (`docs/specs/alert.md` ->
 *  Terminal reports). Several bells still collapse to one. */
function filterTerminalBellEvents(events: TerminalProtocolEvent[]): TerminalProtocolEvent[] {
  if (events.length === 0) return events;
  let bellCount = 0;
  let hasRicher = false;
  for (const event of events) {
    if (event.kind !== 'notification') continue;
    if (event.notification.source === 'BEL') bellCount += 1;
    else hasRicher = true;
  }
  if (bellCount === 0) return events;
  if (!hasRicher && bellCount === 1) return events;
  let keptBell = false;
  return events.filter((event) => {
    if (event.kind !== 'notification' || event.notification.source !== 'BEL') return true;
    if (hasRicher || keptBell) return false;
    keptBell = true;
    return true;
  });
}

interface StringControl {
  index: number;
  contentStart: number;
  kind: StringControlKind;
}

function findNextStringControl(text: string, from: number): StringControl | null {
  STRING_CONTROL_INTRODUCER_SCAN.lastIndex = from;
  const match = STRING_CONTROL_INTRODUCER_SCAN.exec(text);
  if (!match) return null;
  const introducer = match[0];
  return {
    index: match.index,
    contentStart: match.index + introducer.length,
    kind: stringControlKind(introducer),
  };
}

interface StringControlEnd {
  /** Where the payload stops. */
  index: number;
  /** Where reading resumes: past a terminator or an abort byte, but *at* an ESC
   *  that cancelled the string, since that ESC opens a sequence of its own. */
  end: number;
  /** Aborted rather than terminated, so nothing it carried can be trusted. */
  cancelled: boolean;
}

/** `null` means the answer is not in these bytes yet — read another chunk. */
function findStringControlEnd(
  text: string,
  from: number,
  kind: StringControlKind,
): StringControlEnd | null {
  const scan = stringControlEndScan(kind);
  scan.lastIndex = from;
  const match = scan.exec(text);
  if (!match) return null;
  const index = match.index;
  if (text[index] !== '\x1b') {
    // BEL and the C1 ST terminate; CAN and SUB abort. Either way the byte is
    // the sequence's last, and reading resumes after it.
    const aborted = text[index] === '\x18' || text[index] === '\x1a';
    return { index, end: index + 1, cancelled: aborted };
  }
  // Only the byte after ESC separates an ST terminator from a new sequence
  // cancelling this one, so a chunk ending here has to wait for the next.
  if (index + 1 >= text.length) return null;
  if (text[index + 1] === '\\') return { index, end: index + 2, cancelled: false };
  return { index, end: index, cancelled: true };
}

function parseOsc7(content: string): TerminalProtocolEvent[] {
  if (!content.startsWith('7;')) return [];
  const cwd = cwdFromOsc7(content.slice(2));
  return cwd ? [{ kind: 'semantic', event: { type: 'cwd', cwd } }] : [];
}

function parseOsc133(content: string): TerminalProtocolEvent[] {
  const fields = content.split(';');
  if (fields[0] !== '133') return [];
  const boundary = parsePromptBoundary(fields, 'osc133_boundaries');
  if (fields[1] !== 'C') return boundary;
  // Staged ahead of the start it names, exactly as `633;E` precedes `633;C`.
  return [...parseOsc133CommandLine(content.slice('133;C'.length)), ...boundary];
}

/**
 * The command line fish ≥ 4 and kitty's shell integration put on `133;C`
 * itself: `cmdline_url=` (percent-encoded UTF-8) or `cmdline=` (one word quoted
 * by `printf %q`). `params` is everything after the `C`. `cmdline_url` wins when
 * both are present, being unambiguous; unknown keys are ignored.
 *
 * `%q` can leave a raw `;` inside `$'…'`, so `cmdline=` runs to the end of the
 * sequence, which is where both emitters put it.
 */
function parseOsc133CommandLine(params: string): TerminalProtocolEvent[] {
  const quoted = params.indexOf(';cmdline=');
  const url = (quoted === -1 ? params : params.slice(0, quoted))
    .split(';')
    .find((field) => field.startsWith('cmdline_url='));
  // One code point is at most four UTF-8 bytes of three characters each.
  if (url !== undefined) return commandLineEvents(url.slice('cmdline_url='.length), 12, decodePercentEncoded);
  if (quoted !== -1) return commandLineEvents(params.slice(quoted + ';cmdline='.length), 4, decodeShellQuotedWord);
  return [];
}

/**
 * The `commandLine` event for a shell-reported command line, from `OSC 633 ; E`
 * or `OSC 133 ; C` alike (`docs/specs/terminal-escapes.md`): bounded *before*
 * `decode` to `COMMAND_LINE_LIMIT` code points of at most `encodedWidth`
 * characters each, so a megabyte of escapes is never decoded to be thrown away,
 * and sanitized *after* it, because decoding is what puts control characters
 * back. One that reduces to nothing is dropped rather than stored empty.
 */
function commandLineEvents(
  encoded: string,
  encodedWidth: number,
  decode: (value: string) => string,
): TerminalProtocolEvent[] {
  const commandLine = sanitizeCommandLine(
    decode(truncateText(encoded, COMMAND_LINE_LIMIT * encodedWidth)),
    COMMAND_LINE_LIMIT,
  );
  return commandLine === null ? [] : [{ kind: 'semantic', event: { type: 'commandLine', commandLine } }];
}

/** Shared by every UTF-8 decode here; `decode` without `stream` keeps no state. */
const UTF8_DECODER = new TextDecoder();

/** `%XX` runs decoded as UTF-8; a malformed escape stays literal and an invalid
 *  byte sequence becomes U+FFFD, so a truncated tail never throws. */
function decodePercentEncoded(value: string): string {
  return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return UTF8_DECODER.decode(bytes);
  });
}

const ANSI_C_ESCAPES: Record<string, string> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
};
const ANSI_C_NUMERIC_ESCAPE = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/;

/**
 * Undo one `printf %q` word: `\x` escapes, `'…'`, and `$'…'` ANSI-C quoting
 * (bash and zsh use it for control characters). An unterminated quote runs to
 * the end. Double quotes are literal: `%q` never emits them unescaped.
 */
function decodeShellQuotedWord(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const char = value[i]!;
    if (char === '\\') {
      out += value[i + 1] ?? '';
      i += 2;
    } else if (char === "'") {
      const close = value.indexOf("'", i + 1);
      const end = close === -1 ? value.length : close;
      out += value.slice(i + 1, end);
      i = end + 1;
    } else if (char === '$' && value[i + 1] === "'") {
      const quoted = decodeAnsiCQuote(value, i + 2);
      out += quoted.text;
      i = quoted.end;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** The body of a `$'…'` word starting at `from` (past its `$'`), escapes
 *  decoded, and where reading resumes past its closing quote. */
function decodeAnsiCQuote(value: string, from: number): { text: string; end: number } {
  let text = '';
  let i = from;
  while (i < value.length && value[i] !== "'") {
    if (value[i] === '\\') {
      const escape = decodeAnsiCEscape(value.slice(i + 1, i + 10));
      text += escape.text;
      i += 1 + escape.width;
    } else {
      text += value[i];
      i += 1;
    }
  }
  return { text, end: i + 1 };
}

/** One ANSI-C escape, `rest` being what follows its backslash: the text it
 *  stands for and how many characters of `rest` it spans. */
function decodeAnsiCEscape(rest: string): { text: string; width: number } {
  const numeric = ANSI_C_NUMERIC_ESCAPE.exec(rest);
  if (numeric) {
    const [whole, hex, u4, u8, octal] = numeric;
    const code = Number.parseInt(hex ?? u4 ?? u8 ?? octal!, octal ? 8 : 16);
    return { text: code <= 0x10ffff ? String.fromCodePoint(code) : '', width: whole.length };
  }
  if (rest[0] === 'c' && rest.length > 1) return { text: String.fromCharCode(rest.charCodeAt(1) & 0x1f), width: 2 };
  return { text: ANSI_C_ESCAPES[rest[0] ?? ''] ?? rest[0] ?? '', width: 1 };
}

function parseOsc633(content: string): TerminalProtocolEvent[] {
  const fields = content.split(';');
  if (fields[0] !== '633') return [];
  if (fields[1] === 'E') {
    const prefix = '633;E;';
    if (!content.startsWith(prefix)) return [];
    // VS Code shell integration encodes the command as <command>[;<nonce>], with
    // any literal `;` inside <command> escaped as `\x3b`. We split on the first
    // unescaped `;` (taking only the command field) and then unescape. Emitters
    // that send raw, unescaped semicolons will see their command truncated; this
    // matches VS Code's contract rather than guessing a delimiter.
    const rawCommand = content.slice(prefix.length).split(';', 1)[0] ?? '';
    return commandLineEvents(rawCommand, 4, decodeOsc633Value);
  }
  if (fields[1] === 'P') {
    return parseOsc633Property(content.slice('633;P;'.length));
  }
  return parsePromptBoundary(fields, 'osc633_boundaries');
}

function parsePromptBoundary(fields: string[], commandStartSource: CommandRunSource): TerminalProtocolEvent[] {
  switch (fields[1]) {
    case 'A':
      return [{ kind: 'semantic', event: { type: 'promptStart' } }];
    case 'B':
      return [{ kind: 'semantic', event: { type: 'promptEnd' } }];
    case 'C':
      return [commandStartEvent(commandStartSource)];
    case 'D':
      return [{ kind: 'semantic', event: { type: 'commandFinish', exitCode: parseExitCode(fields[2]) } }];
    default:
      return [];
  }
}

function parseOsc633Property(rawProperties: string): TerminalProtocolEvent[] {
  // P carries one property; semicolons are literal path characters. Unlike E,
  // Cwd is emitted verbatim, so splitting it would change directory identity.
  if (!rawProperties.startsWith('Cwd=')) return [];
  const cwd = cwdFromOsc633(rawProperties.slice('Cwd='.length));
  return cwd ? [{ kind: 'semantic', event: { type: 'cwd', cwd } }] : [];
}

/**
 * Whether the parser will consume this OSC or hand it to xterm.js, answered from
 * the id alone (plus the subcommand for 1337) so an unterminated sequence can be
 * routed before its terminator arrives. `null` means the answer could still
 * change as bytes arrive — buffer and ask again.
 */
function oscDispositionAt(text: string, from: number): 'consume' | 'forward' | null {
  let i = from;
  while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
  // More digits may follow, and `133` becoming `1337` flips the answer.
  if (i === text.length) return null;
  if (i === from || text[i] !== ';') return 'forward';
  const id = text.slice(from, i);
  if (id === '1337') return osc1337DispositionAt(text, i + 1);
  return OSC_CONSUMED_IDS.has(id) ? 'consume' : 'forward';
}

function osc1337DispositionAt(text: string, from: number): 'consume' | 'forward' | null {
  let partial = false;
  for (const command of OSC1337_FORWARDED) {
    if (text.startsWith(command, from)) return 'forward';
    if (text.length - from < command.length && matchesPrefix(text, from, command)) partial = true;
  }
  return partial ? null : 'consume';
}

/** True when `text` from `from` is a (possibly empty) leading slice of `command`. */
function matchesPrefix(text: string, from: number, command: string): boolean {
  for (let k = 0; from + k < text.length; k += 1) {
    if (text[from + k] !== command[k]) return false;
  }
  return true;
}

function parseOsc1337(content: string): TerminalProtocolEvent[] | null {
  // Forwarded subcommands are ImageAddon's; `null` passes them through.
  if (oscDispositionAt(content, 0) === 'forward') return null;
  const prefix = '1337;CurrentDir=';
  if (!content.startsWith(prefix)) return [];
  const cwd = cwdFromOsc1337(content.slice(prefix.length));
  return cwd ? [{ kind: 'semantic', event: { type: 'cwd', cwd } }] : [];
}

function parseOscTitle(content: string, source: TerminalTitle['source']): TerminalProtocolEvent[] {
  const prefix = source === 'osc0' ? '0;' : '2;';
  if (!content.startsWith(prefix)) return [];
  const titleText = sanitizeText(content.slice(prefix.length), TITLE_LIMIT);
  if (!titleText) return [];
  // updatedAt is set authoritatively by collectTerminalSemanticEvents in stream order.
  return [{
    kind: 'semantic',
    event: {
      type: 'title',
      title: { title: titleText, source, updatedAt: 0 },
    },
  }];
}

function isKnownUnsupportedIterm2Osc(content: string): boolean {
  // Security-sensitive iTerm2 compatibility OSCs are consumed rather than
  // forwarded to xterm.js. In particular, OSC 52 is a clipboard-write channel.
  return (
    content === '50' ||
    content.startsWith('50;') ||
    content === '52' ||
    content.startsWith('52;')
  );
}

/**
 * Build the reply to an OSC 10/11/12 color query: `ESC ] <code> ; rgb:RRRR/GGGG/BBBB ST`,
 * matching the 16-bit-per-channel shape xterm/Windows Terminal emit (each 8-bit
 * channel is doubled, e.g. `0c` → `0c0c`). Returns null if `color` is missing or
 * not a parseable CSS color (see `parseColor`).
 */
export function formatOscColorResponse(code: string, color: string | null): string | null {
  const rgb = color ? parseColor(color) : null;
  if (!rgb) return null;
  const channel = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').repeat(2);
  return `\x1b]${code};rgb:${channel(rgb.r)}/${channel(rgb.g)}/${channel(rgb.b)}\x1b\\`;
}

function commandStartEvent(source: CommandRunSource): TerminalProtocolEvent {
  return { kind: 'semantic', event: { type: 'commandStart', source } };
}

function parseExitCode(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

function decodeOsc633Value(value: string): string {
  return value.replace(/\\\\|\\x([0-9a-fA-F]{2})/g, (match, hex: string | undefined) => {
    if (match === '\\\\') return '\\';
    return String.fromCharCode(Number.parseInt(hex ?? '00', 16));
  });
}

// OSC 9;4 state code → progress shape. Codes 1 and 4 require a percent
// (drop the update if missing); 2 accepts a missing/invalid percent as null.
const OSC94_STATE_TABLE: Record<string, (raw: string | null) => ProtocolProgressUpdate | null> = {
  '': () => ({ state: 'clear', percent: null }),
  '0': () => ({ state: 'clear', percent: null }),
  '1': (raw) => {
    const percent = parsePercent(raw);
    return percent === null ? null : { state: 'normal', percent };
  },
  '2': (raw) => ({ state: 'error', percent: parsePercent(raw) }),
  '3': () => ({ state: 'indeterminate', percent: null }),
  '4': (raw) => {
    const percent = parsePercent(raw);
    return percent === null ? null : { state: 'warning', percent };
  },
};

function parseOsc94(content: string): ProtocolProgressUpdate | null {
  const fields = content.split(';');
  const handler = OSC94_STATE_TABLE[fields[2] ?? ''];
  return handler ? handler(fields[3] ?? null) : null;
}

function parsePercent(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function parseOsc99Metadata(rawMetadata: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of rawMetadata.split(':')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    if (!/^[A-Za-z]$/.test(key)) continue;
    result.set(key, part.slice(separator + 1));
  }
  return result;
}

function sanitizeOsc99Id(id: string | null): string | null {
  if (!id) return null;
  const sanitized = sanitizeText(id, TITLE_LIMIT);
  return sanitized || null;
}

function formatOsc99SupportResponse(rawId: string | null): string {
  const id = normalizeOsc99ResponseId(rawId);
  const metadata = id ? `i=${id}:p=?` : 'p=?';
  return `\x1b]99;${metadata};${OSC99_SUPPORT_PAYLOAD}\x1b\\`;
}

function normalizeOsc99ResponseId(id: string | null): string | null {
  if (!id || id.length > TITLE_LIMIT) return null;
  return OSC99_RESPONSE_ID_RE.test(id) ? id : null;
}

function decodeBase64(input: string): string | null {
  const normalized = input.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return null;
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function appendLimited(existing: string, next: string, limit: number): string {
  return truncateText(`${existing}${next}`, limit);
}

const DEVICE_ATTRIBUTE_PENDING_SUFFIXES = ['\x1b[>', '\x1b[', '\x1b', '\x9b>', '\x9b'];
/** The iTerm2 extended-DA query, in both its ESC and C1 spellings. */
const DEVICE_ATTRIBUTE_QUERY = /\x1b\[>q|\x9b>q/g;

/**
 * Consume every `CSI > q` in a run of **ground text** and queue its answer.
 *
 * Ground only. The same bytes inside a string control belong to that sequence:
 * deleting them corrupts a sixel or Kitty payload on its way to xterm.js *and*
 * writes an answer nobody asked for into the PTY's input. Only the C1 spelling
 * can arrive that way — an `ESC` would have ended the string
 * ({@link findStringControlEnd}) — which is precisely why scanning the
 * assembled output rather than its ground runs read as safe.
 */
function answerDeviceAttributeQueries(ground: string, events: TerminalProtocolEvent[]): string {
  return ground.replace(DEVICE_ATTRIBUTE_QUERY, () => {
    events.push({ kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE });
    return '';
  });
}

function takeDeviceAttributePendingSuffix(visibleData: string): string {
  return DEVICE_ATTRIBUTE_PENDING_SUFFIXES.find((suffix) => visibleData.endsWith(suffix)) ?? '';
}
