/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { NotifySignupForm } from "./NotifySignupForm";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  sessionStorage.clear();
});

describe("NotifySignupForm", () => {
  it("submits directly to the disclosed Substack handoff without JavaScript", () => {
    const markup = renderToStaticMarkup(
      <NotifySignupForm buttonLabel="Continue to nedshed.dev" variant="docs" />,
    );
    expect(markup).toContain('action="https://nedshed.dev/subscribe"');
    expect(markup).toContain('method="get"');
    expect(markup).toContain("One more step on Substack");
    expect(markup).toContain("text-[var(--docs-button-text)]");
    expect(markup).not.toContain("Opening nedshed.dev");
  });

  it("restores a tab-scoped email draft after hydration", async () => {
    sessionStorage.setItem("dormouse:notify-email:hosted-notify-email", "dev@example.com");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<NotifySignupForm emailId="hosted-notify-email" variant="docs" />);
    });

    const input = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(input.value).toBe("dev@example.com");

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "next@example.com",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(sessionStorage.getItem("dormouse:notify-email:hosted-notify-email")).toBe(
      "next@example.com",
    );
  });
});
