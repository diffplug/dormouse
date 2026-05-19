/*
 * Browser adapter for ascii-splash@0.3.0 in the Dormouse website playground.
 *
 * This file is not the upstream CLI entrypoint. It imports upstream internals
 * from ascii-splash/dist through the website's `ascii-splash-internal` Vite
 * alias, then replaces the Node terminal-kit boundary with a FakePtyAdapter
 * runner that speaks xterm byte streams.
 *
 * Upstream pieces kept: AnimationEngine, Buffer, CommandBuffer, CommandParser,
 * CommandExecutor, themes, defaults, UI overlay classes, TransitionManager, and
 * all pattern classes.
 *
 * Local changes/wrapping:
 * - BrowserTerminalRenderer writes ANSI output through FakePtyAdapter.sendOutput.
 * - Keyboard bytes and SGR mouse sequences are decoded from writePty input.
 * - Alt-screen, cursor, mouse-reporting, resize, start, and cleanup lifecycle
 *   are handled for xterm.js inside Dormouse.
 * - UI overlays/transitions are instantiated per runner instead of using
 *   upstream singleton getters so multiple panes can run independently.
 * - Config persistence is intentionally omitted; upstream commands that need a
 *   config loader report that it is unavailable.
 */
import { AnimationEngine } from "ascii-splash-internal/engine/AnimationEngine.js";
import { CommandBuffer } from "ascii-splash-internal/engine/CommandBuffer.js";
import { CommandExecutor } from "ascii-splash-internal/engine/CommandExecutor.js";
import { CommandParser } from "ascii-splash-internal/engine/CommandParser.js";
import { defaultConfig, qualityPresets } from "ascii-splash-internal/config/defaults.js";
import { getNextThemeName, getTheme, THEME_NAMES, THEMES } from "ascii-splash-internal/config/themes.js";
import { TransitionManager } from "ascii-splash-internal/renderer/TransitionManager.js";
import { Buffer as SplashBuffer } from "ascii-splash-internal/renderer/Buffer.js";
import { HelpOverlay } from "ascii-splash-internal/ui/HelpOverlay.js";
import { StatusBar } from "ascii-splash-internal/ui/StatusBar.js";
import { ToastManager } from "ascii-splash-internal/ui/ToastManager.js";
import { AquariumPattern } from "ascii-splash-internal/patterns/AquariumPattern.js";
import { CampfirePattern } from "ascii-splash-internal/patterns/CampfirePattern.js";
import { DNAPattern } from "ascii-splash-internal/patterns/DNAPattern.js";
import { FireworksPattern } from "ascii-splash-internal/patterns/FireworksPattern.js";
import { LavaLampPattern } from "ascii-splash-internal/patterns/LavaLampPattern.js";
import { LifePattern } from "ascii-splash-internal/patterns/LifePattern.js";
import { LightningPattern } from "ascii-splash-internal/patterns/LightningPattern.js";
import { MatrixPattern } from "ascii-splash-internal/patterns/MatrixPattern.js";
import { MazePattern } from "ascii-splash-internal/patterns/MazePattern.js";
import { MetaballPattern } from "ascii-splash-internal/patterns/MetaballPattern.js";
import { NightSkyPattern } from "ascii-splash-internal/patterns/NightSkyPattern.js";
import { OceanBeachPattern } from "ascii-splash-internal/patterns/OceanBeachPattern.js";
import { ParticlePattern } from "ascii-splash-internal/patterns/ParticlePattern.js";
import { PlasmaPattern } from "ascii-splash-internal/patterns/PlasmaPattern.js";
import { QuicksilverPattern } from "ascii-splash-internal/patterns/QuicksilverPattern.js";
import { RainPattern } from "ascii-splash-internal/patterns/RainPattern.js";
import { SmokePattern } from "ascii-splash-internal/patterns/SmokePattern.js";
import { SnowfallParkPattern } from "ascii-splash-internal/patterns/SnowfallParkPattern.js";
import { SnowPattern } from "ascii-splash-internal/patterns/SnowPattern.js";
import { SpiralPattern } from "ascii-splash-internal/patterns/SpiralPattern.js";
import { StarfieldPattern } from "ascii-splash-internal/patterns/StarfieldPattern.js";
import { TunnelPattern } from "ascii-splash-internal/patterns/TunnelPattern.js";
import { WavePattern } from "ascii-splash-internal/patterns/WavePattern.js";
import type { Cell, Color, Pattern, Point, Size, Theme } from "ascii-splash-internal/types/index.js";
import {
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
} from "dormouse-lib/lib/ansi";
import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import type { InteractiveProgram } from "./tutorial-shell";

type QualityPreset = "low" | "medium" | "high";

interface AsciiSplashRunnerOptions {
  adapter: FakePtyAdapter;
  terminalId: string;
  args: string[];
  onExit: () => void;
}

interface ParsedOptions {
  pattern?: string;
  quality: QualityPreset;
  fps?: number;
  theme: string;
  mouseEnabled: boolean;
  help?: boolean;
  version?: boolean;
  error?: string;
}

interface SplashConfig {
  defaultPattern?: string;
  quality?: QualityPreset;
  fps?: number;
  theme?: string;
  mouseEnabled?: boolean;
  patterns?: typeof defaultConfig.patterns;
}

interface KeyInput {
  name: string;
  data: { isCharacter: boolean; codepoint?: number };
}

const VERSION = "0.3.0";

