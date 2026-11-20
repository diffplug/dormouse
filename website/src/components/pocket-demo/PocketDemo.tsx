import { useCallback, useEffect, useRef, useState } from "react";
import { MobileTerminalUi, type MobileTerminalView } from "dormouse-lib/components/MobileTerminalUi";
import { MobileWall, useMobileWallSessionItems, type MobileWallSession } from "dormouse-lib/components/MobileWall";
import { initPlatform } from "dormouse-lib/lib/platform";
import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { initAlertStateReceiver, writeUserInput } from "dormouse-lib/lib/terminal-registry";
import { setNativeFieldValue } from "dormouse-lib/lib/dom";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import { APP_TYPE_SCALE, disposeDemoSessions, paintDemoTheme } from "../homepage-demos";
import { DemoAgent } from "./demo-agent";
import { DemoReadme } from "./DemoReadme";
import { DemoStopped, DemoStuck, Finger, FINGER_CLASS } from "./finger";

/**
 * The homepage's Pocket demo: the real mobile composition on a fake PTY,
 * driven by a script. A request typed into Type, an agent's question answered
 * with two gestures, then the README it changed, opened from the Sessions
 * screen, with its new 3D embed turning. Mounted, it shows the agent at its
 * prompt; the script loops while `playing`, and calls `onStuck` if the agent
 * never answers, for a fresh start.
 */

const AGENT = "pocket-demo-agent";
const README = "pocket-demo-readme";
const AGENT_SESSION: MobileWallSession = { id: AGENT, title: "agent" };
const README_SESSION: MobileWallSession = { id: README, title: "README.md", kind: "tool", browserDisplay: "iframe" };
const REQUEST = "I want our markdown editor to support links to 3D GLB files";

function find(root: ParentNode, selector: string, text?: string): HTMLElement {
  const match = [...root.querySelectorAll<HTMLElement>(selector)].find((element) => text === undefined || element.textContent?.includes(text));
  if (!match) throw new Error(`pocket demo: no ${selector}${text ? ` with "${text}"` : ""}`);
  return match;
}

function waitForPty(adapter: FakePtyAdapter, id: string): Promise<void> {
  if (adapter.hasPty(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = adapter.onPtySpawn((detail) => {
      if (detail.id !== id) return;
      stop();
      resolve();
    });
  });
}

export default function PocketDemo({ playing, onStuck, still = false }: { playing: boolean; onStuck: () => void; still?: boolean }) {
  useRestoredTheme(undefined, paintDemoTheme);
  const screenRef = useRef<HTMLDivElement>(null);
  const fingerRef = useRef<HTMLDivElement>(null);
  const [demo, setDemo] = useState<{ agent: DemoAgent; ready: Promise<void> } | null>(null);
  const [sessions, setSessions] = useState<MobileWallSession[]>(still ? [AGENT_SESSION, README_SESSION] : [AGENT_SESSION]);
  const [activeId, setActiveId] = useState(still ? README : AGENT);
  const [view, setView] = useState<MobileTerminalView>("terminal");
  const sessionItems = useMobileWallSessionItems(sessions, activeId);
  const readmeShown = activeId === README;

  useEffect(() => {
    const fake = initPlatform("fake");
    const disposeOwn = () => disposeDemoSessions(fake, [AGENT, README]);
    disposeOwn();
    initAlertStateReceiver();
    for (const id of [AGENT, README]) fake.setScenario(id, { name: "none", chunks: [] });
    const agent = new DemoAgent((data) => fake.sendOutput(AGENT, data));
    fake.setInputHandler(AGENT, (data) => agent.handleInput(data));
    // The phone is on before the script plays: the agent waits at its prompt.
    const ready = waitForPty(fake, AGENT).then(() => agent.restart());
    setDemo({ agent, ready });
    return () => {
      agent.dispose();
      disposeOwn();
    };
  }, []);

  const handleSendInput = useCallback((data: string) => writeUserInput(activeId, data), [activeId]);

  useEffect(() => {
    const screen = screenRef.current;
    const dot = fingerRef.current;
    if (!demo || !playing || still || !screen || !dot) return;
    const { agent } = demo;
    const controller = new AbortController();
    const finger = new Finger(screen, dot, controller.signal);
    const play = async () => {
      await demo.ready;
      finger.show(true);
      await finger.sleep(600);
      for (;;) {
        await finger.tap(find(screen, 'button[aria-label="Type"]'));
        const field = find(screen, "[data-mobile-composer] textarea") as HTMLTextAreaElement;
        await finger.moveTo({ x: screen.clientWidth * 0.78, y: screen.clientHeight * 0.55 }, 400);
        for (let i = 1; i <= REQUEST.length; i++) {
          setNativeFieldValue(field, REQUEST.slice(0, i));
          await finger.sleep(REQUEST[i - 1] === " " ? 18 : 10);
        }
        await finger.sleep(350);
        await finger.tap(find(screen, "[data-mobile-composer] button", "Send"));

        await finger.expect(agent.waitFor("asking"), 5_000);
        await finger.sleep(700);
        const terminal = find(screen, ".xterm-screen");
        const press = { x: screen.clientWidth * 0.62, y: screen.clientHeight * 0.66 };
        await finger.moveTo(press, 500);
        await finger.drag(terminal, [{ x: 0, y: 92, ms: 840 }]);
        await finger.sleep(325);
        await finger.moveTo(press, 190);
        await finger.drag(terminal, [
          { x: 62, y: 62, ms: 760, holdMs: 420 },
          { x: -4, y: -4, ms: 720 },
        ]);

        await finger.expect(agent.waitFor("done"), 5_000);
        setSessions([AGENT_SESSION, README_SESSION]);
        await finger.tap(find(screen, 'button[title="Show sessions"]'));
        await finger.sleep(600);
        await finger.tap(find(screen, 'section[aria-label="Sessions"] button', "README.md"));
        // Behind the README, the agent starts over, so returning finds it empty.
        agent.restart();
        await finger.sleep(1_300);

        await finger.tap(find(screen, 'button[title="Show sessions"]'));
        await finger.sleep(600);
        await finger.tap(find(screen, 'section[aria-label="Sessions"] button', "agent"));
        setSessions([AGENT_SESSION]);
      }
    };

    play().catch((error: unknown) => {
      if (error instanceof DemoStuck) onStuck();
      else if (!(error instanceof DemoStopped)) console.error(error);
    });
    return () => {
      controller.abort(new DemoStopped());
      finger.show(false);
    };
  }, [demo, playing, still, onStuck]);

  return (
    <div ref={screenRef} className="relative h-full overflow-hidden" style={APP_TYPE_SCALE}>
      <MobileTerminalUi
        terminal={demo ? (
          <MobileWall
            sessions={sessions}
            activeSessionId={activeId}
            onActiveSessionChange={setActiveId}
            onShowSessions={() => setView("sessions")}
            showKillButton={false}
            browser={readmeShown ? <DemoReadme spinning={!still} /> : null}
            browserShown={readmeShown}
          />
        ) : null}
        activeView={view}
        onViewChange={setView}
        sessions={sessionItems}
        onSessionSelect={setActiveId}
        browserShown={readmeShown}
        onSendInput={handleSendInput}
      />
      <div ref={fingerRef} className={FINGER_CLASS} style={{ opacity: 0 }} />
    </div>
  );
}
