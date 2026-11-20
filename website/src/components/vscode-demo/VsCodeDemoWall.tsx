import { useEffect, useRef, useState, type Ref } from "react";
import { prefersReducedMotion } from "dormouse-lib/lib/ui-geometry";
import { Wall } from "dormouse-lib/components/Wall";
import { WorkspaceVisibleContext } from "dormouse-lib/components/wall/wall-context";
import { initPlatform } from "dormouse-lib/lib/platform";
import { disposeSession, initAlertStateReceiver, toggleSessionTodo } from "dormouse-lib/lib/terminal-registry";
import { seedLaunchedCommand } from "dormouse-lib/lib/terminal-state-store";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import type { LathPersistedLayout } from "dormouse-lib/lib/lath/persistence";
import "dormouse-lib/wall.css";
import { APP_TYPE_SCALE, paintDemoTheme } from "../demo-theme";
import { DemoStopped, Finger } from "../pocket-demo/finger";
import { CWD, ran, SCENES, type SceneName } from "./scenes";

/**
 * The real Wall inside a homepage VS Code window, on the fake PTY, showing one
 * scene from `./scenes.ts`. The window around it is `inert`, and the Wall is
 * mounted inactive so it never takes the homepage's keyboard or focus.
 */
export default function VsCodeDemoWall({ scene: name }: { scene: SceneName }) {
  useRestoredTheme(undefined, paintDemoTheme);
  const scene = SCENES[name];
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<LathPersistedLayout | null>(null);

  useEffect(() => {
    const fake = initPlatform("fake");
    const ids = Object.keys(scene.sessions);
    // Only its own Sessions: the other demos share the adapter and the registry.
    const disposeOwn = () => {
      for (const id of ids) {
        disposeSession(id);
        fake.clearScenario(id);
      }
    };
    disposeOwn();
    initAlertStateReceiver();
    for (const [id, { command, data, ports, title }] of Object.entries(scene.sessions)) {
      const named = title === undefined ? "" : `\x1b]0;${title}\x07`;
      if (data === undefined) seedLaunchedCommand(id, command, CWD);
      else fake.setScenario(id, { name: command, chunks: [{ delay: 0, data: ran(command) + named + data }] });
      if (ports) fake.setOpenPorts(id, ports);
    }
    // A TODO lives in the alert host, which knows a Session once it spawns.
    const stopTodos = fake.onPtySpawn(({ id }) => {
      if (scene.sessions[id]?.todo) toggleSessionTodo(id);
    });
    setLayout(scene.layout(window.location.origin));
    return () => {
      stopTodos();
      disposeOwn();
    };
  }, [scene]);

  // The cursor's tour: right-click each header in turn, holding on each
  // context, while the window is on screen. Reduced motion opens the first
  // one and stays.
  useEffect(() => {
    const root = rootRef.current;
    const cursor = cursorRef.current;
    const tour = scene.contextTour;
    if (!layout || !root || !cursor || !tour?.length) return;
    let controller: AbortController | null = null;
    const stop = () => {
      controller?.abort(new DemoStopped());
      controller = null;
    };
    const play = () => {
      if (controller) return;
      const run = new AbortController();
      controller = run;
      tourContexts(root, cursor, tour, run.signal).catch((error: unknown) => {
        if (!(error instanceof DemoStopped)) console.error(error);
      });
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio >= 0.35) play();
      else if (!entry.isIntersecting) stop();
    }, { threshold: [0, 0.35] });
    observer.observe(root);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [layout, scene]);

  if (!layout) return null;
  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 w-full" style={APP_TYPE_SCALE}>
      {/* Shown but inactive, as an outgoing Workspace is while it fades: its
          terminals stay attached, and it takes no window input. */}
      <WorkspaceVisibleContext.Provider value={true}>
        <Wall
          workspaceId={scene.workspaceId}
          restoredLathLayout={layout}
          initialDoors={scene.doors}
          initialMode="passthrough"
          active={false}
        />
      </WorkspaceVisibleContext.Provider>
      {scene.contextTour ? <Cursor ref={cursorRef} /> : null}
    </div>
  );
}

/** Where in `root` the cursor's tip goes to right-click `header`: a little way
 *  in from its left end. Layout offsets, since the window is scaled. */
function headerPoint(root: HTMLElement, header: HTMLElement): { x: number; y: number } {
  const point = { x: Math.min(90, header.offsetWidth / 3), y: header.offsetHeight / 2 };
  for (let node: HTMLElement | null = header; node && node !== root; node = node.offsetParent as HTMLElement | null) {
    point.x += node.offsetLeft;
    point.y += node.offsetTop;
  }
  return point;
}

/** A right-click where the cursor's tip is, as the reader's own would arrive. */
function rightClick(header: HTMLElement, cursor: HTMLElement): void {
  const tip = cursor.getBoundingClientRect();
  header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: tip.left, clientY: tip.top }));
}

async function tourContexts(root: HTMLElement, cursor: HTMLElement, tour: readonly string[], signal: AbortSignal): Promise<void> {
  const finger = new Finger(root, cursor, signal);
  const header = async (id: string) => {
    for (;;) {
      const found = root.querySelector<HTMLElement>(`[data-pane-header-for="${id}"]`);
      if (found) return found;
      await finger.sleep(50);
    }
  };
  if (prefersReducedMotion()) {
    const first = await header(tour[0]);
    await finger.moveTo(headerPoint(root, first), 0);
    rightClick(first, cursor);
    return;
  }
  finger.show(true);
  for (;;) {
    for (const id of tour) {
      const target = await header(id);
      await finger.moveTo(headerPoint(root, target), 700);
      await finger.sleep(150);
      rightClick(target, cursor);
      await finger.sleep(3_200);
    }
  }
}

/** A pointer arrow, its tip at its position. */
function Cursor({ ref }: { ref: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-50 opacity-0 transition-opacity duration-150">
      <svg width="20" height="28" viewBox="0 0 20 28" className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
        <path d="M1.5 1.5v20.5l5.2-5 3.6 8.4 3.3-1.4-3.6-8.3h7.2z" fill="#000" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
