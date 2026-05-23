import deps from "../data/dependencies-npm.json";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";

export function Component() {
  return (
    <>
      <SiteHeader activePath="/dependencies" style={STATIC_PAGE_HEADER_STYLE} />

      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] pt-24 pb-16">
        <div className="mx-auto max-w-3xl px-4 md:px-6">
          <h1 className="font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] mb-2">
            Dependencies
          </h1>
          <p className="text-base opacity-70 mb-2">
            Dormouse (standalone app and VS Code plugin) has {deps.length} transitive dependencies. Thank you to every author and contributor.
          </p>
          <p className="text-base opacity-70 mb-10">
            Thanks also to <a href="https://github.com/reowens/ascii-splash" className="text-[var(--color-caramel)] underline-offset-2 hover:underline">ascii-splash</a> and <a href="https://github.com/remix-run/react-router" className="text-[var(--color-caramel)] underline-offset-2 hover:underline">react-router</a> and their transitive dependencies, which we use for this marketing page but are not part of the end-user application.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-[var(--color-text)]/10">
                <th className="pb-2 opacity-70">Package</th>
                <th className="pb-2 opacity-70">Version</th>
                <th className="pb-2 opacity-70">License</th>
              </tr>
            </thead>
            <tbody>
              {deps.map((dep) => (
                <tr key={`${dep.name}@${dep.version}`} className="border-b border-[var(--color-text)]/5">
                  <td className="py-1.5 pr-4">
                    {dep.homepage ? (
                      <a
                        href={dep.homepage}
                        className="text-[var(--color-caramel)] hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {dep.name}
                      </a>
                    ) : (
                      dep.name
                    )}
                  </td>
                  <td className="py-1.5 pr-4 opacity-50 font-mono">{dep.version}</td>
                  <td className="py-1.5 opacity-50">{dep.license}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
