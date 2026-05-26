import type { ReactNode } from "react";
import cargoDeps from "../data/dependencies-cargo.json";
import npmDeps from "../data/dependencies-npm.json";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";

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

const securityPolicyUrl = "https://github.com/diffplug/dormouse/blob/main/SECURITY.md";

const totalDependencyCount = npmDeps.length + cargoDeps.direct.length + cargoDeps.transitive.length;

function DependencyName({ dep }: { dep: PackageDependency }) {
  if (!dep.homepage) return dep.name;

  return (
    <a
      href={dep.homepage}
      className="text-[var(--color-caramel)] hover:underline"
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
            <th className="pb-2 pr-4 opacity-70">Resolved</th>
            <th className="pb-2 opacity-70">License</th>
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
              <td className="py-1.5 opacity-50 whitespace-nowrap">
                <EmptyAwareText value={dep.license} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DependencySection({
  title,
  count,
  description,
  children,
}: {
  title: string;
  count: number;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-col gap-1 border-b border-[var(--color-text)]/10 pb-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="font-display text-xl">{title}</h2>
          <p className="text-sm opacity-60">{description}</p>
        </div>
        <div className="font-mono text-sm opacity-50">{count} packages</div>
      </div>
      {children}
    </section>
  );
}

export function Component() {
  return (
    <>
      <SiteHeader activePath="/supply-chain" style={STATIC_PAGE_HEADER_STYLE} />

      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] pt-24 pb-16">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <h1 className="font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] mb-2">
            Supply Chain
          </h1>
          <p className="text-base opacity-70 mb-2">
            Dormouse is a terminal, so users trust it with shells, source trees, credentials, and local files.
            The dependency graph and release pipeline is part of the product's security boundary.
          </p>
          <p className="text-base opacity-70 mb-2">
            The dependency policy is documented in{" "}
            <a
              href={securityPolicyUrl}
              className="text-[var(--color-caramel)] underline-offset-2 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              SECURITY.md
            </a>. Thank you to every author and contributor.
          </p>
          <p className="text-base opacity-70 mb-10">
            Thanks also to{" "}
            <a
              href="https://github.com/reowens/ascii-splash"
              className="text-[var(--color-caramel)] underline-offset-2 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              ascii-splash
            </a>{" "}
            and{" "}
            <a
              href="https://github.com/remix-run/react-router"
              className="text-[var(--color-caramel)] underline-offset-2 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              react-router
            </a>{" "}
            and their transitive dependencies, which we use for this marketing page but are not part of the end-user application.
          </p>
          <div className="grid gap-3 border-y border-[var(--color-text)]/10 py-4 text-sm md:grid-cols-3">
            <div>
              <div className="font-mono text-2xl">{npmDeps.length}</div>
              <div className="opacity-60">npm packages</div>
            </div>
            <div>
              <div className="font-mono text-2xl">{cargoDeps.direct.length}</div>
              <div className="opacity-60">direct Cargo crates</div>
            </div>
            <div>
              <div className="font-mono text-2xl">{totalDependencyCount}</div>
              <div className="opacity-60">total listed dependencies</div>
            </div>
          </div>

          <DependencySection
            title="npm Dependencies"
            count={npmDeps.length}
            description="Runtime npm packages used by the standalone app, VS Code extension, and shared terminal UI."
          >
            <PackageTable deps={npmDeps} />
          </DependencySection>

          <DependencySection
            title="Direct Cargo Dependencies"
            count={cargoDeps.direct.length}
            description="Crates declared directly in standalone/src-tauri/Cargo.toml, including build and target-specific dependencies."
          >
            <DirectCargoTable deps={cargoDeps.direct} />
          </DependencySection>

          <DependencySection
            title="Transitive Cargo Dependencies"
            count={cargoDeps.transitive.length}
            description="Crates pulled in by the direct Cargo dependencies in the locked Tauri build graph."
          >
            <PackageTable deps={cargoDeps.transitive} />
          </DependencySection>
        </div>
      </div>
    </>
  );
}