const PATTERN_NAMES = [
  "waves",
  "starfield",
  "matrix",
  "rain",
  "quicksilver",
  "particles",
  "spiral",
  "plasma",
  "tunnel",
  "lightning",
  "fireworks",
  "maze",
  "life",
  "dna",
  "lavalamp",
  "smoke",
  "snow",
  "oceanbeach",
  "campfire",
  "nightsky",
  "aquarium",
  "snowfallpark",
  "metaball",
] as const;

const PATTERN_DISPLAY_NAMES: Record<string, string> = {
  waves: "Waves",
  starfield: "Starfield",
  matrix: "Matrix",
  rain: "Rain",
  quicksilver: "Quicksilver",
  particles: "Particles",
  spiral: "Spiral",
  plasma: "Plasma",
  tunnel: "Tunnel",
  lightning: "Lightning",
  fireworks: "Fireworks",
  maze: "Maze",
  life: "Life",
  dna: "DNA",
  lavalamp: "Lava Lamp",
  smoke: "Smoke",
  snow: "Snow",
  oceanbeach: "Ocean Beach",
  campfire: "Campfire",
  nightsky: "Night Sky",
  aquarium: "Aquarium",
  snowfallpark: "Snowfall Park",
  metaball: "Metaball",
};

const ARROW_KEY_NAMES: Record<string, string> = { A: "UP", B: "DOWN", C: "RIGHT", D: "LEFT" };

const OCEANBEACH_PATTERN_INDEX = PATTERN_NAMES.indexOf("oceanbeach");
const PRESET_COUNT = 6;
const PATTERN_BUFFER_TIMEOUT_MS = 5000;
const PATTERN_SWITCH_GUARD_MS = 16;

const HELP_TEXT = [
  "Usage: ascii-splash [options]",
  "",
  "Options:",
  "  -p, --pattern <name>   Starting pattern",
  "  -q, --quality <preset> Quality preset: low, medium, high",
  "  -f, --fps <number>     Custom FPS from 10 to 60",
  "  -t, --theme <name>     Theme: ocean, matrix, starlight, fire, monochrome",
  "      --no-mouse         Disable mouse interaction",
  "  -h, --help             Show help",
  "  -V, --version          Show version",
].join("\r\n");

function color(code: number): Color {
  return { r: code, g: code, b: code };
}

function normalizeSize(size: Size): Size {
  return {
    width: Math.max(1, Math.floor(size.width)),
    height: Math.max(2, Math.floor(size.height)),
  };
}

function parseOptionValue(args: string[], index: number, raw: string): { value?: string; nextIndex: number; error?: string } {
  const eq = raw.indexOf("=");
  if (eq >= 0) return { value: raw.slice(eq + 1), nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    return { nextIndex: index, error: `Missing value for ${raw}` };
  }
  return { value, nextIndex: index + 1 };
}

function parseArgs(args: string[]): ParsedOptions {
  const parsed: ParsedOptions = {
    quality: "medium",
    theme: "ocean",
    mouseEnabled: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-V") {
      parsed.version = true;
    } else if (arg === "--no-mouse") {
      parsed.mouseEnabled = false;
    } else if (arg === "--pattern" || arg === "-p" || arg.startsWith("--pattern=")) {
      const result = parseOptionValue(args, i, arg);
      if (result.error) return { ...parsed, error: result.error };
      i = result.nextIndex;
      parsed.pattern = result.value?.toLowerCase();
    } else if (arg === "--quality" || arg === "-q" || arg.startsWith("--quality=")) {
      const result = parseOptionValue(args, i, arg);
      if (result.error) return { ...parsed, error: result.error };
      i = result.nextIndex;
      parsed.quality = result.value?.toLowerCase() as QualityPreset;
    } else if (arg === "--fps" || arg === "-f" || arg.startsWith("--fps=")) {
      const result = parseOptionValue(args, i, arg);
      if (result.error) return { ...parsed, error: result.error };
      i = result.nextIndex;
      parsed.fps = Number(result.value);
    } else if (arg === "--theme" || arg === "-t" || arg.startsWith("--theme=")) {
      const result = parseOptionValue(args, i, arg);
      if (result.error) return { ...parsed, error: result.error };
      i = result.nextIndex;
      parsed.theme = result.value?.toLowerCase() ?? parsed.theme;
    } else {
      return { ...parsed, error: `Unknown option: ${arg}` };
    }
  }

  if (parsed.pattern && !PATTERN_NAMES.includes(parsed.pattern as (typeof PATTERN_NAMES)[number])) {
    return { ...parsed, error: `Invalid pattern: ${parsed.pattern}` };
  }
  if (!["low", "medium", "high"].includes(parsed.quality)) {
    return { ...parsed, error: `Invalid quality: ${parsed.quality}` };
  }
  if (parsed.fps !== undefined && (!Number.isFinite(parsed.fps) || parsed.fps < 10 || parsed.fps > 60)) {
    return { ...parsed, error: `FPS must be a number between 10 and 60` };
  }
  if (!THEME_NAMES.includes(parsed.theme)) {
    return { ...parsed, error: `Invalid theme: ${parsed.theme}` };
  }
  return parsed;
}

