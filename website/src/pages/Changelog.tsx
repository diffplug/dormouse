import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import SiteHeader from "../components/SiteHeader";
import changelog from "../data/changelog.json";

interface ChangelogItem {
  text: string;
  children: ChangelogItem[];
}

interface ChangelogSection {
  title: string;
  items: ChangelogItem[];
}

interface ChangelogRelease {
  version: string;
  tag: string;
  date: string | null;
  sections: ChangelogSection[];
}

interface ChangelogData {
  releases: ChangelogRelease[];
}

const CHANGELOG = changelog as ChangelogData;
const RELEASES = CHANGELOG.releases;
const RELEASE_VERSION_SET = new Set(RELEASES.map((release) => release.version));
const HEADER_STYLE = {
  background: "rgba(10, 10, 10, 0.85)",
  backdropFilter: "blur(12px)",
};

function normalizeVersionParam(version: string) {
  const normalized = version.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }

  return 0;
}

function formatDate(date: string | null) {
  if (!date) return null;

  return new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function renderInlineMarkdown(text: string) {
  const nodes: ReactNode[] = [];
  const inlineToken = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(inlineToken)) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    if (match[1]) {
      nodes.push(
        <code
          key={`code-${key}`}
          className="rounded-sm bg-[var(--color-surface)] px-1 py-0.5 text-[0.9em] text-[var(--color-text)]"
        >
          {match[1]}
        </code>,
      );
    } else if (match[2] && match[3]) {
      nodes.push(
        <a
          key={`link-${key}`}
          href={match[3]}
          className="text-[var(--color-caramel)] hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {match[2]}
        </a>,
      );
    }

    cursor = match.index + match[0].length;
    key += 1;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function ChangelogListItem({ item }: { item: ChangelogItem }) {
  return (
    <li className="pl-1">
      <span>{renderInlineMarkdown(item.text)}</span>
      {item.children.length > 0 ? (
        <ul className="mt-1.5 ml-5 list-disc space-y-1.5 text-[var(--color-text)]/75">
          {item.children.map((child) => (
            <ChangelogListItem key={child.text} item={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ReleaseSection({ section }: { section: ChangelogSection }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 font-display text-base text-[var(--color-caramel)]">
        {section.title}
      </h3>
      <ul className="ml-5 list-disc space-y-2 text-base leading-relaxed text-[var(--color-text)]/85">
        {section.items.map((item) => (
          <ChangelogListItem key={item.text} item={item} />
        ))}
      </ul>
    </section>
  );
}

function ReleaseArticle({ release }: { release: ChangelogRelease }) {
  const date = formatDate(release.date);

  return (
    <article id={release.tag} className="border-t border-[var(--color-text)]/10 py-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h2 className="font-display text-2xl text-[var(--color-text)]">
            {release.tag}
          </h2>
          {date ? (
            <time className="text-sm text-[var(--color-text)]/50" dateTime={release.date ?? undefined}>
              {date}
            </time>
          ) : null}
        </div>
        <Link
          to={`/changelog/after/${release.tag}`}
          className="text-sm text-[var(--color-caramel)] hover:underline"
        >
          Newer than this
        </Link>
      </div>

      {release.sections.map((section) => (
        <ReleaseSection key={section.title} section={section} />
      ))}
    </article>
  );
}

export function Component() {
  const { version: versionParam } = useParams();
  const requestedVersion = versionParam ? normalizeVersionParam(versionParam) : null;
  const baselineVersion =
    requestedVersion && RELEASE_VERSION_SET.has(requestedVersion) ? requestedVersion : null;
  const visibleReleases = baselineVersion
    ? RELEASES.filter((release) => compareVersions(release.version, baselineVersion) > 0)
    : RELEASES;
  const hasInvalidFilter = Boolean(versionParam && !baselineVersion);

  return (
    <>
      <SiteHeader activePath="/changelog" style={HEADER_STYLE} />

      <main className="min-h-screen bg-[var(--color-bg)] px-4 pt-24 pb-16 text-[var(--color-text)] md:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-10">
            <h1 className="mb-2 font-display text-[clamp(1.75rem,3vw+0.5rem,2.75rem)]">
              Changelog
            </h1>
            <p className="text-base leading-relaxed text-[var(--color-text)]/60">
              Release notes for MouseTerm.
            </p>
          </div>

          {baselineVersion ? (
            <div className="mb-8 border-l-2 border-[var(--color-caramel)] pl-4 text-sm text-[var(--color-text)]/75">
              Showing releases newer than v{baselineVersion}.{" "}
              <Link to="/changelog" className="text-[var(--color-caramel)] hover:underline">
                Show all releases.
              </Link>
            </div>
          ) : null}

          {hasInvalidFilter ? (
            <div className="mb-8 border-l-2 border-[var(--color-caramel)] pl-4 text-sm text-[var(--color-text)]/75">
              No such release "{versionParam}".{" "}
              <Link to="/changelog" className="text-[var(--color-caramel)] hover:underline">
                Show all releases.
              </Link>
            </div>
          ) : null}

          {visibleReleases.length > 0 ? (
            <div>
              {visibleReleases.map((release) => (
                <ReleaseArticle key={release.version} release={release} />
              ))}
            </div>
          ) : (
            <div className="border-t border-[var(--color-text)]/10 py-8 text-[var(--color-text)]/60">
              No releases newer than v{baselineVersion}.
            </div>
          )}
        </div>
      </main>
    </>
  );
}
