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
const { COHORT_ENDPOINT, MAX_SHOWN_FOUNDERS } = await import("../lib/hosted-cohorts");
const {
  CHECKOUT_OPEN,
  CHECKOUT_PAGE,
  FOUNDING_COHORT_SIZE,
  FOUNDING_COHORTS_CLOSED,
  HOSTED_MONTHLY,
  HOSTED_YEARLY,
  LIST_ANNUAL,
  foundingTier,
  pricingJsonLd,
  tiersOnSale,
} = await import("../lib/hosted-pricing");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Mounts the page with `fetch` answering the seat endpoint however `respond` says. */
async function mount(respond: (url: string) => Promise<Response>, checkoutOpen?: boolean) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => respond(String(input))));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Hosted checkoutOpen={checkoutOpen} />);
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

  it("shows Free, Hosted, and Founding, in that order", () => {
    const order = ["Free", "Hosted", "Founding"].map((name) => markup.indexOf(`>${name}</h3>`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toContain("$0");
  });

  it("prerenders Hosted monthly, with yearly one toggle away", () => {
    expect(markup).toContain(`$${HOSTED_MONTHLY.price}`);
    expect(markup).toContain('aria-label="Buy Hosted monthly"');
    expect(markup).not.toContain('aria-label="Buy Hosted yearly"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Monthly</);
  });

  it("strikes the list price the founding ladder is read against", () => {
    expect(markup).toMatch(new RegExp(`<s [^>]*>\\$${LIST_ANNUAL}</s>`));
    expect(markup).toContain(`$${foundingTier().price}`);
  });

  it("describes both grants as live, never upcoming", () => {
    // docs/specs/pricing.md -> The Hosted page: the boundary notice's pending
    // review is the one qualifier, and it is about the review, not the service.
    expect(markup).not.toMatch(/coming soon|once it ships|when it ships|ships after|not (open )?yet|will run|design target/i);
    expect(markup.match(/Included with any plan/g)).toHaveLength(2);
  });

  it("states the refund beside every buy button", () => {
    const buys = markup.match(/aria-label="Buy [^"]+"/g) ?? [];
    expect(buys).toHaveLength(2);
    expect(markup.match(/30-day refund/g)).toHaveLength(buys.length);
  });

  it("shows no counter and no founders until they are fetched", () => {
    // A prerendered count would be stale the moment a seat sold, and the
    // provider is not consulted at build time at all.
    expect(markup).not.toMatch(/seats left/);
    expect(markup).not.toMatch(/founders? so far/);
  });

  it("carries the FAQ and the free-forever promise as text, not as script", () => {
    for (const phrase of [
      "Refunds and cancellation?",
      "Who appears in the founders row?",
      "What if Dormouse Hosted shuts down?",
      "Do you sell team or enterprise plans?",
      "Self-hosting stays free",
      "FSL-1.1-MIT",
    ]) {
      expect(markup).toContain(phrase);
    }
  });

  it("republishes each paid plan's current price as an Offer", () => {
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

describe("the Hosted card's billing toggle", () => {
  it("switches price and buy target in place", async () => {
    const el = await mount(async () => new Response("{}", { status: 404 }));
    const yearly = [...el.querySelectorAll("button")].find((b) => b.textContent === "Yearly")!;
    await act(async () => {
      yearly.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(yearly.getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector('[aria-label="Buy Hosted yearly"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Buy Hosted monthly"]')).toBeNull();
    expect(el.textContent).toContain(`$${HOSTED_YEARLY.price}/year`);
  });
});

/** Mounts the page with the cohort endpoint answering `body`. */
const mountCohort = (body: unknown) =>
  mount(async (url) => {
    expect(url).toBe(COHORT_ENDPOINT);
    return new Response(JSON.stringify(body), { status: 200 });
  });

describe("the founding card's live half", () => {
  it("fills in the seats left after hydration", async () => {
    const el = await mountCohort({ cohort: FOUNDING_COHORTS_CLOSED, seatsLeft: 73 });
    expect(el.textContent).toContain(`73 of ${FOUNDING_COHORT_SIZE} seats left at $${foundingTier().price}`);
  });

  // A cohort closed since the deploy: the seats are the next price's, not this one's.
  it.each([FOUNDING_COHORTS_CLOSED + 1, undefined, String(FOUNDING_COHORTS_CLOSED)])(
    "drops seats of cohort %j, not the prerendered price's",
    async (cohort) => {
      const el = await mountCohort({ cohort, seatsLeft: 73 });
      expect(el.textContent).not.toContain("seats left");
    },
  );

  it("draws opted-in founders, then +N for everyone else", async () => {
    const el = await mountCohort({
      founders: { total: 12, shown: [{ name: "Ada", avatar: "/api/hosted/founders/ada.png" }, { name: "kim" }] },
    });
    const row = el.querySelector('[aria-label="12 founders so far"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector("img")?.getAttribute("src")).toBe("/api/hosted/founders/ada.png");
    expect(row!.textContent).toContain("K");
    expect(row!.textContent).toContain("+10");
  });

  it("never hotlinks an avatar from another origin", async () => {
    // docs/specs/pricing.md -> The Hosted page: avatars come from this origin.
    const el = await mountCohort({
      founders: {
        total: 3,
        shown: [
          { name: "Gh", avatar: "https://avatars.githubusercontent.com/u/1" },
          { name: "Proto", avatar: "//lh3.googleusercontent.com/a" },
          { name: "Back", avatar: "/\\evil.example/a.png" },
        ],
      },
    });
    expect(el.querySelectorAll("img")).toHaveLength(0);
    expect(el.querySelector('[aria-label="3 founders so far"]')?.textContent).toBe("GPB");
  });

  it("caps the row and folds the rest into +N", async () => {
    const shown = Array.from({ length: MAX_SHOWN_FOUNDERS + 5 }, (_, i) => ({ name: `F${i}` }));
    const el = await mountCohort({ founders: { total: 200, shown } });
    const row = el.querySelector('[aria-label="200 founders so far"]')!;
    expect(row.children).toHaveLength(MAX_SHOWN_FOUNDERS + 1);
    expect(row.textContent).toContain(`+${200 - MAX_SHOWN_FOUNDERS}`);
  });

  it("renders the card without either when the provider is unreachable", async () => {
    const el = await mount(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(el.textContent).not.toContain("seats left");
    expect(el.textContent).not.toMatch(/founders? so far/);
    // The prices are prerendered, so an outage costs the page nothing it sells.
    expect(el.textContent).toContain(`$${foundingTier().price}`);
    expect(buyButtons(el)).toHaveLength(2);
  });

  it("ignores a body that is not a whole count", async () => {
    const el = await mountCohort({ seatsLeft: "lots", founders: { total: -1, shown: [] } });
    expect(el.textContent).not.toContain("seats left");
    expect(el.querySelector("[aria-label$='so far']")).toBeNull();
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
    await openFirst();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("TODO");
    expect(dialog?.textContent).toContain("Checkout is not wired up yet");
    expect(dialog?.textContent).toContain(HOSTED_MONTHLY.name);
    expect(dialog?.textContent).toContain("You have not been charged");
  });

  it("stay closed in the shipped build", () => {
    // Flipped only once billing is on; the notice and `PreOrder` go with it.
    expect(CHECKOUT_OPEN).toBe(false);
  });

  it("link to checkout on the account origin once it opens, by checkout's plan names", async () => {
    const el = await mount(async () => new Response("{}", { status: 404 }), true);
    const links = [...el.querySelectorAll('a[aria-label^="Buy "]')].map((a) => a.getAttribute("href"));
    expect(links).toEqual([`${CHECKOUT_PAGE}?plan=monthly`, `${CHECKOUT_PAGE}?plan=founding`]);
    expect(buyButtons(el)).toHaveLength(0);
    const yearly = [...el.querySelectorAll("button")].find((b) => b.textContent === "Yearly")!;
    await act(async () => {
      yearly.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector('[aria-label="Buy Hosted yearly"]')?.getAttribute("href")).toBe(
      `${CHECKOUT_PAGE}?plan=yearly`,
    );
  });

  it("forward an allowlisted ref into checkout and the cohort read, taking it off the address bar", async () => {
    history.replaceState(null, "", "/hosted/?ref=home#pricing");
    const el = await mount(async () => new Response("{}", { status: 404 }), true);
    const links = [...el.querySelectorAll('a[aria-label^="Buy "]')].map((a) => a.getAttribute("href"));
    expect(links).toEqual([`${CHECKOUT_PAGE}?plan=monthly&ref=home`, `${CHECKOUT_PAGE}?plan=founding&ref=home`]);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([`${COHORT_ENDPOINT}?ref=home`]);
    expect(location.pathname + location.search + location.hash).toBe("/hosted/#pricing");
  });

  it("name an unknown ref on the cohort read alone, never on checkout", async () => {
    history.replaceState(null, "", "/hosted/?ref=ada%40example.test");
    const el = await mount(async () => new Response("{}", { status: 404 }), true);
    const links = [...el.querySelectorAll('a[aria-label^="Buy "]')].map((a) => a.getAttribute("href"));
    expect(links).toEqual([`${CHECKOUT_PAGE}?plan=monthly`, `${CHECKOUT_PAGE}?plan=founding`]);
    // The server counts it as `other`.
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      `${COHORT_ENDPOINT}?ref=ada%40example.test`,
    ]);
    expect(location.search).toBe("");
  });

  it("make the offers InStock only once checkout opens", () => {
    const availability = (open: boolean) =>
      JSON.parse(pricingJsonLd("https://dormouse.sh/hosted", open)).offers.map(
        (offer: { availability: string }) => offer.availability,
      );
    expect(new Set(availability(false))).toEqual(new Set(["https://schema.org/PreOrder"]));
    expect(new Set(availability(true))).toEqual(new Set(["https://schema.org/InStock"]));
  });

  it("close on Escape", async () => {
    await openFirst();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
