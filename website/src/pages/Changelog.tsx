import type { ReactNode } from "react";
import { Link, useParams, type MetaArgs } from "react-router";
import DocsLayout from "../components/DocsLayout";
import { ACCENT_TEXT_CLASS } from "../components/docs-tokens";
import changelog from "../data/changelog.json";
import { type TocEntry } from "../lib/docs-pages";
import { siteMeta } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Changelog — Dormouse",
    description: "Every Dormouse release, what changed in it, and when it shipped.",
  });
}

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

const RELEASES = (changelog as ChangelogData).releases;
const INLINE_TOKEN_RE = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
const DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function normalizeVersionParam(version: string) {
  const normalized = version.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

function formatDate(date: string | null) {
  if (!date) return null;
  return DATE_FORMATTER.format(new Date(`${date}T00:00:00Z`));
}

function renderInlineMarkdown(text: string) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    if (match[1]) {
      nodes.push(
        <code
          key={`code-${key}`}
          className="rounded-sm bg-[var(--color-surface)] px-1 py-0.5 text-[var(--color-text)]"
        >
          {match[1]}
        </code>,
      );
    } else if (match[2] && match[3]) {
      nodes.push(
        <a
          key={`link-${key}`}
          href={match[3]}
          className={`${ACCENT_TEXT_CLASS} hover:underline`}
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
      <h3 className={`mb-2 font-display text-base ${ACCENT_TEXT_CLASS}`}>
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
    <article id={release.tag} className="scroll-mt-24 border-t border-[var(--color-text)]/10 py-8">
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
        <a
          href={`https://github.com/diffplug/dormouse/releases/tag/${release.tag}`}
          className={`text-sm ${ACCENT_TEXT_CLASS} hover:underline`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Download from GitHub
        </a>
      </div>

      {release.sections.map((section) => (
        <ReleaseSection key={section.title} section={section} />
      ))}
    </article>
  );
}

/**
 * How many releases the rail lists.
 *
 * The page renders every release; the rail carries four other pages beside
 * this one, and an entry per release would be longer than all of them.
 */
export const CHANGELOG_TOC_RELEASES = 5;

/**
 * This page's table of contents: the most recent releases, newest first.
 *
 * Each entry is anchored on the tag, which is both the id `ReleaseArticle`
 * gives its `<article>` and the text its `<h2>` shows. Pinned by
 * `website/src/pages/Changelog.test.tsx`.
 */
export const CHANGELOG_TOC: TocEntry[] = RELEASES.slice(0, CHANGELOG_TOC_RELEASES).map(
  (release) => ({ id: release.tag, text: release.tag, children: [] }),
);

function FilterNotice({ children }: { children: ReactNode }) {
  return (
    <div className="mb-8 border-l-2 border-[var(--color-caramel)] pl-4 text-sm text-[var(--color-text)]/75">
      {children}{" "}
      <Link to="/changelog" className={`${ACCENT_TEXT_CLASS} hover:underline`}>
        Show all releases.
      </Link>
    </div>
  );
}

export default function Changelog() {
  const { version: versionParam } = useParams();
  const requestedVersion = versionParam ? normalizeVersionParam(versionParam) : null;
  const baselineIndex = requestedVersion
    ? RELEASES.findIndex((release) => release.version === requestedVersion)
    : -1;
  const baselineVersion = baselineIndex >= 0 ? requestedVersion : null;
  const hasInvalidFilter = Boolean(versionParam) && !baselineVersion;
  const visibleReleases = hasInvalidFilter
    ? []
    : baselineVersion
      ? RELEASES.slice(0, baselineIndex)
      : RELEASES;

  return (
    <DocsLayout activePath="/changelog" intro="Release notes for Dormouse." toc={CHANGELOG_TOC}>
      {hasInvalidFilter ? <FilterNotice>No such release "{versionParam}".</FilterNotice> : null}

      {baselineVersion ? (
        <FilterNotice>Showing releases newer than v{baselineVersion}.</FilterNotice>
      ) : null}

      {visibleReleases.map((release) => (
        <ReleaseArticle key={release.version} release={release} />
      ))}

      {baselineVersion && visibleReleases.length === 0 ? (
        <div className="border-t border-[var(--color-text)]/10 py-8 text-[var(--color-text)]/60">
          No releases newer than v{baselineVersion}.
        </div>
      ) : null}
    </DocsLayout>
  );
}