function createPatternsFromConfig(config: SplashConfig, theme: Theme): Pattern[] {
  return [
    new WavePattern(theme, {
      layers: config.patterns?.waves?.layers,
      amplitude: config.patterns?.waves?.amplitude,
      speed: config.patterns?.waves?.speed,
      frequency: config.patterns?.waves?.frequency,
    }),
    new StarfieldPattern(theme, {
      starCount: config.patterns?.starfield?.starCount,
      speed: config.patterns?.starfield?.speed,
    }),
    new MatrixPattern(theme, {
      density: config.patterns?.matrix?.columnDensity,
      speed: config.patterns?.matrix?.speed,
    }),
    new RainPattern(theme, {
      density: config.patterns?.rain?.dropCount ? config.patterns.rain.dropCount / 500 : undefined,
      speed: config.patterns?.rain?.speed,
    }),
    new QuicksilverPattern(theme, {
      speed: config.patterns?.quicksilver?.speed,
      flowIntensity: config.patterns?.quicksilver?.viscosity,
      noiseScale: 0.05,
    }),
    new ParticlePattern(theme, {
      particleCount: config.patterns?.particles?.particleCount,
      speed: config.patterns?.particles?.speed,
      gravity: config.patterns?.particles?.gravity,
      mouseForce: config.patterns?.particles?.mouseForce,
      spawnRate: config.patterns?.particles?.spawnRate,
    }),
    new SpiralPattern(theme, {
      armCount: config.patterns?.spiral?.armCount,
      particleCount: config.patterns?.spiral?.particleCount,
      spiralTightness: config.patterns?.spiral?.spiralTightness,
      rotationSpeed: config.patterns?.spiral?.rotationSpeed,
      particleSpeed: config.patterns?.spiral?.particleSpeed,
      trailLength: config.patterns?.spiral?.trailLength,
      direction: config.patterns?.spiral?.direction,
      pulseEffect: config.patterns?.spiral?.pulseEffect,
    }),
    new PlasmaPattern(theme, {
      frequency: config.patterns?.plasma?.frequency,
      speed: config.patterns?.plasma?.speed,
      complexity: config.patterns?.plasma?.complexity,
    }),
    new TunnelPattern(theme, {
      shape: config.patterns?.tunnel?.shape,
      ringCount: config.patterns?.tunnel?.ringCount,
      speed: config.patterns?.tunnel?.speed,
      particleCount: config.patterns?.tunnel?.particleCount,
      speedLineCount: config.patterns?.tunnel?.speedLineCount,
      turbulence: config.patterns?.tunnel?.turbulence,
      glowIntensity: config.patterns?.tunnel?.glowIntensity,
      chromatic: config.patterns?.tunnel?.chromatic,
      rotationSpeed: config.patterns?.tunnel?.rotationSpeed,
      radius: config.patterns?.tunnel?.radius,
    }),
    new LightningPattern(theme, {
      branchProbability: config.patterns?.lightning?.branchProbability,
      fadeTime: config.patterns?.lightning?.fadeTime,
      strikeInterval: config.patterns?.lightning?.strikeInterval,
      mainPathJaggedness: config.patterns?.lightning?.mainPathJaggedness,
      branchSpread: config.patterns?.lightning?.branchSpread,
    }),
    new FireworksPattern(theme, {
      burstSize: config.patterns?.fireworks?.burstSize,
      launchSpeed: config.patterns?.fireworks?.launchSpeed,
      gravity: config.patterns?.fireworks?.gravity,
      fadeRate: config.patterns?.fireworks?.fadeRate,
      spawnInterval: config.patterns?.fireworks?.spawnInterval,
      trailLength: config.patterns?.fireworks?.trailLength,
    }),
    new MazePattern(theme, {
      algorithm: config.patterns?.maze?.algorithm,
      cellSize: config.patterns?.maze?.cellSize,
      generationSpeed: config.patterns?.maze?.generationSpeed,
      wallChar: config.patterns?.maze?.wallChar,
      pathChar: config.patterns?.maze?.pathChar,
      animateGeneration: config.patterns?.maze?.animateGeneration,
    }),
    new LifePattern(theme, {
      cellSize: config.patterns?.life?.cellSize,
      updateSpeed: config.patterns?.life?.updateSpeed,
      wrapEdges: config.patterns?.life?.wrapEdges,
      aliveChar: config.patterns?.life?.aliveChar,
      deadChar: config.patterns?.life?.deadChar,
      randomDensity: config.patterns?.life?.randomDensity,
      initialPattern: config.patterns?.life?.initialPattern,
    }),
    new DNAPattern(theme, {
      rotationSpeed: config.patterns?.dna?.rotationSpeed,
      helixRadius: config.patterns?.dna?.helixRadius,
      basePairDensity: config.patterns?.dna?.basePairSpacing ? 1 / config.patterns.dna.basePairSpacing : undefined,
      twistRate: config.patterns?.dna?.twistRate,
      showLabels: true,
    }),
    new LavaLampPattern(theme, {
      blobCount: config.patterns?.lavaLamp?.blobCount,
      minRadius: config.patterns?.lavaLamp?.minRadius,
      maxRadius: config.patterns?.lavaLamp?.maxRadius,
      riseSpeed: config.patterns?.lavaLamp?.riseSpeed,
      driftSpeed: config.patterns?.lavaLamp?.driftSpeed,
      threshold: config.patterns?.lavaLamp?.threshold,
      mouseForce: config.patterns?.lavaLamp?.mouseForce,
      turbulence: config.patterns?.lavaLamp?.turbulence,
      gravity: config.patterns?.lavaLamp?.gravity,
    }),
    new SmokePattern(theme, {
      plumeCount: config.patterns?.smoke?.plumeCount,
      particleCount: config.patterns?.smoke?.particleCount,
      riseSpeed: config.patterns?.smoke?.riseSpeed,
      dissipationRate: config.patterns?.smoke?.dissipationRate,
      turbulence: config.patterns?.smoke?.turbulence,
      spread: config.patterns?.smoke?.spread,
      windStrength: config.patterns?.smoke?.windStrength,
      mouseBlowForce: config.patterns?.smoke?.mouseBlowForce,
    }),
    new SnowPattern(theme, {
      particleCount: config.patterns?.snow?.particleCount,
      fallSpeed: config.patterns?.snow?.fallSpeed,
      windStrength: config.patterns?.snow?.windStrength,
      turbulence: config.patterns?.snow?.turbulence,
      rotationSpeed: config.patterns?.snow?.rotationSpeed,
      particleType: config.patterns?.snow?.particleType,
      accumulation: config.patterns?.snow?.accumulation,
      mouseWindForce: config.patterns?.snow?.mouseWindForce,
    }),
    new OceanBeachPattern(theme, {}),
    new CampfirePattern(theme, {}),
    new NightSkyPattern(theme, {}),
    new AquariumPattern(theme, {}),
    new SnowfallParkPattern(theme, {}),
    new MetaballPattern(theme, {}),
  ];
}

