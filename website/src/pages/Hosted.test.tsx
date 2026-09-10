/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page's own chrome is checked elsewhere (website/src/lib/docs-rail.test.tsx);
// mounting it here only needs the layout to render its children.
vi.mock("../components/SiteHeader", () => ({ default: () => <header />, STATIC_PAGE_HEADER_STYLE: {} }));
vi.mock("../components/DocsThemeControl", () => ({ default: () => null }));
vi.mock("dormouse-lib/lib/themes", () => ({
  useRestoredTheme: () => {},
  getAppliedThemeSnapshot: () => null,
  subscribeToActiveTheme: () => () => {},
}));

const { default: Hosted } = await import("./Hosted");
const { COHORT_SEATS_ENDPOINT } = await import("../lib/hosted-cohorts");
const { cohortSize, tiersOnSale, LIST_ANNUAL } = await import("../lib/hosted-pricing");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Mounts the page with `fetch` answering the seat endpoint however `respond` says. */
async function mount(respond: (url: string) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => respond(String(input))));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Hosted />);
  });
  return container;
}

const buyButtons = (el: HTMLElement) =>
  [...el.querySelectorAll('button[aria-label^="Buy "]')] as HTMLButtonElement[];

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("what the Hosted page prerenders", () => {
  let markup = "";
  beforeEach(() => {
    // `renderToString`, the renderer the prerender itself uses, minus the
    // `<!-- -->` markers it puts between adjacent text nodes: this asserts on
    // the HTML that actually ships, not on a tidier rendering of it.
    markup = renderToString(<Hosted />).replace(/<!-- -->/g, "");
  });

  it("prints every on-sale tier's price without the billing provider", () => {
    const tiers = tiersOnSale();
    expect(tiers.length).toBeGreaterThan(0);
    for (const tier of tiers) {
      expect(markup).toContain(tier.name);
      expect(markup).toContain(`$${tier.price}`);
    }
    // Exactly one tier is marked out, so the recommendation stays a
    // recommendation (docs/specs/pricing.md -> Tiers).
    expect(tiers.filter((tier) => tier.recommended)).toHaveLength(1);
    expect(markup.match(/Recommended/g)).toHaveLength(1);
  });

  it("states the refund beside every buy button", () => {
    // Matched on the label rather than the visible text: the button reads
    // "Buy", and the tier it buys is on its aria-label.
    const buys = markup.match(/aria-label="Buy [^"]+"/g) ?? [];
    expect(buys).toHaveLength(tiersOnSale().length);
    expect(markup.match(/30-day refund/g)).toHaveLength(buys.length);
  });

  it("strikes the list price the founding ladder is read against", () => {
    expect(markup).toContain(`<s>$${LIST_ANNUAL}</s>`);
  });

  it("shows no counter until one is fetched", () => {
    // A prerendered count would be stale the moment a seat sold, and the
    // provider is not consulted at build time at all.
    expect(markup).not.toMatch(/left at this price/);
  });

  it("carries the FAQ and the free-forever promise as text, not as script", () => {
    for (const phrase of [
      "Refunds and cancellation?",
      "What if Dormouse Hosted shuts down?",
      "Do you sell team or enterprise plans?",
      "Self-hosting stays free",
      "FSL-1.1-MIT",
    ]) {
      expect(markup).toContain(phrase);
    }
  });

  it("republishes each tier's current price as an Offer", () => {
    const script = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(markup);
    expect(script).not.toBeNull();
    const data = JSON.parse(script![1].replace(/\\u003c/g, "<"));
    expect(data["@type"]).toBe("Product");
    expect(data.offers.map((offer: { name: string; price: string }) => [offer.name, offer.price]))
      .toEqual(tiersOnSale().map((tier) => [tier.name, String(tier.price)]));
    // Nothing takes payment yet, so the one claim the page must not make is
    // that these are in stock.
    for (const offer of data.offers) expect(offer.availability).toBe("https://schema.org/PreOrder");
  });
});

describe("the cohort counters", () => {
  it("fill in after hydration for the open cohort only", async () => {
    const seats = { "founding-annual": 73 };
    const el = await mount(async (url) => {
      expect(url).toBe(COHORT_SEATS_ENDPOINT);
      return new Response(JSON.stringify(seats), { status: 200 });
    });
    expect(el.textContent).toContain(`73 of ${cohortSize("founding-annual")} left at this price`);
    // The permanent ladder said nothing, so its row shows nothing rather than
    // a zero or a guess.
    expect(el.textContent?.match(/left at this price/g)).toHaveLength(1);
  });

  it("render the table without counts when the provider is unreachable", async () => {
    const el = await mount(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(el.textContent).not.toContain("left at this price");
    // The prices are prerendered, so an outage costs the page nothing it sells.
    expect(el.textContent).toContain(`$${tiersOnSale()[0].price}`);
    expect(buyButtons(el)).toHaveLength(tiersOnSale().length);
  });

  it("ignore a body that is not a whole seat count", async () => {
    const el = await mount(async () =>
      new Response(JSON.stringify({ "founding-annual": "lots" }), { status: 200 }));
    expect(el.textContent).not.toContain("left at this price");
  });
});

describe("the buy buttons", () => {
  const openFirst = async () => {
    const el = await mount(async () => new Response("{}", { status: 404 }));
    const button = buyButtons(el)[0];
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return el;
  };

  it("say checkout is unbuilt rather than failing silently", async () => {
    const el = await openFirst();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("TODO");
    expect(dialog?.textContent).toContain("Checkout is not wired up yet");
    expect(dialog?.textContent).toContain(tiersOnSale()[0].name);
    expect(dialog?.textContent).toContain("You have not been charged");
    expect(el.textContent).toContain("Checkout is not open yet");
  });

  it("close on Escape", async () => {
    await openFirst();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
