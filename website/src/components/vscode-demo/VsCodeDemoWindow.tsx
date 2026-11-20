import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  AtomIcon,
  BellIcon,
  CaretDownIcon,
  CaretRightIcon,
  CopyIcon,
  GearSixIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  SidebarSimpleIcon,
  SquareHalfBottomIcon,
  SquaresFourIcon,
  UserCircleIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import tinyIconUrl from "../../assets/icon-tiny-dark.png";

const VsCodeDemoWall = lazy(() => import("./VsCodeDemoWall"));

/** VS Code's workbench in Kimbie Dark, the theme the Wall inside wears
 *  (`../demo-theme.ts`): the theme file's own colors, and VS Code's dark
 *  defaults for the keys it leaves unset. The workbench is VS Code's, not
 *  Dormouse's, so these are a picture of it rather than theme tokens. */
const KIMBIE = {
  titleBar: "#423523",
  activityBar: "#221a0f",
  activityFg: "#d3af86",
  sideBar: "#362712",
  sectionBorder: "#5e452b",
  tabs: "#131510",
  editor: "#221a0f",
  listActive: "#7c5021",
  statusBar: "#423523",
  remote: "#6e583b",
  foreground: "#cccccc",
  modified: "#e2c08d",
  badge: "#007acc",
} as const;

/** The window's narrowest layout; a narrower column scales it down whole. */
const MIN_LAYOUT_WIDTH = 920;
const ASPECT = 0.64;

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

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

const TREE: readonly TreeRow[] = [
  { depth: 0, label: ".vscode", folder: "closed" },
  { depth: 0, label: "node_modules", folder: "closed" },
  { depth: 0, label: "public", folder: "closed" },
  { depth: 0, label: "src", folder: "open" },
  { depth: 1, label: "pages", folder: "open" },
  { depth: 2, label: "Habits.tsx", icon: TSX },
  { depth: 2, label: "Settings.tsx", icon: TSX, modified: true, selected: true },
  { depth: 2, label: "Today.tsx", icon: TSX },
  { depth: 1, label: "main.tsx", icon: TSX },
  { depth: 1, label: "theme.test.ts", icon: TS },
  { depth: 1, label: "theme.ts", icon: TS, modified: true },
  { depth: 0, label: "dormouse.yml", icon: glyph("!", "#a074c4") },
  { depth: 0, label: "index.html", icon: glyph("<>", "#e37933") },
  { depth: 0, label: "package.json", icon: glyph("{}", "#cbcb41") },
  { depth: 0, label: "README.md", icon: glyph("M↓", "#519aba") },
  { depth: 0, label: "vite.config.ts", icon: TS },
];

function ActivityIcon({ children, active = false, badge }: { children: ReactNode; active?: boolean; badge?: string }) {
  return (
    <div
      className="relative flex h-12 w-12 items-center justify-center"
      style={{ color: KIMBIE.activityFg, boxShadow: active ? `inset 2px 0 0 ${KIMBIE.activityFg}` : undefined }}
    >
      <span className="flex" style={{ opacity: active ? 1 : 0.4 }}>{children}</span>
      {badge ? (
        <span
          className="absolute right-2 bottom-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold text-white"
          style={{ background: KIMBIE.badge }}
        >
          {badge}
        </span>
      ) : null}
    </div>
  );
}

