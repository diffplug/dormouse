// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { QuitConfirmModal } from "./QuitConfirmModal";

/**
 * The dialog's copy, at the one place it depends on something other than the
 * running count (`docs/specs/standalone.md` → "Quit flow", Confirmation
 * dialog). No JSX: the standalone suite has no React transform, and this needs
 * none.
 */
function render(props: Parameters<typeof QuitConfirmModal>[0]): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(QuitConfirmModal, props)); });
  const text = document.body.textContent ?? "";
  act(() => { root.unmount(); });
  host.remove();
  return text;
}

describe("QuitConfirmModal copy", () => {
  it("warns that closing discards the update this window is holding", () => {
    const text = render({
      confirming: false,
      intent: { kind: "close-window", windowName: "Deploys", discardsUpdate: true },
    });
    expect(text).toContain("Close this window?");
    expect(text).toContain("The downloaded update will be discarded.");
  });

  it("says nothing about an update otherwise", () => {
    expect(render({ confirming: false, intent: { kind: "close-window" } }))
      .not.toContain("downloaded update");
    // A quit installs it rather than discarding it, so the line never applies.
    expect(render({ confirming: false, intent: { kind: "quit" } }))
      .not.toContain("downloaded update");
  });
});
