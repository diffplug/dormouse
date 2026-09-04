import type { ReactNode } from "react";
import { tv } from "tailwind-variants";
import cargoDeps from "../data/dependencies-cargo.json";
import npmDeps from "../data/dependencies-npm.json";
import runtimeDeps from "../data/dependencies-runtime.json";
import DocsLayout from "../components/DocsLayout";
import {
  LINK_CLASS,
  MUTED_TEXT_CLASS,
  SCROLL_MT_CLASS,
  TABLE_CLASS,
  TABLE_HEAD_ROW_CLASS,
  TABLE_ROW_CLASS,
  TABLE_WRAP_CLASS,
  TH_CLASS,
} from "../components/docs-tokens";
import MarkdownDocument, { AnchoredHeading, type BlockNode } from "../components/MarkdownDocument";
import security from "../data/docs.security.json";
import { type MetaArgs } from "react-router";
import { type TocEntry } from "../lib/docs-pages";
import { siteMeta, sitePath } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Supply chain — Dormouse",
    description:
      "Every dependency Dormouse ships, with its version, license, and author, generated from the lockfiles.",
  });
}

// Wrapped in `tv()` so the tables can compose it. The docs recipe, not the
// site's caramel: this page follows the reader's theme, where caramel drops
// below WCAG AA (website/src/components/docs-tokens.ts).
const link = tv({ base: LINK_CLASS });

type PackageDependency = {
  name: string;
  version: string;
  license: string | null;
  author: string | null;
  homepage: string | null;
};

function DependencyName({ dep }: { dep: PackageDependency }) {
  if (!dep.homepage) return dep.name;

  return (
    <a
      href={dep.homepage}
      className={link()}
      target="_blank"
      rel="noopener noreferrer"
    >
      {dep.name}
    </a>
  );
}

/** `declaredName` differs from `name` only when a Cargo manifest renames the
 *  crate; every other source leaves it undefined. */