function setCell(buffer: Cell[][], x: number, y: number, char: string, colorValue: Color): void {
  if (y >= 0 && y < buffer.length && x >= 0 && x < buffer[y].length) {
    buffer[y][x] = { char, color: colorValue };
  }
}

function drawText(buffer: Cell[][], x: number, y: number, text: string, colorValue: Color): void {
  for (let i = 0; i < text.length; i++) {
    setCell(buffer, x + i, y, text[i], colorValue);
  }
}

function clearRow(buffer: Cell[][], y: number, bg = color(20)): void {
  if (y < 0 || y >= buffer.length) return;
  for (let x = 0; x < buffer[y].length; x++) {
    buffer[y][x] = { char: " ", color: bg };
  }
}

class BrowserTerminalRenderer {
  private buffer: SplashBuffer;
  private size: Size;
  private adapter: FakePtyAdapter;
  private terminalId: string;
  private mouseEnabled: boolean;
  private unsubscribeResize: (() => void) | null = null;

  constructor(options: { adapter: FakePtyAdapter; terminalId: string; mouseEnabled: boolean }) {
    this.adapter = options.adapter;
    this.terminalId = options.terminalId;
    this.mouseEnabled = options.mouseEnabled;
    const initialSize = this.adapter.getPtySize(this.terminalId);
    this.size = normalizeSize({ width: initialSize.cols, height: initialSize.rows });
    this.buffer = new SplashBuffer(this.size);
  }

  start(): void {
    this.write(ENTER_ALT_SCREEN);
    if (this.mouseEnabled) this.write(MOUSE_ENABLE);
    this.unsubscribeResize = this.adapter.onPtyResize((detail) => {
      if (detail.id !== this.terminalId) return;
      this.handleResize(detail.cols, detail.rows);
    });
  }

  handleResize(width: number, height: number): void {
    this.size = normalizeSize({ width, height });
    this.buffer.resize(this.size);
    this.write("\x1b[2J\x1b[H");
  }

  getSize(): Size {
    return this.size;
  }

  getBuffer(): SplashBuffer {
    return this.buffer;
  }

  clear(): void {
    this.buffer.clear();
  }

  clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
    this.buffer.clear();
    this.buffer.clearAllOverlays();
    this.buffer.swap();
  }

  render(): number {
    const changes = this.buffer.getChanges();
    if (changes.length === 0) {
      this.buffer.swap();
      return 0;
    }

    let output = "";
    for (const change of changes) {
      output += `\x1b[${change.y + 1};${change.x + 1}H`;
      if (change.cell.color) {
        const r = Math.max(0, Math.min(255, change.cell.color.r));
        const g = Math.max(0, Math.min(255, change.cell.color.g));
        const b = Math.max(0, Math.min(255, change.cell.color.b));
        output += `\x1b[38;2;${r};${g};${b}m`;
      } else {
        output += "\x1b[39m";
      }
      output += change.cell.char;
    }
    output += "\x1b[0m";
    this.write(output);
    this.buffer.swap();
    return changes.length;
  }

  cleanup(): void {
    this.unsubscribeResize?.();
    this.unsubscribeResize = null;
    if (this.mouseEnabled) this.write(MOUSE_DISABLE);
    this.write(LEAVE_ALT_SCREEN);
  }

  private write(data: string): void {
    this.adapter.sendOutput(this.terminalId, data);
  }
}

export class AsciiSplashRunner implements InteractiveProgram {
  private adapter: FakePtyAdapter;
  private terminalId: string;
  private args: string[];
  private onExit: () => void;
  private renderer: BrowserTerminalRenderer | null = null;
  private engine: AnimationEngine | null = null;
  private commandExecutor: CommandExecutor | null = null;
  private commandBuffer = new CommandBuffer();
  private commandParser = new CommandParser();
  private helpOverlay = new HelpOverlay();
  private statusBar = new StatusBar();
  private toastManager = new ToastManager();
  private transitionManager = new TransitionManager();
  private patterns: Pattern[] = [];
  private currentPatternIndex = 0;
  private currentPresetIndex = 1;
  private currentThemeIndex = 0;
  private currentTheme: Theme = getTheme("ocean");
  private patternBuffer = "";
  private patternBufferActive = false;
  private patternBufferTimeout: ReturnType<typeof setTimeout> | null = null;
  private debugMode = false;
  private isPatternSwitching = false;
  private disposed = false;
  private config: SplashConfig = defaultConfig;

