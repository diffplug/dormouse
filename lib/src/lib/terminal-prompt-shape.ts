// Locating the command on a rendered prompt line, for shells without OSC
// 133/633 integration. Rather than reconstruct keystrokes (which can't see
// history recall, paste, or autosuggest) or guess the prompt boundary from
// text, we learn a cwd-invariant "shape" of the prompt from a known prompt line
// and reuse it to split the command off the rendered line at submit time.
//
// The shape is the prompt's trailing terminator character (`%` zsh, `$`/`#`
// bash, `>` cmd/PowerShell, arrow themes) plus how many times that character
// already appears in the prompt. Splitting *after* the terminator means the
// trailing space some shells add (zsh `% `) and others don't (cmd `>`) doesn't
// matter — we trim leading whitespace off the result either way.

const PROMPT_TERMINATORS = new Set(['%', '$', '#', '>', '❯', '➜', 'λ']);

export interface PromptShape {
  // The prompt's final non-whitespace character.
  terminator: string;
  // How many times `terminator` occurs earlier in the prompt. Lets us pick the
  // right occurrence on the rendered line: 0 for a plain `user@host dir %`, more
  // for themed prompts that embed the character (e.g. a `[50%]` segment).
  countBefore: number;
}

// Derive a shape from a bare prompt line (no typed command). Returns null when
// the prompt doesn't end in a recognized terminator — we'd rather produce no
// title than slice at the wrong place.
export function derivePromptShape(promptLine: string): PromptShape | null {
  const trimmed = promptLine.replace(/\s+$/, '');
  if (trimmed.length === 0) return null;
  const terminator = trimmed[trimmed.length - 1];
  if (!PROMPT_TERMINATORS.has(terminator)) return null;

  let countBefore = 0;
  for (let i = 0; i < trimmed.length - 1; i += 1) {
    if (trimmed[i] === terminator) countBefore += 1;
  }
  return { terminator, countBefore };
}

// Slice the command off a rendered `prompt + command` line using a known shape.
// Skips `countBefore` earlier terminators, then the prompt's own, and trims what
// follows. Command-internal terminators (e.g. redirection `>`) sit after the
// prompt's, so they're preserved.
export function extractCommand(renderedLine: string, shape: PromptShape): string | null {
  let index = -1;
  for (let occurrence = 0; occurrence <= shape.countBefore; occurrence += 1) {
    index = renderedLine.indexOf(shape.terminator, index + 1);
    if (index === -1) return null; // fewer terminators than the prompt had — not this prompt
  }
  const command = renderedLine.slice(index + shape.terminator.length).trim();
  return command.length > 0 ? command : null;
}
