/** Demo terminal content shared by the Storybook stories and the WebXR demo. */

export const ESC = '\x1b[';
export const RESET = `${ESC}0m`;

/** HSV(h, 1, 1) → rgb, for the truecolor gradient row. */
function hueRgb(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

export function label(name: string): string {
  return `${ESC}90m${name.padEnd(12)}${RESET}`;
}

export function demoContent(): string {
  const lines: string[] = [];

  lines.push(`${ESC}1;38;2;120;220;120mcanopy${RESET} ${ESC}90m·${RESET} @diffplug/xterm-addon-webgl-sdf`);
  lines.push('');

  const fg16 = [...Array(8).keys()].map((i) => `${ESC}${30 + i}m▉▉`).join('')
    + [...Array(8).keys()].map((i) => `${ESC}${90 + i}m▉▉`).join('') + RESET;
  const bg16 = [...Array(8).keys()].map((i) => `${ESC}${40 + i}m  `).join('')
    + [...Array(8).keys()].map((i) => `${ESC}${100 + i}m  `).join('') + RESET;
  lines.push(label('ansi 16') + fg16);
  lines.push(label('') + bg16);

  const cube = [...Array(64).keys()]
    .map((i) => `${ESC}48;5;${16 + Math.floor((i * 215) / 63)}m `)
    .join('') + RESET;
  const gray = [...Array(24).keys()].map((i) => `${ESC}48;5;${232 + i}m  `).join('') + RESET;
  lines.push(label('256 color') + cube);
  lines.push(label('') + gray);

  const gradient = [...Array(64).keys()]
    .map((i) => {
      const [r, g, b] = hueRgb((i * 360) / 64);
      return `${ESC}48;2;${r};${g};${b}m `;
    })
    .join('') + RESET;
  lines.push(label('truecolor') + gradient);
  lines.push('');

  lines.push(
    label('attrs')
    + `${ESC}1mbold${RESET} ${ESC}2mdim${RESET} ${ESC}3mitalic${RESET} ${ESC}4munderline${RESET} `
    + `${ESC}4:3;58:2::255;80;80mcurly${RESET} ${ESC}21mdouble${RESET} ${ESC}9mstrike${RESET} `
    + `${ESC}7m inverse ${RESET} ${ESC}53moverline${RESET}`,
  );
  lines.push('');

  // customGlyphs territory: box drawing + block elements render via the
  // addon's custom glyph rasterizer, not the font — these stay raster even in SDF mode.
  lines.push(label('boxes') + '┌─ single ──────┐ ╔═ double ══════╗ ╭─ rounded ─────╮');
  lines.push(label('') + '│ ░░▒▒▓▓████▓▒░ │ ║ ▁▂▃▄▅▆▇█▇▆▅▄▃ ║ ╎ ┄┄┄┄ ╌╌╌╌ ┈┈┈ ╎');
  lines.push(label('') + '└───────────────┘ ╚═══════════════╝ ╰───────────────╯');
  lines.push('');

  // Written as \uE0BX escapes, not literal PUA chars: the literals are invisible in editors and
  // were once silently dropped in a file rewrite, which read as a rendering regression
  lines.push(
    label('powerline')
    + `${ESC}30;44m ~/dormouse ${ESC}34;42m\ue0b0${ESC}30m canopy ${ESC}32;49m\ue0b0${RESET}`
    + `  \ue0b1 \ue0b3  ${ESC}36m\ue0b2${ESC}30;46m sdf ${RESET}`,
  );
  lines.push(label('wide/CJK') + '你好, 世界 — こんにちは ｶﾀｶﾅ');
  lines.push(label('emoji') + '🦎 🌲 🍄 ✨ 🚀');
  lines.push('');
  lines.push(`${ESC}90m$ ${RESET}echo "rendered by WebGL2"`);

  return lines.join('\r\n');
}
