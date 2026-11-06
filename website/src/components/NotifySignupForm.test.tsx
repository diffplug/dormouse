/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotifySignupForm } from "./NotifySignupForm";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENDPOINT = "https://assets.mailerlite.com/jsonp/2773191/forms/203349323128243736/subscribe";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function mount(props: Parameters<typeof NotifySignupForm>[0] = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<NotifySignupForm {...props} />);
  });
  return container.querySelector<HTMLInputElement>('input[type="email"]')!;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("NotifySignupForm", () => {
  it("posts to the disclosed MailerLite form without JavaScript", () => {
    const markup = renderToStaticMarkup(
      <NotifySignupForm buttonLabel="Get the email" variant="docs" />,
    );
    expect(markup).toContain(`action="${ENDPOINT}"`);
    expect(markup).toContain('method="post"');
    expect(markup).toContain("MailerLite keeps the list");
    expect(markup).toContain("text-[var(--docs-button-text)]");

    const template = document.createElement("template");
    template.innerHTML = markup;
    const form = template.content.querySelector("form")!;
    const input = form.querySelector<HTMLInputElement>('input[type="email"]')!;
    expect(input.name).toBe("fields[email]");
    expect(form.checkValidity()).toBe(false);
    input.value = "invalid-address";
    expect(form.checkValidity()).toBe(false);
    input.value = "dev@example.com";
    expect(form.checkValidity()).toBe(true);
    expect([...new FormData(form)]).toEqual([
      ["ml-submit", "1"],
      ["anticsrf", "true"],
      ["fields[email]", "dev@example.com"],
    ]);
  });

  it("with JavaScript, subscribes in place and says to confirm", async () => {
    const fetch = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);
    const input = await mount();
    type(input, "dev@example.com");
    await submit();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("fields%5Bemail%5D=dev%40example.com&ml-submit=1&anticsrf=true");
    expect(container!.querySelector('[role="status"]')?.textContent).toContain("sent dev@example.com a link to confirm");
    expect(container!.querySelector("form")).toBeNull();
    expect(sessionStorage.getItem("dormouse:notify-email:notify-email")).toBeNull();
  });

  it("keeps the form and shows MailerLite's refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: false, errors: { fields: { email: ["The email field must be a valid email address."] } } }),
      ),
    );
    const input = await mount();
    type(input, "dev@example.com");
    await submit();

    expect(container!.querySelector('[role="alert"]')?.textContent).toBe("The email field must be a valid email address.");
    expect(container!.querySelector("form")).not.toBeNull();
  });

  it("restores a tab-scoped email draft after hydration", async () => {
    sessionStorage.setItem("dormouse:notify-email:hosted-notify-email", "dev@example.com");
    const input = await mount({ emailId: "hosted-notify-email", variant: "docs" });
    expect(input.value).toBe("dev@example.com");

    type(input, "next@example.com");
    expect(sessionStorage.getItem("dormouse:notify-email:hosted-notify-email")).toBe(
      "next@example.com",
    );
  });
});
