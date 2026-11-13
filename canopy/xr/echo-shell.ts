import type { Terminal } from '@xterm/xterm';

const PROMPT = '\x1b[32m$\x1b[0m ';
/** X10-compatible press/release reporting (1000) in SGR encoding (1006). */
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';
const SGR_REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * A stand-in for a PTY until the demo has live terminals: a line editor that echoes keystrokes and
 * answers each line, so desktop typing in IWER visibly lands in the scene's terminal. The `mouse`
 * command toggles mouse reporting the way a TUI would, and prints each report it then receives.
 */
export function attachEchoShell(term: Terminal): () => void {
  let line = '';
  let mouse = false;
  term.write(`\r\n\x1b[90mtype \`mouse\` to toggle mouse reporting\x1b[0m\r\n${PROMPT}`);

  const run = (command: string) => {
    if (command.trim() === 'mouse') {
      mouse = !mouse;
      term.write(mouse ? MOUSE_ON : MOUSE_OFF);
      return `mouse reporting ${mouse ? 'on: click the pane' : 'off'}`;
    }
    return `\x1b[90mecho:\x1b[0m ${command}`;
  };

  const sub = term.onData((data) => {
    const reports = [...data.matchAll(SGR_REPORT)];
    if (reports.length) {
      for (const [, button, col, row, kind] of reports) {
        term.write(`\r\x1b[K\x1b[33mmouse ${kind === 'M' ? 'press' : 'release'} button ${button} at col ${col}, row ${row}\x1b[0m\r\n${PROMPT}${line}`);
      }
      return;
    }
    for (const ch of data) {
      if (ch === '\r') {
        term.write(line ? `\r\n${run(line)}\r\n${PROMPT}` : `\r\n${PROMPT}`);
        line = '';
      } else if (ch === '\x7f') {
        if (line) {
          line = line.slice(0, -1);
          term.write('\b \b');
        }
      } else if (ch >= ' ') {
        line += ch;
        term.write(ch);
      }
    }
  });
  return () => sub.dispose();
}
