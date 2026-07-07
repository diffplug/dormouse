import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@diffplug/xterm-addon-webgl-sdf';
import '@xterm/xterm/css/xterm.css';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** HSV(h, 1, 1) → rgb, for the truecolor gradient row. */
function hueRgb(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

function label(name: string): string {
  return `${ESC}90m${name.padEnd(12)}${RESET}`;
}

function demoContent(): string {
  const lines: string[] = [];

  lines.push(`${ESC}1;38;2;120;220;120mcanopy${RESET} ${ESC}90m·${RESET} @diffplug/xterm-addon-webgl-sdf ${ESC}90m(stock upstream WebGL renderer — SDF conversion pending)${RESET}`);
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
  // addon's custom glyph rasterizer, not the font — a key case for SDF later.
  lines.push(label('boxes') + '┌─ single ──────┐ ╔═ double ══════╗ ╭─ rounded ─────╮');
  lines.push(label('') + '│ ░░▒▒▓▓████▓▒░ │ ║ ▁▂▃▄▅▆▇█▇▆▅▄▃ ║ ╎ ┄┄┄┄ ╌╌╌╌ ┈┈┈ ╎');
  lines.push(label('') + '└───────────────┘ ╚═══════════════╝ ╰───────────────╯');
  lines.push('');

  lines.push(
    label('powerline')
    + `${ESC}30;44m ~/dormouse ${ESC}34;42m${ESC}30m canopy ${ESC}32;49m${RESET}`
    + `     ${ESC}30;46m sdf ${RESET}`,
  );
  lines.push(label('wide/CJK') + '你好, 世界 — こんにちは ｶﾀｶﾅ');
  lines.push(label('emoji') + '🦎 🌲 🍄 ✨ 🚀');
  lines.push('');
  lines.push(`${ESC}90m$ ${RESET}echo "rendered by WebGL2"`);

  return lines.join('\r\n');
}

interface GlTerminalProps {
  content: string;
  /** Also mount the addon's live glyph texture atlas below the terminal. */
  showAtlas?: boolean;
}

function GlTerminal({ content, showAtlas = false }: GlTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const atlasRef = useRef<HTMLDivElement>(null);
  const [glError, setGlError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cols: 100,
      rows: 24,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "DejaVu Sans Mono", monospace',
      cursorBlink: false,
      theme: { background: '#16161e', foreground: '#c8d0e0' },
    });
    term.open(host);

    const disposables: { dispose(): void }[] = [];
    const atlasHost = atlasRef.current;
    try {
      const addon = new WebglAddon();
      if (atlasHost) {
        const styleAtlasCanvas = (canvas: HTMLCanvasElement) => {
          canvas.style.maxWidth = '100%';
          canvas.style.border = '1px solid #444';
          canvas.style.imageRendering = 'pixelated';
          canvas.style.background =
            'repeating-conic-gradient(#2a2a32 0% 25%, #383842 0% 50%) 50% / 16px 16px';
        };
        const appendAtlasCanvas = (canvas: HTMLCanvasElement) => {
          if (atlasHost.contains(canvas)) return;
          styleAtlasCanvas(canvas);
          atlasHost.appendChild(canvas);
        };
        // Subscribe before the first frame so every atlas page is caught as
        // it is created; the raf fallback picks up page 0 if it already exists.
        disposables.push(addon.onAddTextureAtlasCanvas(appendAtlasCanvas));
        disposables.push(addon.onChangeTextureAtlas((canvas) => {
          atlasHost.replaceChildren();
          appendAtlasCanvas(canvas);
        }));
        const raf = requestAnimationFrame(() => {
          if (addon.textureAtlas) appendAtlasCanvas(addon.textureAtlas);
        });
        disposables.push({ dispose: () => cancelAnimationFrame(raf) });
      }
      disposables.push(addon.onContextLoss(() => setGlError('WebGL context lost')));
      term.loadAddon(addon); // after open(): the renderer needs the DOM host
    } catch (error) {
      setGlError(String(error));
    }
    term.write(content);

    return () => {
      for (const d of disposables) d.dispose();
      term.dispose(); // also disposes loaded addons
      atlasHost?.replaceChildren();
      setGlError(null);
    };
  }, [content, showAtlas]);

  return (
    <div style={{ minHeight: '100vh', background: '#101014', padding: 16, color: '#c8d0e0', fontFamily: 'monospace' }}>
      {glError ? (
        <div style={{ marginBottom: 12, padding: 8, border: '1px solid #a33', color: '#f88' }}>
          WebGL unavailable: {glError}
        </div>
      ) : null}
      <div ref={hostRef} />
      {showAtlas ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 8, fontSize: 12, color: '#888' }}>
            glyph texture atlas (live) — this is what the SDF conversion replaces
          </div>
          <div ref={atlasRef} />
        </div>
      ) : null}
    </div>
  );
}

const meta: Meta<typeof GlTerminal> = {
  title: 'Canopy/GlTerminal',
  component: GlTerminal,
};

export default meta;
type Story = StoryObj<typeof GlTerminal>;

export const ColorsAndGlyphs: Story = {
  args: { content: demoContent() },
};

export const TextureAtlas: Story = {
  args: { content: demoContent(), showAtlas: true },
};
