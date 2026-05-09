export interface PromptCommandInputState {
  line: string;
  cursor: number;
  trusted: boolean;
}

export interface PromptCommandInputResult {
  state: PromptCommandInputState;
  submittedCommandLine: string | null;
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const CSI_RE = /^\x1b\[[0-9;?]*[A-Za-z~]/;

export function createPromptCommandInputState(): PromptCommandInputState {
  return { line: '', cursor: 0, trusted: true };
}

export function updatePromptCommandInput(
  current: PromptCommandInputState,
  input: string,
): PromptCommandInputResult {
  let state = { ...current };
  let submittedCommandLine: string | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const rest = input.slice(index);
    const char = input[index];

    if (rest.startsWith(BRACKETED_PASTE_START)) {
      index += BRACKETED_PASTE_START.length - 1;
      continue;
    }
    if (rest.startsWith(BRACKETED_PASTE_END)) {
      index += BRACKETED_PASTE_END.length - 1;
      continue;
    }

    if (char === '\x1b') {
      const match = rest.match(CSI_RE);
      if (match) {
        state = applyCsiInput(state, match[0]);
        index += match[0].length - 1;
      }
      continue;
    }

    if (char === '\r' || char === '\n') {
      const submitted = state.trusted ? state.line.trim() : '';
      if (submitted && submittedCommandLine === null) submittedCommandLine = submitted;
      state = createPromptCommandInputState();
      continue;
    }

    state = applyControlOrTextInput(state, char);
  }

  return { state, submittedCommandLine };
}

function applyCsiInput(state: PromptCommandInputState, sequence: string): PromptCommandInputState {
  const final = sequence[sequence.length - 1];
  if (final === 'D') return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (final === 'C') return { ...state, cursor: Math.min(state.line.length, state.cursor + 1) };
  if (final === 'A' || final === 'B') return { line: '', cursor: 0, trusted: false };
  return state;
}

function applyControlOrTextInput(
  state: PromptCommandInputState,
  char: string,
): PromptCommandInputState {
  if (char === '\x03' || char === '\x04' || char === '\x15') return createPromptCommandInputState();
  if (char === '\x01') return { ...state, cursor: 0 };
  if (char === '\x05') return { ...state, cursor: state.line.length };
  if (char === '\x0b') return { ...state, line: state.line.slice(0, state.cursor) };
  if (char === '\x17') return deleteWordBeforeCursor(state);
  if (char === '\x7f' || char === '\b') return deleteBeforeCursor(state);

  if (char < ' ' || char === '\x7f') return state;

  const before = state.line.slice(0, state.cursor);
  const after = state.line.slice(state.cursor);
  return {
    line: `${before}${char}${after}`,
    cursor: state.cursor + char.length,
    trusted: state.trusted,
  };
}

function deleteBeforeCursor(state: PromptCommandInputState): PromptCommandInputState {
  if (state.cursor === 0) return state;
  return {
    ...state,
    line: `${state.line.slice(0, state.cursor - 1)}${state.line.slice(state.cursor)}`,
    cursor: state.cursor - 1,
  };
}

function deleteWordBeforeCursor(state: PromptCommandInputState): PromptCommandInputState {
  if (state.cursor === 0) return state;
  const beforeCursor = state.line.slice(0, state.cursor);
  const afterCursor = state.line.slice(state.cursor);
  const trimmedEnd = beforeCursor.replace(/\s+$/, '');
  const wordStart = trimmedEnd.search(/\S+$/);
  const keepUntil = wordStart === -1 ? 0 : wordStart;
  return {
    ...state,
    line: `${beforeCursor.slice(0, keepUntil)}${afterCursor}`,
    cursor: keepUntil,
  };
}