  constructor(options: AsciiSplashRunnerOptions) {
    this.adapter = options.adapter;
    this.terminalId = options.terminalId;
    this.args = options.args;
    this.onExit = options.onExit;
  }

  start(): void {
    const parsed = parseArgs(this.args);
    if (parsed.error) {
      this.adapter.sendOutput(this.terminalId, `ascii-splash: ${parsed.error}\r\n${HELP_TEXT}\r\n`);
      this.finishSoon();
      return;
    }
    if (parsed.help) {
      this.adapter.sendOutput(this.terminalId, `${HELP_TEXT}\r\n`);
      this.finishSoon();
      return;
    }
    if (parsed.version) {
      this.adapter.sendOutput(this.terminalId, `${VERSION}\r\n`);
      this.finishSoon();
      return;
    }

    this.config = {
      ...defaultConfig,
      defaultPattern: parsed.pattern ?? defaultConfig.defaultPattern,
      quality: parsed.quality,
      fps: parsed.fps,
      theme: parsed.theme,
      mouseEnabled: parsed.mouseEnabled,
      patterns: defaultConfig.patterns,
    };
    this.currentTheme = getTheme(parsed.theme);
    this.currentThemeIndex = THEME_NAMES.indexOf(this.currentTheme.name);
    this.patterns = createPatternsFromConfig(this.config, this.currentTheme);
    this.currentPatternIndex = Math.max(0, PATTERN_NAMES.indexOf((this.config.defaultPattern ?? "waves") as (typeof PATTERN_NAMES)[number]));

    this.renderer = new BrowserTerminalRenderer({
      adapter: this.adapter,
      terminalId: this.terminalId,
      mouseEnabled: parsed.mouseEnabled,
    });
    this.renderer.start();

    const initialFps = parsed.fps ?? qualityPresets[parsed.quality];
    this.engine = new AnimationEngine(this.renderer, this.patterns[this.currentPatternIndex], initialFps);
    this.commandExecutor = new CommandExecutor(
      this.engine,
      this.patterns,
      Object.values(THEMES),
      this.currentPatternIndex,
      this.currentThemeIndex,
      undefined,
    );

    this.commandExecutor.setThemeChangeCallback((themeIndex: number) => {
      const themeName = THEME_NAMES[themeIndex] ?? "ocean";
      this.currentTheme = getTheme(themeName);
      this.currentThemeIndex = themeIndex;
      this.syncCurrentPatternIndexFromEngine();
      this.rebuildPatterns();
      const nextPattern = this.patterns[this.currentPatternIndex] ?? this.patterns[0];
      this.engine?.setPattern(nextPattern);
      this.commandExecutor?.updateState(this.currentPatternIndex, this.currentThemeIndex);
      this.statusBar.update({ themeName: this.currentTheme.displayName });
    });

    this.statusBar.update({
      patternName: this.getCurrentPatternDisplayName(),
      presetNumber: this.currentPresetIndex,
      themeName: this.currentTheme.displayName,
      fps: initialFps,
      shuffleMode: "off",
      paused: false,
    });
    this.transitionManager.setDefaultConfig({ type: "crossfade", duration: 300 });

    this.engine.setBeforeTerminalRenderCallback(() => this.renderBufferOverlays());
    this.toastManager.info("ascii-splash - Press ? for help | q to quit", 1500);
    this.engine.start();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    let index = 0;
    while (index < data.length) {
      if (data[index] === "\x1b" && data[index + 1] === "[") {
        const remaining = data.slice(index);
        const mouse = remaining.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (mouse) {
          this.handleMouse(Number(mouse[1]), Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4]);
          index += mouse[0].length;
          continue;
        }
        const arrow = remaining.match(/^\x1b\[([ABCD])/);
        if (arrow) {
          this.handleKey({ name: ARROW_KEY_NAMES[arrow[1]], data: { isCharacter: false } });
          index += arrow[0].length;
          continue;
        }
      }

      this.handleKey(decodeKey(data[index]));
      index++;
    }
  }

  dispose(): void {
    this.cleanup(false);
  }

