import type { ActivityNotification, ProtocolProgressUpdate } from './alert-manager';

export type TerminalProtocolEvent =
  | { kind: 'notification'; notification: ActivityNotification }
  | { kind: 'progress'; progress: ProtocolProgressUpdate }
  | { kind: 'response'; data: string };

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
const OSC99_PENDING_TTL_MS = 60_000;
const OSC99_MAX_PENDING_IDS = 64;
const TITLE_LIMIT = 256;
const BODY_LIMIT = 4096;
const OSC99_PENDING_TITLE_LIMIT = 2048;
const OSC99_PENDING_BODY_LIMIT = 16_384;
export const ITERM2_COMPAT_VERSION = '3.5.0';
export const ITERM2_DEVICE_ATTRIBUTES_RESPONSE = `\x1bP>|iTerm2 ${ITERM2_COMPAT_VERSION}\x1b\\`;

export class TerminalProtocolParser {
  private pending = '';
  private osc99Pending = new Map<string, Osc99PendingNotification>();

  process(data: string): TerminalProtocolParseResult {
    const text = this.pending + data;
    this.pending = '';
    const events: TerminalProtocolEvent[] = [];
    let visibleData = '';
    let index = 0;

    while (index < text.length) {
      const osc = findNextOsc(text, index);
      if (!osc) {
        visibleData += text.slice(index);
        break;
      }

      visibleData += text.slice(index, osc.index);
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

    return stripDeviceAttributeQueries(visibleData, events);
  }

  reset(): void {
    this.pending = '';
    this.osc99Pending.clear();
  }

  private parseOsc(content: string): TerminalProtocolEvent[] | null {
    if (content === '9' || content.startsWith('9;')) return this.parseOsc9(content);
    if (content === '99' || content.startsWith('99;')) return this.parseOsc99(content);
    if (content === '777' || content.startsWith('777;')) return this.parseOsc777(content);
    return null;
  }

  private parseOsc9(content: string): TerminalProtocolEvent[] {
    if (!content.startsWith('9;')) return [];

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

    if (payloadType === '?' || payloadType === 'close' || payloadType === 'alive') return [];

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
  const candidates = [
    { index: text.indexOf('\x07', from), endOffset: 1 },
    { index: text.indexOf('\x1b\\', from), endOffset: 2 },
    { index: text.indexOf('\x9c', from), endOffset: 1 },
  ].filter((candidate) => candidate.index !== -1);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  const first = candidates[0];
  return { index: first.index, end: first.index + first.endOffset };
}

function parseOsc94(content: string): ProtocolProgressUpdate | null {
  const fields = content.split(';');
  const state = fields[2] ?? '';
  const rawPercent = fields[3] ?? null;

  if (state === '' || state === '0') return { state: 'clear', percent: null };

  if (state === '1') {
    const percent = parsePercent(rawPercent);
    return percent === null ? null : { state: 'normal', percent };
  }

  if (state === '2') {
    return { state: 'error', percent: parsePercent(rawPercent) };
  }

  if (state === '3') {
    return { state: 'indeterminate', percent: null };
  }

  if (state === '4') {
    const percent = parsePercent(rawPercent);
    return percent === null ? null : { state: 'warning', percent };
  }

  return null;
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

function decodeBase64(input: string): string | null {
  const normalized = input.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return null;

  try {
    const atobFn = (globalThis as { atob?: (value: string) => string }).atob;
    if (typeof atobFn === 'function') {
      const binary = atobFn(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }

    const bufferCtor = (globalThis as { Buffer?: { from(value: string, encoding: 'base64'): Uint8Array } }).Buffer;
    if (!bufferCtor) return null;
    return new TextDecoder().decode(bufferCtor.from(normalized, 'base64'));
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
  return Array.from(input).slice(0, limit).join('');
}

function stripDeviceAttributeQueries(
  visibleData: string,
  events: TerminalProtocolEvent[],
): TerminalProtocolParseResult {
  let stripped = '';
  let index = 0;

  while (index < visibleData.length) {
    const escQueryIndex = visibleData.indexOf('\x1b[>q', index);
    const c1QueryIndex = visibleData.indexOf('\x9b>q', index);
    if (escQueryIndex === -1 && c1QueryIndex === -1) {
      stripped += visibleData.slice(index);
      break;
    }

    const useEsc = escQueryIndex !== -1 && (c1QueryIndex === -1 || escQueryIndex < c1QueryIndex);
    const queryIndex = useEsc ? escQueryIndex : c1QueryIndex;
    stripped += visibleData.slice(index, queryIndex);
    events.push({ kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE });
    index = queryIndex + (useEsc ? 4 : 3);
  }

  return { visibleData: stripped, events };
}
