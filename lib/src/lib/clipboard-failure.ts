/** Evidence for a clipboard write that failed, gathered for the report a user
 *  posts to `CLIPBOARD_FAILURE_ISSUE_URL`. A report describes the attempt and
 *  never carries the text being copied. */

export const CLIPBOARD_FAILURE_ISSUE_URL = 'https://github.com/diffplug/dormouse/issues/1090';

export interface ClipboardFailure {
  report: string;
  /** Failures this page has seen, this one included. */
  count: number;
}

/** When the page last saw a trusted press or key, which is what grants a
 *  clipboard write its activation. */
const lastInput: Record<'pointerdown' | 'keydown', number | undefined> = { pointerdown: undefined, keydown: undefined };
if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(type, event => { if (event.isTrusted) lastInput[type] = performance.now(); }, { capture: true, passive: true });
  }
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
  const since = (at: number | undefined) => at === undefined ? 'never' : `${Math.round(now - at)}ms ago`;
  return {
    startedAt: now,
    lines: [
      `time: ${new Date().toISOString()}`,
      `userAgent: ${typeof navigator === 'undefined' ? 'none' : navigator.userAgent}`,
      `textLength: ${textLength}`,
      `activation: ${activation ? `isActive=${activation.isActive} hasBeenActive=${activation.hasBeenActive}` : 'unsupported'}`,
      `event: ${event ? `${event.type} isTrusted=${event.isTrusted}` : 'none'}`,
      `lastPointerdown: ${since(lastInput.pointerdown)}`,
      `lastKeydown: ${since(lastInput.keydown)}`,
      `document: hasFocus=${typeof document === 'undefined' ? 'n/a' : document.hasFocus()} visibility=${typeof document === 'undefined' ? 'n/a' : document.visibilityState}`,
      `activeElement: ${active ? active.tagName.toLowerCase() + (active.className && typeof active.className === 'string' ? `.${active.className.trim().split(/\s+/)[0]}` : '') : 'none'}`,
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