function DependencyTable({
  nameLabel,
  deps,
}: {
  nameLabel: string;
  deps: readonly (PackageDependency & { declaredName?: string })[];
}) {
  return (
    <div className={TABLE_WRAP_CLASS}>
      <table className={`${TABLE_CLASS} min-w-[760px] text-sm`}>
        <thead>
          <tr className={TABLE_HEAD_ROW_CLASS}>
            <th className={TH_CLASS}>{nameLabel}</th>
            <th className={TH_CLASS}>Version</th>
            <th className={TH_CLASS}>License</th>
            <th className={TH_CLASS}>Author</th>
          </tr>
        </thead>
        <tbody>
          {deps.map((dep) => (
            <tr key={`${dep.name}@${dep.version}`} className={TABLE_ROW_CLASS}>
              <td className="py-1.5 pr-4">
                <DependencyName dep={dep} />
                {dep.declaredName && dep.declaredName !== dep.name ? (
                  <div className={`font-mono text-xs ${MUTED_TEXT_CLASS}`}>{dep.declaredName}</div>
                ) : null}
              </td>
              <td className={`py-1.5 pr-4 font-mono whitespace-nowrap ${MUTED_TEXT_CLASS}`}>{dep.version}</td>
              {/* The cell already carries the muted colour, so an empty value
                  needs the fallback text and no wrapper of its own. */}
              <td className={`py-1.5 pr-4 whitespace-nowrap ${MUTED_TEXT_CLASS}`}>{dep.license || "Unknown"}</td>
              <td className={`py-1.5 ${MUTED_TEXT_CLASS}`}>{dep.author || "Unknown"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type SupplyChainSection = {
  /** Anchor the rail links, and the `<h2>`'s id. */
  id: string;
  title: string;
  count: number;
  description: string;
  table: ReactNode;
};

/**
 * The page's sections, in order.
 *
 * One owner for the heading a reader sees, the anchor it carries, and the
 * table under it, so the rail cannot name a section the page has renamed or
 * dropped. Anchors are spelled out rather than slugged from the title, so
 * rewording a heading does not silently break a link someone saved.
 */
const SECTIONS: readonly SupplyChainSection[] = [
  {
    id: "bundled-runtime",
    title: "Bundled Runtime",
    count: runtimeDeps.length,
    description:
      "The Standalone app ships a bundled NodeJS, which bundles other components under their own licenses.\nThe VS Code extension bundles no runtime — it runs on the editor's own Electron Node.",
    table: <DependencyTable nameLabel="Package" deps={runtimeDeps} />,
  },
  {
    id: "npm-dependencies",
    title: "npm Dependencies",
    count: npmDeps.length,
    description:
      "Runtime npm packages used by the Standalone app, the VS Code extension, and the coordinating server you run yourself to pair a phone with your laptop.",
    table: <DependencyTable nameLabel="Package" deps={npmDeps} />,
  },
  {
    id: "direct-cargo-dependencies",
    title: "Direct Cargo Dependencies",
    count: cargoDeps.direct.length,
    description:
      "Crates declared directly in standalone/src-tauri/Cargo.toml, including build and target-specific dependencies.",
    table: <DependencyTable nameLabel="Crate" deps={cargoDeps.direct} />,
  },
  {
    id: "transitive-cargo-dependencies",
    title: "Transitive Cargo Dependencies",
    count: cargoDeps.transitive.length,
    description:
      "Every crate the direct dependencies pull into the locked Tauri build graph, including build-time and platform-specific crates that aren't all linked into the final binary.",
    table: <DependencyTable nameLabel="Package" deps={cargoDeps.transitive} />,
  },
];

/**
 * The security spec's rows and bullets for what reaches a user's machine,
 * rendered from `docs.security.json` rather than restated here
 * (docs/specs/website-docs.md -> `/docs/security` spec).
 */
const CONTRACT = security.audiences["supply-chain"];

/** The spec's subsections this page shows, each only while it has something to say. */
const CONTRACT_SECTIONS = [
  { id: "not-defended", text: "What is not defended", block: CONTRACT.notDefended },
  { id: "known-gaps", text: "Known gaps", block: CONTRACT.knownGaps },
].filter((section) => section.block.items.length > 0);

/** This page's table of contents, off the list that titles its inventory sections. */
export const SUPPLY_CHAIN_TOC: TocEntry[] = [
  {
    id: "guarantees",
    text: "Supply-chain guarantees",
    children: CONTRACT_SECTIONS.map(({ id, text }) => ({ id, text, children: [] })),
  },
  ...SECTIONS.map((section) => ({
    id: section.id,
    text: section.title,
    children: [],
  })),
];

function DependencySection({ section }: { section: SupplyChainSection }) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-col gap-1 border-b border-[var(--color-text)]/10 pb-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-baseline gap-2">
            <h2 id={section.id} className={`${SCROLL_MT_CLASS} font-display text-xl`}>{section.title}</h2>
            <div className={`font-mono text-md ${MUTED_TEXT_CLASS}`}>({section.count})</div>
          </div>
          <p className={`text-sm whitespace-pre-line ${MUTED_TEXT_CLASS}`}>{section.description}</p>
        </div>
      </div>
      {section.table}
    </section>
  );
}

export default function SupplyChain() {
  return (
    <DocsLayout activePath="/supply-chain" toc={SUPPLY_CHAIN_TOC}>
      <AnchoredHeading id="guarantees">Supply-chain guarantees</AnchoredHeading>
      <p className={`text-base mb-2 ${MUTED_TEXT_CLASS}`}>
        What reaches a machine, and how it gets there, is governed by these rows of the{" "}
        <a href={sitePath("/docs/security")} className={link()}>
          security spec
        </a>
        , rendered from the same source the nightly audit reads. Each row names the spec
        that states the rule and what pins it on every build; the audit that checks all of
        them is described under{" "}
        <a href={`${sitePath("/docs/security")}#how-the-guarantees-are-checked`} className={link()}>
          how the guarantees are checked
        </a>
        .
      </p>
      <MarkdownDocument blocks={[CONTRACT.guarantees as BlockNode]} />
      {CONTRACT_SECTIONS.map(({ id, text, block }) => (
        <div key={id}>
          <AnchoredHeading id={id} depth={3}>
            {text}
          </AnchoredHeading>
          <MarkdownDocument blocks={[block as BlockNode]} />
        </div>
      ))}
      <p className={`text-base mb-2 ${MUTED_TEXT_CLASS}`}>
        The optional coordinating server — needed only for phone push notifications,
        installed by the{" "}
        <a href={`${sitePath("/docs/self-host")}#what-the-installer-does`} className={link()}>
          self-host runbook
        </a>{" "}
        — is included in the inventory below.
      </p>

      <p className={`text-base mb-2 ${MUTED_TEXT_CLASS}`}>
        Thank you to every author and contributor.
        Thanks also to{" "}
        <a
          href="https://github.com/reowens/ascii-splash"
          className={link()}
          target="_blank"
          rel="noopener noreferrer"
        >
          ascii-splash
        </a>{" "}
        and{" "}
        <a
          href="https://github.com/remix-run/react-router"
          className={link()}
          target="_blank"
          rel="noopener noreferrer"
        >
          react-router
        </a>{" "}
        and their transitive dependencies, which power this marketing site but don't ship in the app, so they're not listed below.
      </p>
      <div className="grid gap-3 border-y border-[var(--color-text)]/10 py-4 text-sm md:grid-cols-3">
        <div>
          <div className="font-mono text-2xl">{npmDeps.length}</div>
          <div className={MUTED_TEXT_CLASS}>npm packages (direct and transitive)</div>
        </div>
        <div>
          <div className="font-mono text-2xl">{cargoDeps.direct.length}</div>
          <div className={MUTED_TEXT_CLASS}>Cargo crates (direct)</div>
        </div>
        <div>
          <div className="font-mono text-2xl">{cargoDeps.transitive.length}</div>
          <div className={MUTED_TEXT_CLASS}>Cargo crates (transitive)</div>
        </div>
      </div>

      {SECTIONS.map((section) => (
        <DependencySection key={section.id} section={section} />
      ))}
    </DocsLayout>
  );
}
