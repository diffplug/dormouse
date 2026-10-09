/** @vitest-environment jsdom */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPARISON_SOURCE_PATH } from "../lib/comparison";
import Comparison, { COMPARISON_TOC } from "./Comparison";

vi.mock("../components/DocsLayout", () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

function prerender() {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Comparison />);
  document.body.appendChild(container);
  return container;
}

describe("comparison page", () => {
  it("sends readers to the file that owns the table", () => {
    // The "let us know" link is built from this path; a move would 404 it.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    expect(existsSync(resolve(repoRoot, COMPARISON_SOURCE_PATH))).toBe(true);
  });

  it("keeps every comparison and the table visible and labeled without JavaScript", () => {
    const container = prerender();
    expect(container.querySelector<HTMLElement>('[role="tablist"]')?.hidden).toBe(true);
    for (const { id, text } of COMPARISON_TOC) {
      const section = container.querySelector<HTMLElement>(`section[id="${id}"]`)!;
      expect(section, id).not.toBeNull();
      expect(section.closest("[hidden]"), id).toBeNull();
      const heading = document.getElementById(section.getAttribute("aria-labelledby")!);
      expect(heading?.textContent).toBe(text);
      expect(heading?.closest("[hidden]")).toBeNull();
    }
    expect(container.querySelector("table")?.closest("[hidden]")).toBeNull();
  });

  it.each(["", "#table"])("enhances the static sections into working tabs at '%s'", async (hash) => {
    history.replaceState(null, "", `/${hash}`);
    const container = prerender();
    const scroll = vi.fn();
    Object.defineProperty(container.querySelector('[role="tablist"]'), "scrollIntoView", { value: scroll });
    const recover = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, <Comparison />, { onRecoverableError: recover });
    });
    const visiblePanel = () => container.querySelector('[role="tabpanel"]:not([hidden])')?.id;
    expect(recover).not.toHaveBeenCalled();
    expect(visiblePanel()).toBe(hash ? "table" : COMPARISON_TOC[0].id);
    expect(container.querySelector<HTMLElement>('[role="tablist"]')?.hidden).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(hash ? 1 : 0);

    act(() => container.querySelector<HTMLButtonElement>("#tab-vs-herdr")!.click());
    expect(visiblePanel()).toBe("vs-herdr");
    expect(location.hash).toBe("#vs-herdr");

    act(() => {
      history.replaceState(null, "", "#vs-tmux");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(visiblePanel()).toBe("vs-tmux");
  });
});
