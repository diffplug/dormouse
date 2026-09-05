/** @vitest-environment jsdom */
import { act, useCallback, useEffect, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType, type NavigateOptions, type To } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const requestedPaths = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => {
      const navigate = actual.useNavigate();
      return useCallback((to: To, options?: NavigateOptions) => {
        requestedPaths.push(typeof to === "string" ? to : to.pathname);
        return navigate(to, options);
      }, [navigate]);
    },
  };
});

const previewLifecycle = vi.hoisted(() => ({ mounted: [] as boolean[], unmounted: [] as boolean[] }));
vi.mock("../components/SiteHeader", () => ({ default: () => <header />, STATIC_PAGE_HEADER_STYLE: {} }));
vi.mock("../components/PocketTerminalExperience", () => ({
  POCKET_THEME_ID: "test-theme",
  PocketTerminalExperience: ({ interactive }: { interactive: boolean }) => {
    useEffect(() => {
      previewLifecycle.mounted.push(interactive);
      return () => { previewLifecycle.unmounted.push(interactive); };
    }, [interactive]);
    return <section data-interactive={String(interactive)} />;
  },
}));
vi.mock("../components/NotifySignupForm", () => ({ NotifySignupForm: () => null }));
vi.mock("../components/ShareUrlButton", () => ({ ShareUrlButton: () => null }));
vi.mock("dormouse-lib/components/ThemePicker", () => ({ ThemePicker: () => null }));
vi.mock("dormouse-lib/lib/themes", () => ({ useRestoredTheme: () => {} }));

const desktopRuntime = vi.hoisted(() => ({ imported: vi.fn(), initPlatform: vi.fn() }));
vi.mock("dormouse-lib/lib/platform", () => {
  desktopRuntime.imported();
  return { initPlatform: desktopRuntime.initPlatform };
});
vi.mock("dormouse-lib/lib/terminal-registry", () => ({}));
vi.mock("dormouse-lib/lib/mouse-selection", () => ({}));
vi.mock("dormouse-lib/components/Wall", () => ({}));
vi.mock("dormouse-lib/lib/platform/fake-scenarios", () => ({}));
vi.mock("../lib/ascii-splash-runner", () => ({}));

import PlaygroundDesktop from "./PlaygroundDesktop";
import PocketPlayground from "./PocketPlayground";
import PlaygroundRedirect from "./Playground";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  requestedPaths.length = 0;
  previewLifecycle.mounted.length = 0;
  previewLifecycle.unmounted.length = 0;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

function prerender(children: ReactNode): string {
  vi.stubGlobal("window", undefined);
  try {
    return renderToString(children);
  } finally {
    vi.unstubAllGlobals();
  }
}

function installMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return matches; },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  })));
  return (next: boolean) => {
    matches = next;
    for (const listener of listeners) listener();
  };
}

function createContainer(markup = ""): HTMLDivElement {
  container = document.createElement("div");
  container.innerHTML = markup;
  document.body.append(container);
  return container;
}

describe("Pocket playground hydration", () => {
  it.each([true, false])("hydrates for pocket=%s without regenerating mismatched markup", async (pocket) => {
    const markup = prerender(<PocketPlayground />);
    expect(markup).toContain("Walk away. Keep going.");
    installMedia(pocket);
    const element = createContainer(markup);
    const recoverable = vi.fn();

    await act(async () => {
      root = hydrateRoot(element, <PocketPlayground />, { onRecoverableError: recoverable });
    });

    expect(element.querySelector(`[data-interactive="${pocket}"]`)).not.toBeNull();
    expect(document.body.classList.contains(pocket ? "pocket-terminal-body" : "pocket-marketing-body")).toBe(true);
    expect(recoverable).not.toHaveBeenCalled();
    if (pocket) expect(previewLifecycle.unmounted).toEqual([false]);
  });

  it("updates the page and cleans up the previous experience when media changes", async () => {
    const setPocket = installMedia(false);
    const element = createContainer();
    await act(async () => { root = createRoot(element); root.render(<PocketPlayground />); });

    act(() => setPocket(true));
    expect(element.querySelector('[data-interactive="true"]')).not.toBeNull();
    expect(document.body.classList.contains("pocket-marketing-body")).toBe(false);
    expect(previewLifecycle.unmounted).toEqual([false]);

    act(() => setPocket(false));
    expect(element.querySelector('[data-interactive="false"]')).not.toBeNull();
    expect(document.body.classList.contains("pocket-terminal-body")).toBe(false);
    expect(previewLifecycle.unmounted).toEqual([false, true]);
  });
});

function Destination({ visited }: { visited: string[] }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => { visited.push(location.pathname); }, [location.pathname, visited]);
  return <output>{`${navigationType} ${location.pathname}${location.search}${location.hash}`}</output>;
}

function routingTree(visited: string[]) {
  return (
    <MemoryRouter initialEntries={["/before", "/playground?keep=1#step"]} initialIndex={1}>
      <Routes>
        <Route path="/playground" element={<PlaygroundRedirect />} />
        <Route path="/playground/:device" element={<Destination visited={visited} />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("playground dispatcher", () => {
  it.each([true, false])("hydrates and redirects directly to pocket=%s, preserving URL state", async (pocket) => {
    const visited: string[] = [];
    window.history.replaceState(null, "", "/playground?keep=1#step");
    const tree = routingTree(visited);
    const markup = prerender(tree);
    installMedia(pocket);
    const element = createContainer(markup);
    const recoverable = vi.fn();

    await act(async () => { root = hydrateRoot(element, tree, { onRecoverableError: recoverable }); });

    const path = `/playground/${pocket ? "pocket" : "desktop"}`;
    expect(element.textContent).toBe(`REPLACE ${path}?keep=1#step`);
    expect(visited).toEqual([path]);
    expect(requestedPaths).toEqual([path]);
    expect(recoverable).not.toHaveBeenCalled();
  });
});


describe("desktop playground hydration", () => {
  it("hydrates the phone fallback without loading or initializing the desktop runtime", async () => {
    const tree = <MemoryRouter><PlaygroundDesktop /></MemoryRouter>;
    const markup = prerender(tree);
    expect(markup).not.toContain("This screen is too small");
    installMedia(true);
    const element = createContainer(markup);
    const recoverable = vi.fn();

    await act(async () => {
      root = hydrateRoot(element, tree, { onRecoverableError: recoverable });
      await vi.dynamicImportSettled();
    });

    expect(element.textContent).toContain("This screen is too small");
    expect(element.querySelector('a')?.getAttribute("href")).toBe("/playground/pocket");
    expect(recoverable).not.toHaveBeenCalled();
    expect(desktopRuntime.imported).not.toHaveBeenCalled();
    expect(desktopRuntime.initPlatform).not.toHaveBeenCalled();
  });
});
