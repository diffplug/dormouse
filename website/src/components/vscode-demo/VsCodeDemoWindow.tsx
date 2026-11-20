import { lazy, memo, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  AtomIcon,
  BellIcon,
  CaretDownIcon,
  CaretRightIcon,
  CopyIcon,
  CornersOutIcon,
  DotsThreeIcon,
  GearSixIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SquareHalfBottomIcon,
  SquareSplitHorizontalIcon,
  SquaresFourIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import tinyIconUrl from "../../assets/icon-tiny-dark.png";
import agentStill from "../../assets/demo-stills/agent.webp";
import portsStill from "../../assets/demo-stills/ports.webp";
import videoStill from "../../assets/demo-stills/video.webp";
import type { SceneName } from "./scenes";

/** The Walls' module, which the homepage also fetches ahead, once it has loaded. */
export const loadVsCodeDemoWall = () => import("./VsCodeDemoWall");
const VsCodeDemoWall = lazy(loadVsCodeDemoWall);

/** Each scene's first frame, shown until its Wall paints over it, so a slow
 *  load looks like the app rather than an empty window. Screenshots of the
 *  real scenes, at the window's layout size: retake them when a scene or the
 *  Wall's look changes. */
const STILLS: Record<SceneName, string> = { video: videoStill, agent: agentStill, ports: portsStill };

/** VS Code's workbench in Kimbie Dark, the theme the Walls inside wear
 *  (`../homepage-demos.ts`): the theme file's own colors, and VS Code's dark
 *  defaults for the keys it leaves unset. The workbench is VS Code's, not
 *  Dormouse's, so these are a picture of it rather than theme tokens. */
const KIMBIE = {
  titleBar: "#423523",
  activityFg: "#d3af86",
  sideBar: "#362712",
  sectionBorder: "#5e452b",
  tabs: "#131510",
  editor: "#221a0f",
  editorFg: "#d3af86",
  lineNumber: "#858585",
  listActive: "#7c5021",
  groupBorder: "#444444",
  panelBorder: "#80808059",
  statusBar: "#423523",
  remote: "#6e583b",
  foreground: "#cccccc",
  modified: "#e2c08d",
  badge: "#007acc",
  /** Token colors: Markdown headings, and inline and fenced code. */
  heading: "#8ab1b0",
  code: "#889b4a",
} as const;

/** The window's default narrowest layout; a narrower column scales it down
 *  whole. `./scenes.ts` wraps agent prose to the pane widths this gives. */
const MIN_LAYOUT_WIDTH = 920;

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const EDITOR_FONT = "Menlo, Monaco, 'Courier New', monospace";

const DORMOUSE_ICON = <img src={tinyIconUrl} alt="" className="size-4" />;

type TreeRow = {
  depth: number;
  label: string;
  folder?: "open" | "closed";
  icon?: ReactNode;
  modified?: boolean;
  selected?: boolean;
};

const glyph = (text: string, color: string) => (
  <span className="inline-flex w-4 justify-center font-mono text-[9px] font-bold tracking-tighter" style={{ color }}>{text}</span>
);
const TSX = <AtomIcon size={14} color="#519aba" />;
const TS = glyph("TS", "#519aba");
const MD = glyph("M↓", "#519aba");

const TREE: readonly TreeRow[] = [
  { depth: 0, label: ".vscode", folder: "closed" },
  { depth: 0, label: "node_modules", folder: "closed" },
  { depth: 0, label: "public", folder: "closed" },
  { depth: 0, label: "src", folder: "open" },
  { depth: 1, label: "pages", folder: "open" },
  { depth: 2, label: "Habits.tsx", icon: TSX },
  { depth: 2, label: "Settings.tsx", icon: TSX, modified: true },
  { depth: 2, label: "Today.tsx", icon: TSX },
  { depth: 1, label: "main.tsx", icon: TSX },
  { depth: 1, label: "theme.test.ts", icon: TS },
  { depth: 1, label: "theme.ts", icon: TS, modified: true },
  { depth: 0, label: "dormouse.yml", icon: glyph("!", "#a074c4") },
  { depth: 0, label: "index.html", icon: glyph("<>", "#e37933") },
  { depth: 0, label: "package.json", icon: glyph("{}", "#cbcb41") },
  { depth: 0, label: "README.md", icon: MD, selected: true },
  { depth: 0, label: "vite.config.ts", icon: TS },
];

/** README.md, one source line per entry: runs of text, each with its token color. */
type Run = { text: string; color?: string; bold?: boolean };
const README: readonly (readonly Run[])[] = [
  [{ text: "# Acorn", color: KIMBIE.heading, bold: true }],
  [],
  [{ text: "A habit tracker small enough to keep in a pocket: daily check-ins, streaks, and one nudge at the time you pick." }],
  [],
  [{ text: "## Develop", color: KIMBIE.heading, bold: true }],
  [],
  [{ text: "```sh", color: KIMBIE.code }],
  [{ text: "pnpm install", color: KIMBIE.code }],
  [{ text: "pnpm dev", color: KIMBIE.code }],
  [{ text: "```", color: KIMBIE.code }],
  [],
  [{ text: "The app serves on " }, { text: "`localhost:5173`", color: KIMBIE.code }, { text: ", and the API runs with " }, { text: "`wrangler dev`", color: KIMBIE.code }, { text: "." }],
];

const lineLength = (runs: readonly Run[]) => runs.reduce((sum, run) => sum + run.text.length, 0);

function Explorer() {
  return (
    <div className="flex w-[220px] shrink-0 flex-col text-[13px]" style={{ background: KIMBIE.sideBar, color: KIMBIE.foreground }}>
      <div className="flex h-[35px] items-center justify-between pr-2 pl-5 text-[11px]">
        <span>EXPLORER</span>
        <DotsThreeIcon size={16} className="opacity-80" />
      </div>
      <div className="flex h-[22px] items-center gap-0.5 pl-0.5 text-[11px] font-bold">
        <CaretDownIcon size={14} />
        ACORN
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {TREE.map((row) => (
          <div
            key={`${row.depth}-${row.label}`}
            className="flex h-[22px] items-center gap-1.5 pr-3"
            style={{
              paddingLeft: 8 + row.depth * 12 + (row.folder ? 0 : 16),
              background: row.selected ? KIMBIE.listActive : undefined,
              color: row.modified ? KIMBIE.modified : undefined,
            }}
          >
            {row.folder === "open" ? <CaretDownIcon size={14} /> : row.folder === "closed" ? <CaretRightIcon size={14} /> : row.icon}
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.modified ? <span className="text-[11px]">M</span> : null}
          </div>
        ))}
      </div>
      {["OUTLINE", "TIMELINE"].map((label) => (
        <div
          key={label}
          className="flex h-[22px] items-center gap-0.5 pl-0.5 text-[11px] font-bold"
          style={{ borderTop: `1px solid ${KIMBIE.sectionBorder}` }}
        >
          <CaretRightIcon size={14} />
          {label}
        </div>
      ))}
      {/* The activity bar, at the foot of the Side Bar (`workbench.activityBar.location: bottom`). */}
      <div className="flex h-[35px] shrink-0 items-center gap-3.5 px-3" style={{ color: KIMBIE.activityFg, borderTop: `1px solid ${KIMBIE.sectionBorder}` }}>
        <span className="flex h-full items-center" style={{ boxShadow: `inset 0 -1px 0 ${KIMBIE.activityFg}` }}><CopyIcon size={18} /></span>
        {[MagnifyingGlassIcon, GitBranchIcon, PlayIcon].map((Icon, i) => <Icon key={i} size={18} className="opacity-50" />)}
        <span className="relative flex">
          <SquaresFourIcon size={18} className="opacity-50" />
          <span className="absolute -right-1.5 -bottom-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-semibold text-white" style={{ background: KIMBIE.badge }}>1</span>
        </span>
      </div>
    </div>
  );
}

