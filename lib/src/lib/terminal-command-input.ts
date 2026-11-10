// Detecting when the user submits a command (presses Enter) in the PTY input
// stream. We no longer reconstruct the command line from keystrokes — that's
// read from the rendered buffer instead (see terminal-buffer-read.ts and
// terminal-prompt-shape.ts). All we need here is "was this an Enter, and was it
// a real submit rather than a newline pasted mid-command?"
//
// Bracketed paste wraps pasted text in \x1b[200~ … \x1b[201~; newlines inside
// that span are multiline edits, not submits. The paste markers can straddle
// input chunks, so the in-paste flag persists across calls.
//
// ConPTY turns on win32-input-mode (`CSI ? 9001 h`) at startup, so on Windows
// xterm sends Enter as a key record, `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`,
// never a bare CR. A key-down of VK_RETURN submits unless Ctrl is held: cmd.exe
// runs the line on plain, Shift, and Alt+Enter but not on Ctrl+Enter. xterm
// emits each record whole within one onData chunk.

export interface PromptSubmitState {
  inPaste: boolean;
  // At most five bytes: a prefix of either six-byte paste marker.
  pendingMarker?: string;
}

export interface PromptSubmitResult {
  state: PromptSubmitState;
  submitted: boolean;
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const WIN32_KEY_RECORD = /^\x1b\[(\d+);\d+;\d+;([01]);(\d+);\d+_/;
const VK_RETURN = 13;
const CTRL_PRESSED = 0b1100; // RIGHT_CTRL_PRESSED | LEFT_CTRL_PRESSED

export function createPromptSubmitState(): PromptSubmitState {
  return { inPaste: false };
}

export function detectPromptSubmit(current: PromptSubmitState, input: string): PromptSubmitResult {
  let inPaste = current.inPaste;
  let submitted = false;
  input = (current.pendingMarker ?? '') + input;

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
    if (BRACKETED_PASTE_START.startsWith(rest) || BRACKETED_PASTE_END.startsWith(rest)) {
      return { state: { inPaste, pendingMarker: rest }, submitted };
    }
    const record = WIN32_KEY_RECORD.exec(rest);
    if (record) {
      const [whole, vk, keyDown, controlState] = record;
      if (!inPaste && Number(vk) === VK_RETURN && keyDown === '1' && (Number(controlState) & CTRL_PRESSED) === 0) {
        submitted = true;
      }
      index += whole.length - 1;
      continue;
    }
    const char = input[index];
    if (!inPaste && (char === '\r' || char === '\n')) submitted = true;
  }

  return { state: { inPaste }, submitted };
}
