const RELEASE_HEADING_RE = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const SECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^(\s*)-\s+(.*)$/;

function normalizeVersion(version) {
  return version.trim().replace(/^v/i, "");
}

function createRelease(rawVersion, date) {
  const version = normalizeVersion(rawVersion);
  return {
    version,
    tag: `v${version}`,
    date: date ?? null,
    sections: [],
  };
}

function ensureSection(release, title = "Changes") {
  if (!release.sections.length || release.sections[release.sections.length - 1].title !== title) {
    release.sections.push({ title, items: [] });
  }
  return release.sections[release.sections.length - 1];
}

function pushBullet(section, indent, text) {
  const item = { text: text.trim(), children: [] };
  const isNested = indent.replace(/\t/g, "  ").length >= 2;
  const lastTopLevelItem = section.items[section.items.length - 1];

  if (isNested && lastTopLevelItem) {
    lastTopLevelItem.children.push(item);
    return;
  }

  section.items.push(item);
}

function appendContinuation(section, text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  const lastTopLevelItem = section.items[section.items.length - 1];
  if (lastTopLevelItem) {
    lastTopLevelItem.text = `${lastTopLevelItem.text} ${trimmed}`;
    return;
  }

  section.items.push({ text: trimmed, children: [] });
}

export function parseChangelog(markdown) {
  const releases = [];
  let currentRelease = null;
  let currentSection = null;

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const releaseHeading = line.match(RELEASE_HEADING_RE);
    if (releaseHeading) {
      currentRelease = createRelease(releaseHeading[1], releaseHeading[2]);
      releases.push(currentRelease);
      currentSection = null;
      continue;
    }

    if (!currentRelease) continue;

    const sectionHeading = line.match(SECTION_HEADING_RE);
    if (sectionHeading) {
      currentSection = ensureSection(currentRelease, sectionHeading[1].trim());
      continue;
    }

    if (!line.trim()) continue;

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      currentSection = currentSection ?? ensureSection(currentRelease);
      pushBullet(currentSection, bullet[1], bullet[2]);
      continue;
    }

    currentSection = currentSection ?? ensureSection(currentRelease);
    appendContinuation(currentSection, line);
  }

  return { releases };
}