function Tab({ label, icon, active = false, modified = false }: { label: string; icon: ReactNode; active?: boolean; modified?: boolean }) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1.5 pr-2 pl-3 text-[13px]"
      style={{
        background: active ? KIMBIE.editor : KIMBIE.tabs,
        color: modified ? KIMBIE.modified : active ? "#ffffff" : "#ffffff80",
        borderRight: "1px solid #252526",
      }}
    >
      {icon}
      <span>{label}</span>
      <span className="ml-1 flex w-5 justify-center">{active ? <XIcon size={14} /> : null}</span>
    </div>
  );
}

/** An editor group's tab strip, with its actions at the right end. */
function TabStrip({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex h-[35px] shrink-0" style={{ background: KIMBIE.tabs }}>
      {children}
      <div className="ml-auto flex items-center gap-2.5 px-3" style={{ color: KIMBIE.foreground }}>{actions}</div>
    </div>
  );
}

/** A Wall, mounted once the window is near the viewport. Memoized: the
 *  window's refits would otherwise re-render the whole Wall. */
const DemoWall = memo(function DemoWall({ scene, near }: { scene: SceneName; near: boolean }) {
  return (
    <div data-demo-scene={scene} className="relative min-h-0 flex-1" style={{ background: KIMBIE.editor }}>
      <img src={STILLS[scene]} alt="" decoding="async" className="absolute inset-0 size-full" />
      {near ? (
        <Suspense fallback={null}>
          <VsCodeDemoWall scene={scene} />
        </Suspense>
      ) : null}
    </div>
  );
});

