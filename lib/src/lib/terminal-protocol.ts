import type { ActivityNotification, ProtocolProgressUpdate } from './alert-manager';
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
  | { kind: 'progress'; progress: ProtocolProgressUpdate }
  | { kind: 'response'; data: string }
  | { kind: 'semantic'; event: TerminalSemanticEvent };

export interface TerminalProtocolAlertSink {
  notifyFromProtocol(id: string, notification: ActivityNotification): void;
  updateProtocolProgress(id: string, progress: ProtocolProgressUpdate): void;
}

export interface TerminalProtocolParseResult {
  visibleData: string;
  events: TerminalProtocolEvent[];
}

interface Osc99PendingNotification {
  title: string;
  body: string;
  updatedAt: number;
}

const OSC_INCOMPLETE_LIMIT = 16_384;
const NO_EVENTS: readonly TerminalProtocolEvent[] = Object.freeze([]);
// Standalone BEL, OSC introducers (ESC ] / 0x9D), and the iTerm2 extended-DA query (ESC [ > q / 0x9B > q).
const NEEDS_PARSE_RE = /[\x07\x1b\x9b\x9d]/;
const OSC99_PENDING_TTL_MS = 60_000;
const OSC99_MAX_PENDING_IDS = 64;
const TITLE_LIMIT = 256;
const BODY_LIMIT = 4096;
const OSC99_PENDING_TITLE_LIMIT = 2048;
const OSC99_PENDING_BODY_LIMIT = 16_384;
const OSC99_SUPPORT_PAYLOAD = 'o=always:p=title,body';
const OSC99_RESPONSE_ID_RE = /^[^\s:;\x00-\x1f\x7f-\x9f]+$/;
const TERMINAL_BELL_NOTIFICATION: ActivityNotification = { source: 'BEL', title: 'Terminal bell', body: null };
export const ITERM2_COMPAT_VERSION = '3.5.0';
export const ITERM2_DEVICE_ATTRIBUTES_RESPONSE = `\x1bP>|iTerm2 ${ITERM2_COMPAT_VERSION}\x1b\\`;

export class TerminalProtocolParser {
  private pending = '';
  private osc99Pending = new Map<string, Osc99PendingNotification>();

  process(data: string): TerminalProtocolParseResult {
    if (this.pending === '' && !NEEDS_PARSE_RE.test(data)) {
      return { visibleData: data, events: NO_EVENTS as TerminalProtocolEvent[] };
    }
    const text = this.pending + data;
    this.pending = '';
    const events: TerminalProtocolEvent[] = [];
    let visibleData = '';
    let index = 0;

    while (index < text.length) {
      const osc = findNextOsc(text, index);
      if (!osc) {
        visibleData += stripStandaloneBells(text.slice(index), events);
        break;
      }

      visibleData += stripStandaloneBells(text.slice(index, osc.index), events);
      const terminator = findOscTerminator(text, osc.contentStart);
      if (!terminator) {
        const incomplete = text.slice(osc.index);
        if (incomplete.length <= OSC_INCOMPLETE_LIMIT) this.pending = incomplete;
        break;
      }

      const sequence = text.slice(osc.index, terminator.end);
      const content = text.slice(osc.contentStart, terminator.index);
      const parsed = this.parseOsc(content);
      if (parsed === null) {
        visibleData += sequence;
      } else {
        events.push(...parsed);
      }
      index = terminator.end;
    }

    const stripped = stripDeviceAttributeQueries(visibleData, events);
    if (stripped.pending) this.pending = stripped.pending + this.pending;
    return { visibleData: stripped.visibleData, events: filterTerminalBellEvents(events) };
  }

  reset(): void {
    this.pending = '';
    this.osc99Pending.clear();
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
    return null;
  }