  private handleKey(input: KeyInput): void {
    const { helpOverlay, statusBar, toastManager } = this;

    if (helpOverlay.isVisible()) {
      if (input.name === "ESCAPE" || input.name === "?") {
        helpOverlay.hide();
      } else if (input.name === "TAB" || input.name === "RIGHT") {
        helpOverlay.nextTab();
      } else if (input.name === "LEFT") {
        helpOverlay.prevTab();
      }
      return;
    }

    if (this.commandBuffer.isActive()) {
      if (input.name === "ESCAPE") {
        this.commandBuffer.cancel();
      } else if (input.name === "ENTER") {
        const cmdString = this.commandBuffer.execute();
        if (cmdString) {
          const parsed = this.commandParser.parse(cmdString);
          const result = parsed && this.commandExecutor
            ? this.commandExecutor.execute(parsed)
            : { success: false, message: "Invalid command" };
          this.showCommandResult(result.message, result.success);
          this.syncStateFromEngine();
        }
      } else if (input.name === "BACKSPACE") {
        this.commandBuffer.backspace();
      } else if (input.name === "UP") {
        this.commandBuffer.previousCommand();
      } else if (input.name === "DOWN") {
        this.commandBuffer.nextCommand();
      } else if (input.name === "LEFT") {
        this.commandBuffer.moveCursorLeft();
      } else if (input.name === "RIGHT") {
        this.commandBuffer.moveCursorRight();
      } else if (input.data.isCharacter && input.data.codepoint !== undefined) {
        const char = String.fromCodePoint(input.data.codepoint);
        if (/^[nNbB]$/.test(char)) {
          this.commandBuffer.cancel();
        } else {
          this.commandBuffer.addChar(char);
          return;
        }
      }
      return;
    }

    if (this.patternBufferActive) {
      if (input.name === "ESCAPE") {
        this.cancelPatternBuffer();
      } else if (input.name === "ENTER") {
        this.executePatternBuffer();
      } else if (input.name === "BACKSPACE") {
        this.patternBuffer = this.patternBuffer.slice(0, -1);
      } else if (input.data.isCharacter && input.data.codepoint !== undefined) {
        const char = String.fromCodePoint(input.data.codepoint);
        if (/[0-9a-zA-Z.]/.test(char)) {
          this.patternBuffer += char;
          this.resetPatternBufferTimeout();
        }
      }
      return;
    }

    if (input.name === "CTRL_C" || input.name === "q" || input.name === "ESCAPE") {
      this.cleanup(true);
    } else if (input.name === "c") {
      this.commandBuffer.activate();
    } else if (input.name === "SPACE") {
      this.engine?.pause();
      statusBar.update({ paused: this.engine?.isPaused() ?? false });
    } else if (/^[1-9]$/.test(input.name)) {
      this.switchPattern(Number(input.name) - 1);
    } else if (input.name === "o") {
      this.switchPattern(OCEANBEACH_PATTERN_INDEX);
    } else if (input.name === "n") {
      this.switchPattern((this.currentPatternIndex + 1) % this.patterns.length);
    } else if (input.name === "b") {
      this.switchPattern(this.currentPatternIndex === 0 ? this.patterns.length - 1 : this.currentPatternIndex - 1);
    } else if (input.name === "p") {
      this.activatePatternBuffer();
    } else if (input.name === ".") {
      this.cyclePreset(1);
    } else if (input.name === ",") {
      this.cyclePreset(-1);
    } else if (input.name === "+" || input.name === "=") {
      this.setFps(Math.min(60, (this.engine?.getFps() ?? 30) + 5));
    } else if (input.name === "-" || input.name === "_") {
      this.setFps(Math.max(10, (this.engine?.getFps() ?? 30) - 5));
    } else if (input.name === "?") {
      helpOverlay.toggle();
    } else if (input.name === "d") {
      this.debugMode = !this.debugMode;
    } else if (input.name === "t") {
      this.cycleTheme();
    } else if (input.name === "r") {
      const parsed = this.commandParser.parse("0**");
      if (parsed && this.commandExecutor) {
        const result = this.commandExecutor.execute(parsed);
        this.showCommandResult(result.message, result.success);
        this.syncStateFromEngine();
      }
    } else if (input.name === "s") {
      const parsed = this.commandParser.parse("0s");
      if (parsed && this.commandExecutor) {
        const result = this.commandExecutor.execute(parsed);
        this.showCommandResult(result.message, result.success);
      }
    } else if (input.name === "[") {
      if (this.config.quality === "high") this.setQuality("medium");
      else if (this.config.quality === "medium") this.setQuality("low");
    } else if (input.name === "]") {
      if (this.config.quality === "low") this.setQuality("medium");
      else if (this.config.quality === "medium") this.setQuality("high");
    }

    if (toastManager.hasToasts()) {
      statusBar.update({ patternName: this.getCurrentPatternDisplayName() });
    }
  }

  private handleMouse(code: number, x: number, y: number, final: string): void {
    const pattern = this.patterns[this.currentPatternIndex];
    const pos: Point = { x, y };
    const isMotion = (code & 32) === 32;
    const button = code & 3;
    if (final === "M" && isMotion && pattern.onMouseMove) {
      pattern.onMouseMove(pos);
    } else if (final === "M" && button === 0 && pattern.onMouseClick) {
      pattern.onMouseClick(pos);
    }
  }

  private switchPattern(index: number): void {
    if (!this.engine || index < 0 || index >= this.patterns.length || index === this.currentPatternIndex) return;
    this.isPatternSwitching = true;
    const oldPattern = this.patterns[this.currentPatternIndex];
    this.currentPatternIndex = index;
    this.currentPresetIndex = 1;
    const newPattern = this.patterns[this.currentPatternIndex];
    this.transitionManager.start(oldPattern, newPattern, this.renderer?.getSize() ?? { width: 80, height: 30 });
    this.engine.setPattern(newPattern);
    this.commandExecutor?.updateState(this.currentPatternIndex, this.currentThemeIndex);
    this.statusBar.update({
      patternName: this.getCurrentPatternDisplayName(),
      presetNumber: this.currentPresetIndex,
    });
    this.toastManager.info(`Pattern: ${this.getCurrentPatternDisplayName()}`, 2000);
    setTimeout(() => {
      this.isPatternSwitching = false;
    }, PATTERN_SWITCH_GUARD_MS);
  }

  private cyclePreset(direction: 1 | -1): void {
    const currentPattern = this.patterns[this.currentPatternIndex];
    if (!currentPattern.applyPreset) return;
    const nextPreset = direction === 1
      ? (this.currentPresetIndex % PRESET_COUNT) + 1
      : this.currentPresetIndex === 1 ? PRESET_COUNT : this.currentPresetIndex - 1;
    if (!currentPattern.applyPreset(nextPreset)) return;
    this.currentPresetIndex = nextPreset;
    this.statusBar.update({ presetNumber: nextPreset });
    this.toastManager.info(`${this.getCurrentPatternDisplayName()} - Preset ${nextPreset}`, 1500);
  }

