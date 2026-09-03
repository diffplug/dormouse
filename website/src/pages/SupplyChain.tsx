import type { ReactNode } from "react";
import { tv } from "tailwind-variants";
import cargoDeps from "../data/dependencies-cargo.json";
import npmDeps from "../data/dependencies-npm.json";
import runtimeDeps from "../data/dependencies-runtime.json";
import DocsLayout from "../components/DocsLayout";
import { LINK_CLASS, SCROLL_MT_CLASS } from "../components/docs-tokens";
import { type MetaArgs } from "react-router";
import { type TocEntry } from "../lib/docs-pages";
import { siteMeta } from "../lib/site-meta";

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

type DirectCargoDependency = PackageDependency & {
  declaredName: string;
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

function EmptyAwareText({ value }: { value: string | null | undefined }) {
  return value ? value : <span className="opacity-45">Unknown</span>;
}

function PackageTable({ deps }: { deps: PackageDependency[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="text-left border-b border-[var(--color-text)]/10">
            <th className="pb-2 pr-4 opacity-70">Package</th>
            <th className="pb-2 pr-4 opacity-70">Version</th>
            <th className="pb-2 pr-4 opacity-70">License</th>
            <th className="pb-2 opacity-70">Author</th>
          </tr>
        </thead>
        <tbody>
          {deps.map((dep) => (
            <tr key={`${dep.name}@${dep.version}`} className="border-b border-[var(--color-text)]/5">
              <td className="py-1.5 pr-4">
                <DependencyName dep={dep} />
              </td>
              <td className="py-1.5 pr-4 opacity-50 font-mono whitespace-nowrap">{dep.version}</td>
              <td className="py-1.5 pr-4 opacity-50 whitespace-nowrap">
                <EmptyAwareText value={dep.license} />
              </td>
              <td className="py-1.5 opacity-50">
                <EmptyAwareText value={dep.author} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DirectCargoTable({ deps }: { deps: DirectCargoDependency[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="text-left border-b border-[var(--color-text)]/10">
            <th className="pb-2 pr-4 opacity-70">Crate</th>
            <th className="pb-2 pr-4 opacity-70">Version</th>
            <th className="pb-2 pr-4 opacity-70">License</th>
            <th className="pb-2 opacity-70">Author</th>
          </tr>
        </thead>
        <tbody>
          {deps.map((dep) => (
            <tr key={`${dep.name}@${dep.version}`} className="border-b border-[var(--color-text)]/5">
              <td className="py-1.5 pr-4">
                <DependencyName dep={dep} />
                {dep.declaredName !== dep.name ? (
                  <div className="font-mono text-xs opacity-45">{dep.declaredName}</div>
                ) : null}
              </td>
              <td className="py-1.5 pr-4 opacity-50 font-mono whitespace-nowrap">{dep.version}</td>
              <td className="py-1.5 pr-4 opacity-50 whitespace-nowrap">
                <EmptyAwareText value={dep.license} />
              </td>
              <td className="py-1.5 opacity-50">
                <EmptyAwareText value={dep.author} />
              </td>
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
    table: <PackageTable deps={runtimeDeps} />,
  },
  {
    id: "npm-dependencies",
    title: "npm Dependencies",
    count: npmDeps.length,
    description:
      "Runtime npm packages used by the Standalone app, the VS Code extension, and the coordinating server you run yourself to pair a phone with your laptop.",
    table: <PackageTable deps={npmDeps} />,
  },
  {
    id: "direct-cargo-dependencies",
    title: "Direct Cargo Dependencies",
    count: cargoDeps.direct.length,
    description:
      "Crates declared directly in standalone/src-tauri/Cargo.toml, including build and target-specific dependencies.",
    table: <DirectCargoTable deps={cargoDeps.direct} />,
  },
  {
    id: "transitive-cargo-dependencies",
    title: "Transitive Cargo Dependencies",
    count: cargoDeps.transitive.length,
    description:
      "Every crate the direct dependencies pull into the locked Tauri build graph, including build-time and platform-specific crates that aren't all linked into the final binary.",
    table: <PackageTable deps={cargoDeps.transitive} />,
  },
];

/** This page's table of contents, off the list that titles its sections. */
export const SUPPLY_CHAIN_TOC: TocEntry[] = SECTIONS.map((section) => ({
  id: section.id,
  text: section.title,
  children: [],
}));

function DependencySection({ section }: { section: SupplyChainSection }) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-col gap-1 border-b border-[var(--color-text)]/10 pb-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-baseline gap-2">
            <h2 id={section.id} className={`${SCROLL_MT_CLASS} font-display text-xl`}>{section.title}</h2>
            <div className="font-mono text-md opacity-50">({section.count})</div>
          </div>
          <p className="text-sm opacity-60 whitespace-pre-line">{section.description}</p>
        </div>
      </div>
      {section.table}
    </section>
  );
}

export default function SupplyChain() {
  return (
    <DocsLayout activePath="/supply-chain" toc={SUPPLY_CHAIN_TOC}>
      <p className="text-base text-[var(--color-text)]/70 mb-2">
        This is the generated inventory of every runtime component Dormouse puts on a
        user&apos;s machine. It is derived from the dependency graph and pinned bundled
        runtime; CI rejects a production-dependency change whose refreshed disclosure is
        missing.
      </p>
      <p className="text-base text-[var(--color-text)]/70 mb-2">
        The{" "}
        <a href="/docs/security#guarantees" className={link()}>
          security page
        </a>
        {" "}explains the dependency cooldown and the release and audit controls behind
        this disclosure. The coordinating server installed by the{" "}
        <a href="/docs/self-host#what-the-installer-does" className={link()}>
          self-host runbook
        </a>
        {" "}is included in this inventory.
      </p>

      <p className="text-base text-[var(--color-text)]/70 mb-2">
        All bundled libraries are listed below. Thank you to every author and contributor.
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
          <div className="opacity-60">npm packages (direct and transitive)</div>
        </div>
        <div>
          <div className="font-mono text-2xl">{cargoDeps.direct.length}</div>
          <div className="opacity-60">Cargo crates (direct)</div>
        </div>
        <div>
          <div className="font-mono text-2xl">{cargoDeps.transitive.length}</div>
          <div className="opacity-60">Cargo crates (transitive)</div>
        </div>
      </div>

      {SECTIONS.map((section) => (
        <DependencySection key={section.id} section={section} />
      ))}
    </DocsLayout>
  );
}
