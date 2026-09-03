/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@phosphor-icons/react", () => ({ XIcon: () => null }));
vi.mock("dormouse-lib/components/ThemePicker", () => ({
  ThemePicker: () => <button type="button">Theme picker</button>,
}));

import DocsThemeControl from "./DocsThemeControl";
import { dismissThemePrompt } from "../lib/docs-theme";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
  vi.restoreAllMocks();
});

function prerender(): string {
  // The real prerender runs in Node, which has no localStorage at all. jsdom
  // always provides one, so without this the helper never reproduces the
  // disagreement between the prerendered markup and the first client render.
  vi.stubGlobal("localStorage", undefined);
  try {
    return renderToString(<DocsThemeControl />);
  } finally {
    vi.unstubAllGlobals();
  }
}

async function hydrate(markup: string): Promise<HTMLDivElement> {
  container = document.createElement("div");
  container.innerHTML = markup;
  document.body.appendChild(container);
  await act(async () => {
    root = hydrateRoot(container!, <DocsThemeControl />);
  });
  return container;
}

describe("DocsThemeControl hydration", () => {
  it("does not flash or mismatch a prompt the reader already dismissed", async () => {
    dismissThemePrompt();
    const markup = prerender();
    expect(markup).not.toContain('role="status"');
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const hydrated = await hydrate(markup);

    expect(hydrated.querySelector('[role="status"]')).toBeNull();
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/hydration/i);
  });

  it("reveals the prompt after hydration for a new reader", async () => {
    const markup = prerender();
    expect(markup).not.toContain('role="status"');

    const hydrated = await hydrate(markup);

    expect(hydrated.querySelector('[role="status"]')?.textContent).toContain("Don't like the colors?");
  });
});