  private setFps(fps: number): void {
    this.engine?.setFps(fps);
    this.statusBar.update({ fps });
    this.toastManager.info(`Speed: ${fps} FPS`, 1500);
  }

  private setQuality(quality: QualityPreset): void {
    this.config = { ...this.config, quality };
    this.syncCurrentPatternIndexFromEngine();
    this.rebuildPatterns();
    this.setFps(qualityPresets[quality]);
    this.engine?.setPattern(this.patterns[this.currentPatternIndex]);
    this.commandExecutor?.updateState(this.currentPatternIndex, this.currentThemeIndex);
    this.toastManager.info(`Quality: ${quality.toUpperCase()} (${qualityPresets[quality]} FPS)`, 1500);
  }

  private cycleTheme(): void {
    const nextThemeName = getNextThemeName(this.currentTheme.name);
    this.currentTheme = getTheme(nextThemeName);
    this.currentThemeIndex = THEME_NAMES.indexOf(this.currentTheme.name);
    this.syncCurrentPatternIndexFromEngine();
    this.rebuildPatterns();
    this.engine?.setPattern(this.patterns[this.currentPatternIndex]);
    this.commandExecutor?.updateState(this.currentPatternIndex, this.currentThemeIndex);
    this.statusBar.update({ themeName: this.currentTheme.displayName });
    this.toastManager.info(`Theme: ${this.currentTheme.displayName}`, 1500);
  }

  private activatePatternBuffer(): void {
    this.patternBuffer = "";
    this.patternBufferActive = true;
    this.resetPatternBufferTimeout();
  }

  private cancelPatternBuffer(): void {
    this.patternBufferActive = false;
    this.patternBuffer = "";
    if (this.patternBufferTimeout) {
      clearTimeout(this.patternBufferTimeout);
      this.patternBufferTimeout = null;
    }
  }

  private resetPatternBufferTimeout(): void {
    if (this.patternBufferTimeout) clearTimeout(this.patternBufferTimeout);
    this.patternBufferTimeout = setTimeout(() => {
      this.patternBufferActive = false;
      this.patternBuffer = "";
      this.patternBufferTimeout = null;
    }, PATTERN_BUFFER_TIMEOUT_MS);
  }

  private executePatternBuffer(): void {
    const input = this.patternBuffer.trim();
    this.cancelPatternBuffer();
    if (!input) {
      this.switchPattern(this.currentPatternIndex === 0 ? this.patterns.length - 1 : this.currentPatternIndex - 1);
      return;
    }

    if (input.includes(".")) {
      const [patternPart, presetPart] = input.split(".");
      const patternNum = Number(patternPart);
      const presetNum = Number(presetPart);
      if (Number.isInteger(patternNum) && Number.isInteger(presetNum) && patternNum >= 1 && patternNum <= this.patterns.length) {
        this.switchPattern(patternNum - 1);
        const pattern = this.patterns[patternNum - 1];
        if (pattern.applyPreset?.(presetNum)) {
          this.currentPresetIndex = presetNum;
          this.statusBar.update({ presetNumber: presetNum });
          this.toastManager.info(`${this.getCurrentPatternDisplayName()} - Preset ${presetNum}`, 1500);
        } else {
          this.toastManager.error(`Invalid preset: ${presetNum}`, 1500);
        }
        return;
      }
    }

    const patternNum = Number(input);
    if (Number.isInteger(patternNum) && patternNum >= 1 && patternNum <= this.patterns.length) {
      this.switchPattern(patternNum - 1);
      return;
    }

    const lowerInput = input.toLowerCase();
    const exactIndex = PATTERN_NAMES.indexOf(lowerInput as (typeof PATTERN_NAMES)[number]);
    if (exactIndex >= 0) {
      this.switchPattern(exactIndex);
      return;
    }
    const partialIndex = PATTERN_NAMES.findIndex((name) => name.startsWith(lowerInput));
    if (partialIndex >= 0) {
      this.switchPattern(partialIndex);
      return;
    }
    this.toastManager.error(`Unknown pattern: ${input}`, 1500);
  }

  private showCommandResult(message: string, success: boolean): void {
    const { toastManager } = this;
    if (success) toastManager.success(message);
    else toastManager.error(message);

    const shuffleInfo = this.commandExecutor?.getShuffleInfo() ?? "";
    this.statusBar.update({
      shuffleMode: shuffleInfo ? (shuffleInfo.includes("ALL") ? "all" : "preset") : "off",
    });
  }

  private rebuildPatterns(): void {
    const nextPatterns = createPatternsFromConfig(this.config, this.currentTheme);
    this.patterns.splice(0, this.patterns.length, ...nextPatterns);
    this.currentPatternIndex = Math.min(this.currentPatternIndex, Math.max(0, this.patterns.length - 1));
  }

  private syncCurrentPatternIndexFromEngine(): void {
    const active = this.engine?.getPattern();
    const index = active ? this.patterns.indexOf(active) : -1;
    if (index >= 0) this.currentPatternIndex = index;
  }

