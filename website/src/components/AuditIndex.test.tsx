import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import security from "../data/docs.security.json";
import AuditIndex, { type AuditIndexData } from "./AuditIndex";

const BLOB = "https://github.com/diffplug/dormouse/blob/main";
const INDEX: AuditIndexData = {
  checks: 4,
  domains: [
    {
      name: "local",
      checks: 3,
      specs: [{
        path: "docs/specs/security-local.md",
        url: `${BLOB}/docs/specs/security-local.md`,
        checks: 3,
        sections: [
          { title: "Terminal output", url: `${BLOB}/docs/specs/security-local.md#terminal-output`, checks: 2 },
          { title: "Persisted state", url: `${BLOB}/docs/specs/security-local.md#persisted-state`, checks: 1 },
        ],
      }],
    },
    {
      name: "supply-chain",
      checks: 1,
      specs: [{
        path: "docs/specs/security-supply-chain.md",
        url: `${BLOB}/docs/specs/security-supply-chain.md`,
        checks: 1,
        sections: [{ title: "Disclosure", url: `${BLOB}/docs/specs/security-supply-chain.md#disclosure`, checks: 1 }],
      }],
    },
  ],
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

it("totals the checks, then lists each domain with its specs and every section linked", () => {
  const html = renderToStaticMarkup(<AuditIndex index={INDEX} />);
  const shown = text(html);
  expect(shown).toContain("4 audited checks in 3 sections of 2 specs");
  expect(shown).toMatch(/local security-local\.md 3 checks/);
  expect(shown).toMatch(/supply-chain security-supply-chain\.md 1 check\b/);
  for (const domain of INDEX.domains) {
    for (const spec of domain.specs) {
      expect(html).toContain(`href="${spec.url}"`);
      for (const section of spec.sections) expect(html).toContain(`href="${section.url}"`);
    }
  }
  expect(html.match(/<details>/g)).toHaveLength(2);
});

it("renders the generated index", () => {
  const shown = text(renderToStaticMarkup(<AuditIndex index={security.auditIndex} />));
  expect(shown).toContain(`${security.auditIndex.checks} audited checks`);
});
