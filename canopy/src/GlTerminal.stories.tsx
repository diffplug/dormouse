import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@diffplug/xterm-addon-webgl-sdf';
// The pristine upstream addon, pinned to the exact commit the fork's sdf branch is based on
// (addon 0.20.0-beta.287 and core 6.1.0-beta.288 share gitHead 8aab3103) — the regression
// baseline for the RendererComparison story.
import { WebglAddon as UpstreamWebglAddon } from '@xterm/addon-webgl';
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

/**
 * Regression-discriminating rows owned by the RendererComparison harness (not part of
 * demoContent, so demo-content tidy-ups cannot silently weaken the harness): solid chevrons at
 * every bg boundary in both directions plus the thin variants — the "background-colored glyph"
 * cases.
 */
function chevronGauntlet(): string {
  return label('chevrons')
    + `${ESC}37;41m red ${ESC}31;44m\ue0b0${ESC}37m blue ${ESC}34;42m\ue0b0${ESC}30m green ${ESC}32;49m\ue0b0${RESET}`
    + `  ${ESC}36m\ue0b2${ESC}30;46m cyan ${ESC}36;45m\ue0b2${ESC}37m magenta ${ESC}35m\ue0b1\ue0b1 \ue0b3\ue0b3${RESET}`;
}

/** Compact content for the side-by-side scale comparison. */
function compactContent(): string {
  const lines: string[] = [];
  lines.push('The quick brown fox jumps over');
  lines.push('the lazy dog. 0123456789 iIlL1 oO0');
  lines.push(`${ESC}33m-> => != >= <= |> || :: ${ESC}35m@#%&${RESET}`);
  lines.push(`${ESC}32mgreen ${ESC}31mred ${ESC}34mblue ${ESC}1mbold${RESET} ${ESC}3mitalic${RESET}`);
  lines.push('你好世界 — mixed width');
  return lines.join('\r\n');
}

type RendererKind = 'upstream' | 'fork-raster' | 'fork-sdf';

interface GlTerminalProps {
  content: string;
  /** Also mount the addon's live glyph texture atlas below the terminal. */
  showAtlas?: boolean;
  /** Which webgl addon renders the terminal: pristine upstream, or the fork with sdf off/on. */
  renderer?: RendererKind;
  /** Base font px for SDF rasterization; undefined = the addon's default (32). */
  sdfGlyphSize?: number;
  fontSize?: number;
  cols?: number;
  rows?: number;
}

function GlTerminal({ content, showAtlas = false, renderer = 'fork-raster', sdfGlyphSize, fontSize = 14, cols = 100, rows = 24 }: GlTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const atlasRef = useRef<HTMLDivElement>(null);
  const [glError, setGlError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cols,
      rows,
      fontSize,
      fontFamily: 'Menlo, Monaco, "DejaVu Sans Mono", monospace',
      cursorBlink: false,
      theme: { background: '#16161e', foreground: '#c8d0e0' },
    });
    term.open(host);

    const disposables: { dispose(): void }[] = [];
    const atlasHost = atlasRef.current;
    try {
      const addon = renderer === 'upstream'
        ? new UpstreamWebglAddon()
        : new WebglAddon({ sdf: renderer === 'fork-sdf', sdfGlyphSize });
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
  }, [content, showAtlas, renderer, sdfGlyphSize, fontSize, cols, rows]);

  return (
    <div>
      {glError ? (
        <div style={{ marginBottom: 12, padding: 8, border: '1px solid #a33', color: '#f88' }}>
          WebGL unavailable: {glError}
        </div>
      ) : null}
      <div ref={hostRef} />
      {showAtlas ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 8, fontSize: 12, color: '#888' }}>
            glyph texture atlas (live){renderer === 'fork-sdf' ? ' — white shapes are distance fields, tinted in the shader' : ' — this is what the SDF conversion replaces'}
          </div>
          <div ref={atlasRef} />
        </div>
      ) : null}
    </div>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#101014', padding: 16, color: '#c8d0e0', fontFamily: 'monospace' }}>
      {children}
    </div>
  );
}

function PageStory(props: GlTerminalProps) {
  return (
    <Page>
      <GlTerminal {...props} />
    </Page>
  );
}

/**
 * The apples-to-apples VR scenario: both sides start from the same BASE-px glyph source,
 * displayed SCALE times larger. The raster side can only bitmap-upscale (blurry); the SDF side
 * reconstructs crisp edges in the shader from a distance-field atlas of the same base size.
 */
function ScaleComparison() {
  const SCALE = 3;
  const BASE = 32;
  const COLS = 36;
  const ROWS = 6;
  const content = compactContent();
  // Rough footprint of the raster terminal at fontSize BASE, for the scaled wrapper
  const termW = Math.round(BASE * 0.62 * COLS);
  const termH = Math.round(BASE * 1.29 * ROWS);
  return (
    <Page>
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ marginBottom: 8, fontSize: 13, color: '#f0a0a0' }}>
            raster atlas @ {BASE}px, bitmap-upscaled ×{SCALE}
          </div>
          <div style={{ width: termW * SCALE, height: termH * SCALE, overflow: 'hidden' }}>
            <div style={{ transform: `scale(${SCALE})`, transformOrigin: 'top left' }}>
              <GlTerminal content={content} fontSize={BASE} cols={COLS} rows={ROWS} />
            </div>
          </div>
        </div>
        <div>
          <div style={{ marginBottom: 8, fontSize: 13, color: '#a0f0a0' }}>
            SDF atlas @ {BASE}px, shader-rendered @ {BASE * SCALE}px
          </div>
          <GlTerminal content={content} renderer="fork-sdf" sdfGlyphSize={BASE} fontSize={BASE * SCALE} cols={COLS} rows={ROWS} />
        </div>
      </div>
    </Page>
  );
}

const meta: Meta<typeof PageStory> = {
  title: 'Canopy/GlTerminal',
  component: PageStory,
};

export default meta;
type Story = StoryObj<typeof PageStory>;

export const ColorsAndGlyphs: Story = {
  args: { content: demoContent() },
};

export const TextureAtlas: Story = {
  args: { content: demoContent(), showAtlas: true },
};

export const Sdf: Story = {
  args: { content: demoContent(), renderer: 'fork-sdf' },
};

export const SdfTextureAtlas: Story = {
  args: { content: demoContent(), renderer: 'fork-sdf', showAtlas: true },
};

export const SdfVsRasterAt3x: StoryObj = {
  render: () => <ScaleComparison />,
};

const RENDERER_LABELS: Record<RendererKind, string> = {
  'upstream': 'upstream @xterm/addon-webgl 0.20.0-beta.287 — same commit as the fork base (regression baseline)',
  'fork-raster': 'fork, sdf: false — isolates the instance-layout/shader changes',
  'fork-sdf': 'fork, sdf: true — isolates the SDF glyph path',
};

/**
 * The same content through all three renderers, stacked for regression comparison. The harness
 * owns its discriminating rows (chevronGauntlet) so demo-content edits cannot weaken it.
 */
function RendererComparison() {
  const content = demoContent() + '\r\n' + chevronGauntlet();
  return (
    <Page>
      {(Object.keys(RENDERER_LABELS) as RendererKind[]).map((kind) => (
        <div key={kind} style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 6, fontSize: 12, color: '#8ab4f8' }}>{RENDERER_LABELS[kind]}</div>
          <GlTerminal content={content} renderer={kind} rows={22} />
        </div>
      ))}
    </Page>
  );
}

export const UpstreamVsFork: StoryObj = {
  render: () => <RendererComparison />,
};
