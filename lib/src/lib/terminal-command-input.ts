// Detecting when the user submits a command (presses Enter) in the PTY input
// stream. We no longer reconstruct the command line from keystrokes — that's
// read from the rendered buffer instead (see terminal-buffer-read.ts and
// terminal-prompt-shape.ts). All we need here is "was this an Enter, and was it
// a real submit rather than a newline pasted mid-command?"
//
// Bracketed paste wraps pasted text in \x1b[200~ … \x1b[201~; newlines inside
// that span are multiline edits, not submits. The paste markers can straddle
// input chunks, so the in-paste flag persists across calls.

export interface PromptSubmitState {
  inPaste: boolean;
}

export interface PromptSubmitResult {
  state: PromptSubmitState;
  submitted: boolean;
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export function createPromptSubmitState(): PromptSubmitState {
  return { inPaste: false };
}

export function detectPromptSubmit(current: PromptSubmitState, input: string): PromptSubmitResult {
  let inPaste = current.inPaste;
  let submitted = false;

  for (let index = 0; index < input.length; index += 1) {
    const rest = input.slice(index);
    if (rest.startsWith(BRACKETED_PASTE_START)) {
      inPaste = true;
      index += BRACKETED_PASTE_START.length - 1;
      continue;
    }
    if (rest.startsWith(BRACKETED_PASTE_END)) {
      inPaste = false;
      index += BRACKETED_PASTE_END.length - 1;
      continue;
    }
    const char = input[index];
    if (!inPaste && (char === '\r' || char === '\n')) submitted = true;
  }

  return { state: { inPaste }, submitted };
}
