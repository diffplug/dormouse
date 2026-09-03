import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SecurityDocs from "./SecurityDocs";
import SelfHostDocs from "./SelfHostDocs";
import SupplyChain from "./SupplyChain";

const PAGES = [
  {
    route: "/docs/security",
    element: <SecurityDocs />,
    links: ["/supply-chain", "/docs/self-host"],
  },
  {
    route: "/supply-chain",
    element: <SupplyChain />,
    links: ["/docs/security#guarantees", "/docs/self-host#what-the-installer-does"],
  },
  {
    route: "/docs/self-host",
    element: <SelfHostDocs />,
    links: ["/docs/security", "/supply-chain"],
  },
] as const;

describe("security-adjacent documentation", () => {
  for (const page of PAGES) {
    it(`${page.route} links contextually to the other two pages`, () => {
      const markup = renderToStaticMarkup(page.element);
      for (const href of page.links) expect(markup).toContain(`href="${href}"`);
    });
  }
});
