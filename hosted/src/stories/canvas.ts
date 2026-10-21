import { expect, userEvent, waitFor, within } from "storybook/test";

/** Testing Library does not descend into an iframe from the outer canvas. */
export async function hostedCanvas(canvasElement: HTMLElement) {
  const iframe = canvasElement.querySelector<HTMLIFrameElement>("iframe[data-hosted-frame]")!;
  await waitFor(() => expect(iframe?.dataset.ready).toBe("true"));
  const document = iframe.contentDocument!;
  await waitFor(() => expect(document.querySelector(".shell")).not.toBeNull());
  return { ...within(document.body), document, iframe, user: userEvent.setup({ document }) };
}

/** Wait for ResizeObserver before Argos captures; lower account sections must
 * be in the screenshot, not hidden behind an inner-document scrollbar. */
export async function settledFrame(canvasElement: HTMLElement) {
  const canvas = await hostedCanvas(canvasElement);
  await waitFor(() => {
    expect(canvas.iframe.clientHeight).toBeGreaterThanOrEqual(canvas.document.body.scrollHeight);
    expect(canvas.document.documentElement.scrollWidth).toBeLessThanOrEqual(canvas.iframe.clientWidth);
  });
  return canvas;
}