/** README.md in a text editor group: breadcrumbs, line numbers, word wrap, minimap. */
function ReadmeGroup() {
  return (
    <div className="flex w-[42%] shrink-0 flex-col" style={{ background: KIMBIE.editor, borderRight: `1px solid ${KIMBIE.groupBorder}` }}>
      <TabStrip actions={<DotsThreeIcon size={16} />}>
        <Tab label="README.md" icon={MD} active />
      </TabStrip>
      <div className="flex h-[22px] shrink-0 items-center gap-1 px-4 text-[12px]" style={{ color: "#cccccccc" }}>
        {MD}README.md<CaretRightIcon size={11} />
        <span className="truncate"># Acorn</span>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden text-[12px] leading-[18px]" style={{ fontFamily: EDITOR_FONT, color: KIMBIE.editorFg }}>
        <div className="min-w-0 flex-1">
          {README.map((runs, i) => (
            <div key={i} className="flex">
              <span className="w-10 shrink-0 pr-4 text-right" style={{ color: i === 0 ? "#c6c6c6" : KIMBIE.lineNumber }}>{i + 1}</span>
              <span className="min-w-0 flex-1 pr-2 break-words">
                {runs.length ? runs.map((run, j) => (
                  <span key={j} style={{ color: run.color, fontWeight: run.bold ? 700 : undefined }}>{run.text}</span>
                )) : " "}
              </span>
            </div>
          ))}
        </div>
        {/* The minimap: each line a faint bar of its length. */}
        <div className="w-12 shrink-0 space-y-[2px] pt-0.5 pr-2 opacity-40">
          {README.map((runs, i) => (
            <div key={i} className="h-[2px] rounded-full" style={{ width: `${Math.min(100, lineLength(runs) * 1.6)}%`, background: runs[0]?.color ?? KIMBIE.editorFg }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The bottom panel, Dormouse's view selected among the panel's others. */
function Panel({ scene, near }: { scene: SceneName; near: boolean }) {
  const tab = (label: string, badge?: string, active = false) => (
    <div
      className="flex h-full items-center gap-1.5 text-[11px]"
      style={{ color: active ? "#e7e7e7" : "#e7e7e799", boxShadow: active ? "inset 0 -1px 0 #e7e7e7" : undefined }}
    >
      {label}
      {badge ? <span className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white" style={{ background: KIMBIE.badge }}>{badge}</span> : null}
    </div>
  );
  return (
    <div className="flex h-[46%] shrink-0 flex-col" style={{ background: KIMBIE.editor, borderTop: `1px solid ${KIMBIE.panelBorder}` }}>
      <div className="flex h-[35px] shrink-0 items-center gap-5 px-5">
        {tab("DEBUG CONSOLE")}
        {tab("DORMOUSE", "1", true)}
        {tab("PROBLEMS", "2")}
        <div className="ml-auto flex items-center gap-3" style={{ color: KIMBIE.foreground }}>
          <GearSixIcon size={15} />
          <PlusIcon size={15} />
          <span className="h-4 w-px bg-current opacity-30" />
          <CornersOutIcon size={15} />
          <XIcon size={15} />
        </div>
      </div>
      <DemoWall scene={scene} near={near} />
    </div>
  );
}

/**
 * A homepage picture of Dormouse in VS Code: VS Code's workbench drawn in HTML
 * around the real Wall. `tab` is the Workspace open in an editor tab, as
 * `dormouse.open` opens one; `panel`, if given, the one in the bottom panel.
 * With `readme`, the Explorer is open and README.md sits in its own editor group
 * beside the Dormouse tab; otherwise `otherTab` shares the Dormouse tab's group.
 * It lays out at no less than `minWidth` and scales down to fit its column, and
 * mounts its Walls once it is a screen away.
 */
export function VsCodeDemoWindow({
  tab,
  panel,
  readme = false,
  otherTab,
  aspect,
  minWidth = MIN_LAYOUT_WIDTH,
  className = "",
}: {
  tab: SceneName;
  panel?: SceneName;
  readme?: boolean;
  otherTab?: string;
  /** Height over width. */
  aspect: number;
  /** Narrowest layout width, wider than the column to draw it smaller. */
  minWidth?: number;
  className?: string;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const nearby = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setNear(true);
      nearby.disconnect();
    }, { rootMargin: "100% 0px" });
    nearby.observe(slot);
    const refit = () => setAvailable(slot.clientWidth);
    refit();
    const resize = new ResizeObserver(refit);
    resize.observe(slot);
    return () => {
      nearby.disconnect();
      resize.disconnect();
    };
  }, []);

  const width = Math.max(available ?? minWidth, minWidth);
  const height = Math.round(width * aspect);
  const scale = (available ?? width) / width;
  const windowStyle: CSSProperties = {
    width,
    height,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    transformOrigin: "top left",
    fontFamily: FONT_STACK,
  };

  return (
    // `min-w-0`: the window's layout width is not the slot's. As a grid or flex
    // item the slot would otherwise grow to it, and widen the page on a phone.
    <div ref={slotRef} className={`min-w-0 ${className}`} style={{ height: height * scale }}>
      <div
        aria-hidden="true"
        inert
        className="flex flex-col overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(0,0,0,0.5),0_18px_50px_rgba(0,0,0,0.45)] select-none"
        style={windowStyle}
      >
        {/* Title bar: traffic lights, history, command center, layout toggles. */}
        <div className="relative flex h-[35px] shrink-0 items-center px-3 text-[13px]" style={{ background: KIMBIE.titleBar, color: KIMBIE.foreground }}>
          <div className="flex gap-2">
            {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
              <span key={color} className="size-3 rounded-full" style={{ background: color }} />
            ))}
          </div>
          <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-3">
            <ArrowLeftIcon size={15} className="opacity-80" />
            <ArrowRightIcon size={15} className="opacity-40" />
            <div
              className="flex h-[22px] w-[360px] items-center justify-center gap-1.5 rounded-md text-[12px]"
              style={{ background: "rgba(204,204,204,0.05)", boxShadow: "inset 0 0 0 1px rgba(204,204,204,0.2)" }}
            >
              <MagnifyingGlassIcon size={13} />
              acorn
            </div>
          </div>
          <div className="ml-auto flex gap-2.5 opacity-80">
            <SidebarSimpleIcon size={15} />
            <SquareHalfBottomIcon size={15} />
            <SidebarSimpleIcon size={15} className="-scale-x-100" />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {readme ? <Explorer /> : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1">
              {readme ? <ReadmeGroup /> : null}
              {/* Dormouse open in an editor tab. */}
              <div className="flex min-w-0 flex-1 flex-col" style={{ background: KIMBIE.editor }}>
                <TabStrip actions={<><SquareSplitHorizontalIcon size={15} /><DotsThreeIcon size={16} /></>}>
                  {otherTab ? <Tab label={otherTab} icon={TSX} modified /> : null}
                  <Tab label="Dormouse" icon={DORMOUSE_ICON} active />
                </TabStrip>
                <DemoWall scene={tab} near={near} />
              </div>
            </div>
            {panel ? <Panel scene={panel} near={near} /> : null}
          </div>
        </div>

        {/* Status bar */}
        <div className="flex h-[22px] shrink-0 items-center text-[12px] text-white" style={{ background: KIMBIE.statusBar }}>
          <div className="flex h-full items-center px-2.5 font-mono text-[11px] font-bold" style={{ background: KIMBIE.remote }}>&gt;&lt;</div>
          <div className="flex items-center gap-1 px-2"><GitBranchIcon size={13} />main*</div>
          <div className="flex items-center gap-1 px-2">
            <XCircleIcon size={13} />0
            <WarningIcon size={13} className="ml-1" />2
          </div>
          <div className="ml-auto flex items-center px-3"><BellIcon size={13} /></div>
        </div>
      </div>
    </div>
  );
}
