import { expect, userEvent, waitFor, within } from "storybook/test";

/** Testing Library does not descend into an iframe from the outer canvas, so
 * this queries the frame's document. It also waits for ResizeObserver before
 * Argos captures: lower account sections must be in the screenshot, not hidden
 * behind an inner-document scrollbar. */
export async function settledFrame(canvasElement: HTMLElement) {
  const iframe = canvasElement.querySelector<HTMLIFrameElement>("iframe[data-hosted-frame]")!;
  await waitFor(() => expect(iframe?.dataset.ready).toBe("true"));
  const document = iframe.contentDocument!;
  await waitFor(() => {
    expect(document.querySelector("[data-hosted-shell]")).not.toBeNull();
    expect(iframe.clientHeight).toBeGreaterThanOrEqual(document.body.scrollHeight);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(iframe.clientWidth);
  });
  return { ...within(document.body), document, iframe, user: userEvent.setup({ document }) };
}
