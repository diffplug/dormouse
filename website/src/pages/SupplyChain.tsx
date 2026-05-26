import type { ReactNode } from "react";
import { tv } from "tailwind-variants";
import cargoDeps from "../data/dependencies-cargo.json";
import npmDeps from "../data/dependencies-npm.json";
import runtimeDeps from "../data/dependencies-runtime.json";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";

// Single source of truth for caramel links, so links in body copy render at
// the same full brightness as links in the dependency tables. Body copy is
// dimmed with a text-color alpha (text-[…]/70) rather than `opacity`, since
// `opacity` would composite the link along with the surrounding text.
const link = tv({
  base: "text-[var(--color-caramel)] underline-offset-2 hover:underline",
});

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
          <div className="flex items-baseline gap-2">
            <h2 className="font-display text-xl">{title}</h2>
            <div className="font-mono text-md opacity-50">({count})</div>
          </div>
          <p className="text-sm opacity-60 whitespace-pre-line">{description}</p>
        </div>
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
          <p className="text-base text-[var(--color-text)]/70 mb-2">
            Dormouse is a terminal, so users trust it with shells, source trees, credentials, and
            local files. Our security procedures are documented in full (and audited nightly and immediately before every release) in{" "}
            <a
              href={securityPolicyUrl}
              className={link()}
              target="_blank"
              rel="noopener noreferrer"
            >
              SECURITY.md
            </a>, here is a summary:
          </p>
          <ul className="text-base text-[var(--color-text)]/70 mb-2 list-disc space-y-1 pl-5">
            <li>
              We wait at least 24 hours before adopting any newly published dependency.
            </li>
            <li>
              Signing and auto-update secrets for the Standalone app are stored offline, never in CI.
            </li>
            <li>
              Publishing secrets for the VS Code extension are stored in CI locked by two separate maintainer accounts.
            </li>
          </ul>

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

          <DependencySection
            title="Bundled Runtime"
            count={runtimeDeps.length}
            description={"The Standalone app ships a bundled NodeJS, which bundles other components under their own licenses.\nThe VS Code extension bundles no runtime — it runs on the editor's own Electron Node."}
          >
            <PackageTable deps={runtimeDeps} />
          </DependencySection>

          <DependencySection
            title="npm Dependencies"
            count={npmDeps.length}
            description="Runtime npm packages used by both the Standalone app and the VS Code extension."
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
            description="Every crate the direct dependencies pull into the locked Tauri build graph, including build-time and platform-specific crates that aren't all linked into the final binary."
          >
            <PackageTable deps={cargoDeps.transitive} />
          </DependencySection>
        </div>
      </div>
    </>
  );
}
