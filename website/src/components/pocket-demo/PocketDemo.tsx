import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { MobileTerminalUi, type MobileTerminalView } from "dormouse-lib/components/MobileTerminalUi";
import { MobileWall, useMobileWallSessionItems, type MobileWallSession } from "dormouse-lib/components/MobileWall";
import { initPlatform } from "dormouse-lib/lib/platform";
import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { disposeAllSessions, initAlertStateReceiver, writeUserInput } from "dormouse-lib/lib/terminal-registry";
import { setNativeFieldValue } from "dormouse-lib/lib/dom";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import { DOCS_THEME_ID } from "dormouse-lib/site/docs-theme";
import { DemoAgent } from "./demo-agent";
import { DemoReadme } from "./DemoReadme";
import { DemoStopped, Finger, FINGER_CLASS } from "./finger";

/**
 * The homepage's Pocket demo: the real mobile composition on a fake PTY,
 * driven by a script. A request typed into Type, an agent's question answered
 * with two gestures, then the README it changed, opened from the Sessions
 * screen, with its new 3D embed turning. Mounted, it shows the agent at its
 * prompt; the script loops while `playing`.
 */

const AGENT = "pocket-demo-agent";
const README = "pocket-demo-readme";
const AGENT_SESSION: MobileWallSession = { id: AGENT, title: "agent" };
const README_SESSION: MobileWallSession = { id: README, title: "README.md", kind: "tool", browserDisplay: "iframe" };
const REQUEST = "I want our markdown editor to support links to 3D GLB files";

/** The app's terminal type scale (`lib/src/theme.css`), scoped to the phone:
 *  that file would retune the whole homepage's type. */
const APP_TYPE_SCALE = {
  "--text-xs": "0.625rem",
  "--text-xs--line-height": "1rem",
  "--text-sm": "0.75rem",
  "--text-sm--line-height": "1rem",
  "--font-mono": "var(--vscode-editor-font-family)",
  "--font-sans": "var(--vscode-editor-font-family)",
} as CSSProperties;

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

/** A fresh agent at an empty prompt, on a cleared screen, in place of `ref`'s. */
function freshAgent(adapter: FakePtyAdapter, ref: { current: DemoAgent | null }): DemoAgent {
  ref.current?.dispose();
  adapter.sendOutput(AGENT, "\x1b[2J\x1b[3J\x1b[H");
  const agent = new DemoAgent((data) => adapter.sendOutput(AGENT, data));
  ref.current = agent;
  adapter.setInputHandler(AGENT, (data) => agent.handleInput(data));
  agent.start();
  return agent;
}

export default function PocketDemo({ playing, still = false }: { playing: boolean; still?: boolean }) {
  useRestoredTheme(DOCS_THEME_ID);
  const screenRef = useRef<HTMLDivElement>(null);
  const fingerRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<DemoAgent | null>(null);
  const [adapter, setAdapter] = useState<FakePtyAdapter | null>(null);
  const [sessions, setSessions] = useState<MobileWallSession[]>(still ? [AGENT_SESSION, README_SESSION] : [AGENT_SESSION]);
  const [activeId, setActiveId] = useState(still ? README : AGENT);
  const [view, setView] = useState<MobileTerminalView>("terminal");
  const sessionItems = useMobileWallSessionItems(sessions, activeId);
  const readmeShown = activeId === README;

  useEffect(() => {
    const fake = initPlatform("fake");
    disposeAllSessions();
    fake.reset();
    initAlertStateReceiver();
    for (const id of [AGENT, README]) fake.setScenario(id, { name: "none", chunks: [] });
    setAdapter(fake);
    return () => {
      disposeAllSessions();
      fake.reset();
    };
  }, []);

  // The phone is on before the script plays: the agent waits at its prompt.
  useEffect(() => {
    if (!adapter) return;
    let live = true;
    void waitForPty(adapter, AGENT).then(() => {
      if (live && !agentRef.current) freshAgent(adapter, agentRef);
    });
    return () => {
      live = false;
      agentRef.current?.dispose();
      agentRef.current = null;
      adapter.clearInputHandler(AGENT);
    };
  }, [adapter]);

  const handleSendInput = useCallback((data: string) => writeUserInput(activeId, data), [activeId]);

  useEffect(() => {
    const screen = screenRef.current;
    const dot = fingerRef.current;
    if (!adapter || !playing || still || !screen || !dot) return;
    const controller = new AbortController();
    const finger = new Finger(screen, dot, controller.signal);
    const play = async () => {
      await waitForPty(adapter, AGENT);
      let current = agentRef.current ?? freshAgent(adapter, agentRef);
      finger.show(true);
      await finger.sleep(600);
      for (;;) {
        await finger.tap(find(screen, 'button[aria-label="Type"]'));
        const field = find(screen, "[data-mobile-composer] textarea") as HTMLTextAreaElement;
        await finger.moveTo({ x: screen.clientWidth * 0.78, y: screen.clientHeight * 0.55 }, 400);
        for (let i = 1; i <= REQUEST.length; i++) {
          setNativeFieldValue(field, REQUEST.slice(0, i));
          await finger.sleep(REQUEST[i - 1] === " " ? 35 : 19);
        }
        await finger.sleep(350);
        await finger.tap(find(screen, "[data-mobile-composer] button", "Send"));

        await current.waitFor("asking");
        await finger.sleep(700);
        const terminal = find(screen, ".xterm-screen");
        const press = { x: screen.clientWidth * 0.62, y: screen.clientHeight * 0.66 };
        await finger.moveTo(press, 500);
        await finger.drag(terminal, [{ x: 0, y: 92, ms: 840 }]);
        await finger.sleep(650);
        await finger.moveTo(press, 380);
        await finger.drag(terminal, [
          { x: 62, y: 62, ms: 760, holdMs: 840 },
          { x: -4, y: -4, ms: 720 },
        ]);

        await current.waitFor("done");
        setSessions([AGENT_SESSION, README_SESSION]);
        await finger.sleep(1_400);
        await finger.tap(find(screen, 'button[title="Show sessions"]'));
        await finger.sleep(600);
        await finger.tap(find(screen, 'section[aria-label="Sessions"] button', "README.md"));
        // Behind the README, the agent starts over, so returning finds it empty.
        current = freshAgent(adapter, agentRef);
        await finger.moveTo({ x: screen.clientWidth * 0.82, y: screen.clientHeight * 0.88 }, 700);
        await finger.sleep(6_000);

        await finger.tap(find(screen, 'button[title="Show sessions"]'));
        await finger.sleep(600);
        await finger.tap(find(screen, 'section[aria-label="Sessions"] button', "agent"));
        setSessions([AGENT_SESSION]);
      }
    };

    play().catch((error: unknown) => {
      if (!(error instanceof DemoStopped)) console.error(error);
    });
    return () => {
      controller.abort(new DemoStopped());
      finger.show(false);
    };
  }, [adapter, playing, still]);

  return (
    <div ref={screenRef} className="relative h-full overflow-hidden" style={APP_TYPE_SCALE}>
      <MobileTerminalUi
        terminal={adapter ? (
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
