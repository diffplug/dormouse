/** Evidence for a clipboard write that failed, gathered for the report a user
 *  posts to `CLIPBOARD_FAILURE_ISSUE_URL`. A report describes the attempt and
 *  never carries the text being copied. */

export const CLIPBOARD_FAILURE_ISSUE_URL = 'https://github.com/diffplug/dormouse/issues/1090';

export interface ClipboardFailure {
  report: string;
  /** Failures this page has seen, this one included. */
  count: number;
}

/** The trusted input events that can grant, or follow from, a clipboard
 *  write's activation. A touch grants it at `touchend` or its `pointerup`, a
 *  mouse at its press, so each pointer event names its pointer type. */
const TIMELINE_EVENTS = ['keydown', 'pointerdown', 'mousedown', 'pointerup', 'touchend', 'mouseup', 'click'] as const;
const TIMELINE_LENGTH = 12;

/** The latest trusted input events, oldest first, each with whether the page
 *  held transient activation as it arrived: whether a failed write's press was
 *  never granted activation, or was granted and lost before its click. */
const timeline: Array<{ type: string; at: number; target: string; active: boolean | undefined }> = [];
if (typeof window !== 'undefined') {
  for (const type of TIMELINE_EVENTS) window.addEventListener(type, recordInput, { capture: true, passive: true });
}

/** Add one input event to the timeline; exported because tests cannot
 *  dispatch a trusted event. */
export function recordInput(event: Pick<Event, 'type' | 'isTrusted' | 'target'> & { pointerType?: string }): void {
  if (!event.isTrusted) return;
  const type = event.pointerType ? `${event.type}:${event.pointerType}` : event.type;
  timeline.push({ type, at: performance.now(), target: describeElement(event.target), active: navigator.userActivation?.isActive });
  if (timeline.length > TIMELINE_LENGTH) timeline.shift();
}

function describeElement(target: EventTarget | null): string {
  if (!(target instanceof Element)) return 'none';
  const firstClass = typeof target.className === 'string' ? target.className.trim().split(/\s+/)[0] : '';
  return target.tagName.toLowerCase() + (firstClass ? `.${firstClass}` : '');
}

/** The page's state when a write starts, read synchronously so it describes
 *  the click or key that asked. */
export interface ClipboardAttempt {
  startedAt: number;
  lines: string[];
}

export function beginClipboardAttempt(textLength: number): ClipboardAttempt {
  const now = performance.now();
  const activation = typeof navigator === 'undefined' ? undefined : navigator.userActivation;
  const event = typeof window === 'undefined' ? undefined : (window as { event?: Event }).event;
  const active = typeof document === 'undefined' ? null : document.activeElement;
  return {
    startedAt: now,
    lines: [
      `time: ${new Date().toISOString()}`,
      `userAgent: ${typeof navigator === 'undefined' ? 'none' : navigator.userAgent}`,
      `textLength: ${textLength}`,
      `activation: ${activation ? `isActive=${activation.isActive} hasBeenActive=${activation.hasBeenActive}` : 'unsupported'}`,
      `event: ${event ? `${event.type} isTrusted=${event.isTrusted}` : 'none'}`,
      `document: hasFocus=${typeof document === 'undefined' ? 'n/a' : document.hasFocus()} visibility=${typeof document === 'undefined' ? 'n/a' : document.visibilityState}`,
      `activeElement: ${describeElement(active)}`,
      'input timeline (trusted, oldest first; activation as each arrived):',
      ...(timeline.length === 0 ? ['  none'] : timeline.map(entry => `  -${Math.round(now - entry.at)}ms ${entry.type} ${entry.target} active=${entry.active ?? 'unknown'}`)),
    ],
  };
}

/** Add one step's outcome to the attempt, timed from its start. */
export function noteClipboardStep(attempt: ClipboardAttempt, step: string): void {
  attempt.lines.push(`+${Math.round(performance.now() - attempt.startedAt)}ms ${step}`);
}

let failure: ClipboardFailure | null = null;
let count = 0;
const listeners = new Set<() => void>();

export function reportClipboardFailure(attempt: ClipboardAttempt): void {
  count += 1;
  failure = { report: attempt.lines.join('\n'), count };
  console.warn('[clipboard] copy failed\n' + failure.report);
  for (const listener of listeners) listener();
}

export function dismissClipboardFailure(): void {
  failure = null;
  for (const listener of listeners) listener();
}

export function getClipboardFailure(): ClipboardFailure | null {
  return failure;
}

export function subscribeToClipboardFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