  private parseOsc9(content: string): TerminalProtocolEvent[] {
    if (!content.startsWith('9;')) return [];

    if (content.startsWith('9;9;')) {
      const cwd = cwdFromOsc9_9(content.slice('9;9;'.length));
      return cwd ? [{ kind: 'semantic', event: { type: 'cwd', cwd } }] : [];
    }

    if (content === '9;4' || content.startsWith('9;4;')) {
      const progress = parseOsc94(content);
      return progress ? [{ kind: 'progress', progress }] : [];
    }

    const body = sanitizeText(content.slice(2), BODY_LIMIT);
    return body
      ? [{ kind: 'notification', notification: { source: 'OSC 9', title: null, body } }]
      : [];
  }

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

export function applyTerminalProtocolEvents(
  sink: TerminalProtocolAlertSink,
  id: string,
  events: TerminalProtocolEvent[],
): void {
  for (const event of events) {
    if (event.kind === 'notification') {
      sink.notifyFromProtocol(id, event.notification);
    } else if (event.kind === 'progress') {
      sink.updateProtocolProgress(id, event.progress);
    }
  }
}

export function collectTerminalProtocolResponses(events: TerminalProtocolEvent[]): string[] {
  return events.flatMap((event) => (event.kind === 'response' ? [event.data] : []));
}

export function collectTerminalSemanticEvents(
  events: TerminalProtocolEvent[],
  options: { now?: () => number } = {},
): TerminalSemanticEvent[] {
  const semanticEvents: TerminalSemanticEvent[] = [];
  const nextTimestamp = createOrderedEventTimestamp(options.now ?? Date.now);
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

function filterTerminalBellEvents(events: TerminalProtocolEvent[]): TerminalProtocolEvent[] {
  if (events.length === 0) return events;
  let bellCount = 0;
  let hasRicher = false;
  for (const event of events) {
    if (event.kind === 'progress') hasRicher = true;
    else if (event.kind === 'notification') {
      if (event.notification.source === 'BEL') bellCount += 1;
      else hasRicher = true;
    }
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

function findNextOsc(text: string, from: number): { index: number; contentStart: number } | null {
  const escIndex = text.indexOf('\x1b]', from);
  const c1Index = text.indexOf('\x9d', from);
  if (escIndex === -1 && c1Index === -1) return null;
  if (escIndex !== -1 && (c1Index === -1 || escIndex < c1Index)) {
    return { index: escIndex, contentStart: escIndex + 2 };
  }
  return { index: c1Index, contentStart: c1Index + 1 };
}

function findOscTerminator(text: string, from: number): { index: number; end: number } | null {
  const bel = text.indexOf('\x07', from);
  const st = text.indexOf('\x1b\\', from);
  const c1St = text.indexOf('\x9c', from);
  let bestIndex = -1;
  let bestEndOffset = 1;
  if (bel !== -1) { bestIndex = bel; bestEndOffset = 1; }
  if (st !== -1 && (bestIndex === -1 || st < bestIndex)) { bestIndex = st; bestEndOffset = 2; }
  if (c1St !== -1 && (bestIndex === -1 || c1St < bestIndex)) { bestIndex = c1St; bestEndOffset = 1; }
  if (bestIndex === -1) return null;
  return { index: bestIndex, end: bestIndex + bestEndOffset };
}

function parseOsc7(content: string): TerminalProtocolEvent[] {
  if (!content.startsWith('7;')) return [];
  const cwd = cwdFromOsc7(content.slice(2));
  return cwd ? [{ kind: 'semantic', event: { type: 'cwd', cwd } }] : [];
}

function parseOsc133(content: string): TerminalProtocolEvent[] {
  const fields = content.split(';');
  if (fields[0] !== '133') return [];
  return parsePromptBoundary(fields, 'osc133_boundaries');
}

function parseOsc633(content: string): TerminalProtocolEvent[] {
  const fields = content.split(';');
  if (fields[0] !== '633') return [];
  if (fields[1] === 'E') {
    const prefix = '633;E;';
    if (!content.startsWith(prefix)) return [];
    const rawCommand = content.slice(prefix.length).split(';', 1)[0] ?? '';
    return [{ kind: 'semantic', event: { type: 'commandLine', commandLine: decodeOsc633Value(rawCommand) } }];
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
  for (const property of rawProperties.split(';')) {
    if (!property.startsWith('Cwd=')) continue;
    const cwd = cwdFromOsc633(property.slice('Cwd='.length));
    return cwd ? [{ kind: 'semantic', event: { type: 'cwd', cwd } }] : [];
  }
  return [];
}

function parseOsc1337(content: string): TerminalProtocolEvent[] {
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
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function sanitizeText(input: string, limit: number): string | null {
  const collapsed = input
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return null;
  return truncateText(collapsed, limit);
}

function appendLimited(existing: string, next: string, limit: number): string {
  return truncateText(`${existing}${next}`, limit);
}

function truncateText(input: string, limit: number): string {
  if (input.length <= limit) return input;
  return Array.from(input).slice(0, limit).join('');
}

const DEVICE_ATTRIBUTE_PENDING_SUFFIXES = ['\x1b[>', '\x1b[', '\x1b', '\x9b>', '\x9b'];

function stripDeviceAttributeQueries(
  visibleData: string,
  events: TerminalProtocolEvent[],
): { visibleData: string; pending: string } {
  const pending = takeDeviceAttributePendingSuffix(visibleData);
  const searchableData = pending ? visibleData.slice(0, -pending.length) : visibleData;

  if (searchableData.indexOf('\x1b[>q') === -1 && searchableData.indexOf('\x9b>q') === -1) {
    return { visibleData: searchableData, pending };
  }

  let stripped = '';
  let index = 0;
  while (index < searchableData.length) {
    const escQueryIndex = searchableData.indexOf('\x1b[>q', index);
    const c1QueryIndex = searchableData.indexOf('\x9b>q', index);
    if (escQueryIndex === -1 && c1QueryIndex === -1) {
      stripped += searchableData.slice(index);
      break;
    }
    const useEsc = escQueryIndex !== -1 && (c1QueryIndex === -1 || escQueryIndex < c1QueryIndex);
    const queryIndex = useEsc ? escQueryIndex : c1QueryIndex;
    stripped += searchableData.slice(index, queryIndex);
    events.push({ kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE });
    index = queryIndex + (useEsc ? 4 : 3);
  }
  return { visibleData: stripped, pending };
}

function takeDeviceAttributePendingSuffix(visibleData: string): string {
  return DEVICE_ATTRIBUTE_PENDING_SUFFIXES.find((suffix) => visibleData.endsWith(suffix)) ?? '';
}
