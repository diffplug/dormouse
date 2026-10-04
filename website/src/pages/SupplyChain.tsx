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
      {/* Fixed columns: under auto layout one long version or SPDX expression
          widened its column for every row and pushed Author out of view. */}
      <table className={`${TABLE_CLASS} min-w-[760px] table-fixed text-sm`}>
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[17%]" />
          <col className="w-[20%]" />
          <col className="w-[33%]" />
        </colgroup>
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
              <td className="py-1.5 pr-4 break-words">
                <DependencyName dep={dep} />
                {dep.declaredName && dep.declaredName !== dep.name ? (
                  <div className={`font-mono text-xs ${MUTED_TEXT_CLASS}`}>{dep.declaredName}</div>
                ) : null}
              </td>
              {/* A row merges every release of one package under one license,
                  so each version gets its own line. */}
              <td className={`py-1.5 pr-4 font-mono ${MUTED_TEXT_CLASS}`}>
                {dep.version.split(", ").map((version) => {
                  // Build metadata (`+spec-1.1.0`) gets its own small line.
                  const [core, ...build] = version.split("+");
                  return (
                    <div key={version}>
                      {core}
                      {build.length > 0 ? <div className="text-xs break-all">+{build.join("+")}</div> : null}
                    </div>
                  );
                })}
              </td>
              {/* The cell already carries the muted colour, so an empty value
                  needs the fallback text and no wrapper of its own. */}
              <td className={`py-1.5 pr-4 ${MUTED_TEXT_CLASS}`}>{dep.license || "Unknown"}</td>
              <td className={`py-1.5 break-words ${MUTED_TEXT_CLASS}`}>{dep.author || "Unknown"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type SupplyChainSection = {
  /** Anchor the rail links, and the heading's id. */
  id: string;
  title: string;
  count: number;
  description: string;
  table: ReactNode;
};

type SupplyChainProduct = {
  /** Anchor the rail links, and the `<h2>`'s id. */
  id: string;
  title: string;
  description: ReactNode;
  sections: readonly SupplyChainSection[];
};

/**
 * The page's products and their inventory sections, in order, matching the
 * generator's sections (website/scripts/generate-deps.js).
 *
 * One owner for the heading a reader sees, the anchor it carries, and the
 * table under it, so the rail cannot name a section the page has renamed or
 * dropped. Anchors are spelled out rather than slugged from the title, so
 * rewording a heading does not silently break a link someone saved; the
 * Terminal's keep the ids they had before the page was split by product.
 */
const PRODUCTS: readonly SupplyChainProduct[] = [
  {
    id: "terminal",
    title: "Dormouse Terminal",
    description:
      "Every install: the VS Code extension or the Standalone app, and the dor CLI they put on each terminal's PATH.",
    sections: [
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
        count: npmDeps.terminal.length,
        description:
          "Runtime npm packages used by the Standalone app, the VS Code extension, and the dor CLI, plus the bundled themes.",
        table: <DependencyTable nameLabel="Package" deps={npmDeps.terminal} />,
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
    ],
  },
  {
    id: "builtin-tools",
    title: "Built-in Tools",
    description:
      "The file viewer and editors behind dor open — Monaco, the Markdown editor, and Mermaid diagrams. They ship with every install, inside the dor CLI, but their code runs only when you open a file with a built-in Tool, in that Tool's frame, whose server hands out only the files you opened (and, for Markdown, images in and below the document's folder).",
    sections: [
      {
        id: "builtin-tools-npm-dependencies",
        title: "npm Dependencies",
        count: npmDeps.builtinTools.length,
        description: "Runtime npm packages of the built-in Tools that the Terminal does not already use.",
        table: <DependencyTable nameLabel="Package" deps={npmDeps.builtinTools} />,
      },
    ],
  },
  {
    id: "relay",
    title: "Self-hosted Relay",
    description: (
      <>
        Installed only if you run your own Relay to pair a phone with your laptop, by the{" "}
        <a href={`${sitePath("/self-host")}#what-the-installer-does`} className={link()}>
          self-host runbook
        </a>
        .
      </>
    ),
    sections: [
      {
        id: "relay-npm-dependencies",
        title: "npm Dependencies",
        count: npmDeps.relay.length,
        description: "Runtime npm packages of the Relay that the sections above do not already list.",
        table: <DependencyTable nameLabel="Package" deps={npmDeps.relay} />,
      },
    ],
  },
];

/**
 * The security spec's rows and bullets for what reaches a user's machine,
 * rendered from `docs.security.json` rather than restated here
 * (docs/specs/website-docs.md -> `/security` spec).
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
  ...PRODUCTS.map((product) => ({
    id: product.id,
    text: product.title,
    // A product with one table needs no entry below its own.
    children: product.sections.length > 1
      ? product.sections.map((section) => ({ id: section.id, text: section.title, children: [] }))
      : [],
  })),
];

function DependencySection({ section }: { section: SupplyChainSection }) {
  return (
    <section className="mt-8">
      <div className="mb-4 flex flex-col gap-1 border-b border-[var(--color-text)]/10 pb-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-baseline gap-2">
            <h3 id={section.id} className={`${SCROLL_MT_CLASS} font-display text-xl`}>{section.title}</h3>
            <div className={`font-mono text-md ${MUTED_TEXT_CLASS}`}>({section.count})</div>
          </div>
          <p className={`text-sm whitespace-pre-line ${MUTED_TEXT_CLASS}`}>{section.description}</p>
        </div>
      </div>
      {section.table}
    </section>
  );
}

function ProductSection({ product }: { product: SupplyChainProduct }) {
  return (
    <section>
      <AnchoredHeading id={product.id}>{product.title}</AnchoredHeading>
      <p className={`text-base mb-2 ${MUTED_TEXT_CLASS}`}>{product.description}</p>
      {product.sections.map((section) => (
        <DependencySection key={section.id} section={section} />
      ))}
    </section>
  );
}

/** One product's headline count in the summary row. */
function ProductCount({ count, title, detail }: { count: number; title: string; detail: string }) {
  return (
    <div>
      <div className="font-mono text-2xl">{count}</div>
      <div>{title}</div>
      <div className={MUTED_TEXT_CLASS}>{detail}</div>
    </div>
  );
}

export default function SupplyChain() {
  return (
    <DocsLayout activePath="/supply-chain" toc={SUPPLY_CHAIN_TOC}>
      <AnchoredHeading id="guarantees">Supply-chain guarantees</AnchoredHeading>
      <p className={`text-base mb-2 ${MUTED_TEXT_CLASS}`}>
        What reaches a machine, and how it gets there, is governed by these rows of the{" "}
        <a href={sitePath("/security")} className={link()}>
          security spec
        </a>
        , rendered from the same source the nightly audit reads. Each row names the spec
        that states the rule and what pins it on every build; the audit that checks all of
        them is described under{" "}
        <a href={`${sitePath("/security")}#how-the-guarantees-are-checked`} className={link()}>
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
        The inventory is split by what you install. Every install gets the Terminal and the
        built-in Tools; the Relay only if you host one yourself. A package an earlier section
        already lists is not repeated.
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
        <ProductCount
          count={npmDeps.terminal.length}
          title="Dormouse Terminal"
          detail={`npm packages, plus ${cargoDeps.direct.length + cargoDeps.transitive.length} Cargo crates and Node.js ${runtimeDeps[0].version}`}
        />
        <ProductCount count={npmDeps.builtinTools.length} title="Built-in Tools" detail="npm packages" />
        <ProductCount count={npmDeps.relay.length} title="Self-hosted Relay" detail="npm packages" />
      </div>

      {PRODUCTS.map((product) => (
        <ProductSection key={product.id} product={product} />
      ))}
    </DocsLayout>
  );
}
