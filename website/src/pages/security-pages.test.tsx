import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SecurityDocs from "./SecurityDocs";
import SelfHostDocs from "./SelfHostDocs";
import SupplyChain from "./SupplyChain";

function renderMain(element: React.ReactElement): string {
  const markup = renderToStaticMarkup(element);
  const main = markup.match(/<main\b[^>]*>(.*?)<\/main>/s)?.[1];
  expect(main).toBeDefined();
  return main!;
}

const PAGES = [
  {
    route: "/docs/security",
    element: <SecurityDocs />,
    links: ["/supply-chain", "/docs/self-host"],
  },
  {
    route: "/supply-chain",
    element: <SupplyChain />,
    links: [
      "/docs/security#how-the-guarantees-are-checked",
      "/docs/self-host#what-the-installer-does",
    ],
  },
  {
    route: "/docs/self-host",
    element: <SelfHostDocs />,
    links: ["/docs/security#how-the-guarantees-are-checked", "/supply-chain"],
  },
] as const;

describe("security-adjacent documentation", () => {
  for (const page of PAGES) {
    it(`${page.route} links contextually to the other two pages`, () => {
      const main = renderMain(page.element);
      for (const href of page.links) expect(main).toContain(`href="${href}"`);
    });
  }
});

describe("specialized security guidance", () => {
  it("states the supply-chain guarantees on the supply-chain page", () => {
    const markup = renderToStaticMarkup(<SupplyChain />);
    expect(markup).toContain("Every shipped dependency is disclosed.");
    expect(markup).toContain("No newly published dependency is adopted for 24 hours");
    expect(markup).toContain("Desktop signing and update keys never enter CI");
  });

  it("states self-host guarantees and gaps on the self-host page", () => {
    const markup = renderToStaticMarkup(<SelfHostDocs />);
    expect(markup).toContain("Payloads are end-to-end protected.");
    expect(markup).toContain("Only the Host grants access.");
    expect(markup).toContain("The Server sees metadata, not content.");
    expect(markup).toContain("There is no revocation UI or activity audit trail");
  });

  it.each([
    ["supply-chain", <SupplyChain />],
    ["self-host", <SelfHostDocs />],
  ])("links %s prose to Security only for audit methodology", (_, element) => {
    const securityLinks = [...renderMain(element).matchAll(/href="(\/docs\/security[^"]*)"/g)]
      .map(([, href]) => href);
    expect(securityLinks).toEqual(["/docs/security#how-the-guarantees-are-checked"]);
  });
});