  private syncStateFromEngine(): void {
    this.syncCurrentPatternIndexFromEngine();
    this.statusBar.update({
      patternName: this.getCurrentPatternDisplayName(),
      presetNumber: this.currentPresetIndex,
      themeName: this.currentTheme.displayName,
      fps: this.engine?.getFps() ?? qualityPresets[this.config.quality ?? "medium"],
    });
    this.commandExecutor?.updateState(this.currentPatternIndex, this.currentThemeIndex);
  }

  private renderBufferOverlays(): void {
    if (!this.renderer || this.isPatternSwitching) return;
    const size = this.renderer.getSize();
    const buffer = this.renderer.getBuffer();
    const cells = buffer.getBuffer();
    const now = Date.now();

    const { transitionManager } = this;
    if (transitionManager.isActive()) {
      transitionManager.render(cells, now, size);
    }

    const { toastManager } = this;
    if (toastManager.hasToasts()) {
      toastManager.update(now);
      toastManager.render(cells, size);
    }

    const { helpOverlay } = this;
    if (helpOverlay.isVisible()) {
      helpOverlay.render(cells, size);
    }

    if (this.debugMode) {
      this.renderDebugOverlay(cells, size);
    }

    if (this.commandBuffer.isActive()) {
      this.renderCommandOverlay(cells, size);
    } else if (this.patternBufferActive) {
      this.renderPatternOverlay(cells, size);
    } else {
      this.statusBar.render(cells, size);
    }
  }

  private renderCommandOverlay(buffer: Cell[][], size: Size): void {
    const y = size.height - 1;
    clearRow(buffer, y, color(20));
    const labelColor = { r: 100, g: 220, b: 255 };
    const textColor = { r: 120, g: 255, b: 150 };
    drawText(buffer, 0, y, "COMMAND: ", labelColor);
    const cmd = this.commandBuffer.getBuffer();
    const cursor = this.commandBuffer.getCursorPos();
    drawText(buffer, 9, y, cmd.slice(0, cursor), textColor);
    drawText(buffer, 9 + cursor, y, "_", { r: 255, g: 255, b: 255 });
    drawText(buffer, 10 + cursor, y, cmd.slice(cursor), textColor);
  }

  private renderPatternOverlay(buffer: Cell[][], size: Size): void {
    const y = size.height - 1;
    clearRow(buffer, y, color(20));
    drawText(buffer, 0, y, "PATTERN: ", { r: 255, g: 220, b: 100 });
    drawText(buffer, 9, y, this.patternBuffer, { r: 120, g: 255, b: 150 });
    drawText(buffer, 9 + this.patternBuffer.length, y, "_", { r: 255, g: 255, b: 255 });
  }

  private renderDebugOverlay(buffer: Cell[][], size: Size): void {
    if (!this.engine) return;
    const metrics = this.engine.getPerformanceMonitor().getMetrics();
    const stats = this.engine.getPerformanceMonitor().getStats();
    const currentPattern = this.patterns[this.currentPatternIndex];
    const lines = [
      "PERFORMANCE DEBUG",
      "-----------------",
      `Pattern: ${currentPattern.name}`,
      `Theme: ${this.currentTheme.displayName}`,
      `Quality: ${(this.config.quality ?? "medium").toUpperCase()}`,
      `FPS: ${metrics.fps.toFixed(1)} / ${metrics.targetFps}`,
      `Frame: ${metrics.frameTime.toFixed(2)}ms`,
      `Changed: ${metrics.changedCells} / ${size.width * size.height}`,
      `Dropped: ${stats.totalDroppedFrames}`,
    ];

    const patternMetrics = currentPattern.getMetrics?.();
    if (patternMetrics) {
      lines.push("Pattern Metrics:");
      for (const [key, value] of Object.entries(patternMetrics).slice(0, 8)) {
        lines.push(`  ${key}: ${value}`);
      }
    }

    lines.slice(0, Math.max(0, size.height - 2)).forEach((line, index) => {
      drawText(buffer, 1, index, line.slice(0, Math.max(0, size.width - 2)), index === 0 ? { r: 255, g: 220, b: 100 } : { r: 220, g: 220, b: 220 });
    });
  }

  private getCurrentPatternDisplayName(): string {
    const name = PATTERN_NAMES[this.currentPatternIndex] ?? this.patterns[this.currentPatternIndex]?.name ?? "waves";
    return PATTERN_DISPLAY_NAMES[name] ?? name;
  }

  private finishSoon(): void {
    queueMicrotask(() => {
      if (!this.disposed) this.onExit();
    });
  }

  private cleanup(notifyExit: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.patternBufferTimeout) {
      clearTimeout(this.patternBufferTimeout);
      this.patternBufferTimeout = null;
    }
    this.commandExecutor?.cleanup();
    this.engine?.stop();
    this.renderer?.cleanup();
    this.engine = null;
    this.renderer = null;
    if (notifyExit) this.onExit();
  }
}

function decodeKey(ch: string): KeyInput {
  if (ch === "\x03") return { name: "CTRL_C", data: { isCharacter: false } };
  if (ch === "\x1b") return { name: "ESCAPE", data: { isCharacter: false } };
  if (ch === "\r" || ch === "\n") return { name: "ENTER", data: { isCharacter: false } };
  if (ch === "\x7f" || ch === "\b") return { name: "BACKSPACE", data: { isCharacter: false } };
  if (ch === "\t") return { name: "TAB", data: { isCharacter: false } };
  if (ch === " ") return { name: "SPACE", data: { isCharacter: true, codepoint: 32 } };
  return { name: ch, data: { isCharacter: ch >= " ", codepoint: ch.codePointAt(0) } };
}