function Explorer() {
  return (
    <div className="flex w-[220px] shrink-0 flex-col text-[13px]" style={{ background: KIMBIE.sideBar, color: KIMBIE.foreground }}>
      <div className="flex h-[35px] items-center justify-between pr-2 pl-5 text-[11px]">
        <span>EXPLORER</span>
        <span className="opacity-80">···</span>
      </div>
      <div className="flex h-[22px] items-center gap-0.5 pl-0.5 text-[11px] font-bold">
        <CaretDownIcon size={14} />
        ACORN
      </div>
      <div className="flex-1">
        {TREE.map((row) => (
          <div
            key={`${row.depth}-${row.label}`}
            className="flex h-[22px] items-center gap-1.5 pr-3"
            style={{
              paddingLeft: 8 + row.depth * 12 + (row.folder ? 0 : 16),
              background: row.selected ? KIMBIE.listActive : undefined,
              color: row.modified ? KIMBIE.modified : undefined,
              boxShadow: row.selected ? "inset 0 0 0 1px #a57a4c" : undefined,
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
    </div>
  );
}

function Tab({ label, icon, active = false, modified = false }: { label: string; icon: ReactNode; active?: boolean; modified?: boolean }) {
  return (
    <div
      className="flex h-full items-center gap-1.5 pr-2 pl-3 text-[13px]"
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

/**
 * The homepage's picture of Dormouse in VS Code: VS Code's workbench drawn in
 * HTML around the real Wall, open in an editor tab as `dormouse.open` opens it.
 * It lays out at no less than `MIN_LAYOUT_WIDTH` and scales down to fit its
 * column, and mounts the Wall once it is a screen away.
 */
export function VsCodeDemoWindow({ className = "" }: { className?: string }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [fit, setFit] = useState<{ width: number; scale: number } | null>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const nearby = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setNear(true);
      nearby.disconnect();
    }, { rootMargin: "100% 0px" });
    nearby.observe(slot);
    const refit = () => {
      const available = slot.clientWidth;
      const width = Math.max(available, MIN_LAYOUT_WIDTH);
      setFit((prev) => prev?.width === width && prev.scale === available / width ? prev : { width, scale: available / width });
    };
    refit();
    const resize = new ResizeObserver(refit);
    resize.observe(slot);
    return () => {
      nearby.disconnect();
      resize.disconnect();
    };
  }, []);

  const width = fit?.width ?? MIN_LAYOUT_WIDTH;
  const height = Math.round(width * ASPECT);
  const scale = fit?.scale ?? 1;
  const windowStyle: CSSProperties = {
    width,
    height,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    transformOrigin: "top left",
    fontFamily: FONT_STACK,
  };

  return (
    <div ref={slotRef} className={className} style={{ height: height * scale }}>
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
          {/* Activity bar */}
          <div className="flex w-12 shrink-0 flex-col" style={{ background: KIMBIE.activityBar }}>
            <ActivityIcon active><CopyIcon size={24} /></ActivityIcon>
            <ActivityIcon><MagnifyingGlassIcon size={24} /></ActivityIcon>
            <ActivityIcon badge="2"><GitBranchIcon size={24} /></ActivityIcon>
            <ActivityIcon><PlayIcon size={24} /></ActivityIcon>
            <ActivityIcon><SquaresFourIcon size={24} /></ActivityIcon>
            <div className="mt-auto">
              <ActivityIcon><UserCircleIcon size={24} /></ActivityIcon>
              <ActivityIcon><GearSixIcon size={24} /></ActivityIcon>
            </div>
          </div>

          <Explorer />

          {/* Editor group: Dormouse open in an editor tab. */}
          <div className="flex min-w-0 flex-1 flex-col" style={{ background: KIMBIE.editor }}>
            <div className="flex h-[35px] shrink-0" style={{ background: KIMBIE.tabs }}>
              <Tab label="Settings.tsx" icon={TSX} modified />
              <Tab label="Dormouse" icon={<img src={tinyIconUrl} alt="" className="size-4" />} active />
            </div>
            <div className="relative min-h-0 flex-1">
              {near ? (
                <Suspense fallback={null}>
                  <VsCodeDemoWall />
                </Suspense>
              ) : null}
            </div>
          </div>
        </div>

        {/* Status bar */}
        <div className="flex h-[22px] shrink-0 items-center text-[12px] text-white" style={{ background: KIMBIE.statusBar }}>
          <div className="flex h-full items-center px-2.5 font-mono text-[11px] font-bold" style={{ background: KIMBIE.remote }}>&gt;&lt;</div>
          <div className="flex items-center gap-1 px-2"><GitBranchIcon size={13} />main*</div>
          <div className="flex items-center gap-1 px-2">
            <XCircleIcon size={13} />0
            <WarningIcon size={13} className="ml-1" />0
          </div>
          <div className="ml-auto flex items-center px-3"><BellIcon size={13} /></div>
        </div>
      </div>
    </div>
  );
}
