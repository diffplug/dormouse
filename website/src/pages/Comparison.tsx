/**
 * `/comparison` — Dormouse beside the other ways to run coding agents.
 *
 * Renders `website/src/lib/comparison.tsx`, which owns every claim, and links
 * readers there to suggest a correction or another tool.
 *
 * One tab per alternative, then the table. The open tab rides the URL hash, so
 * the rail's entries and a shared link both open the tab they name.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, QuestionIcon, TildeIcon, XIcon } from "@phosphor-icons/react";
import { type MetaArgs } from "react-router";
import DocsLayout from "../components/DocsLayout";
import {
  ACCENT_BORDER_CLASS,
  ACCENT_TEXT_CLASS,
  BODY_TEXT_CLASS,
  CARD_MUTED_TEXT_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
  NOTE_CLASS,
  MUTED_ACCENT_LINK_CLASS,
  NOTE_MUTED_TEXT_CLASS,
  SCROLL_MT_CLASS,
  STATUS_BAD_TEXT_CLASS,
  STATUS_GOOD_TEXT_CLASS,
  STATUS_MIXED_TEXT_CLASS,
  TABLE_CLASS,
  TABLE_HEAD_ROW_CLASS,
  TABLE_ROW_CLASS,
  TABLE_WRAP_CLASS,
  TH_CLASS,
} from "../components/docs-tokens";
import {
  COMPARISON,
  COMPARISON_SOURCE_PATH,
  TOOLS,
  VERSUS,
  type Cell,
  type Point,
  type Support,
  type Tool,
  type Versus,
} from "../lib/comparison";
import { type TocEntry } from "../lib/docs-pages";
import { siteMeta } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Comparison — Dormouse",
    description:
      "Dormouse beside cmux, herdr, Claude Desktop, and the Codex app: where each runs, how it handles agents, and what it costs.",
  });
}

export const COMPARISON_SOURCE_URL =
  `https://github.com/diffplug/dormouse/blob/main/${COMPARISON_SOURCE_PATH}`;

const TABLE_TAB = { id: "table", label: "Table" };

/** Every tab, in order; the first is the one a bare URL opens. */
const TABS = [...VERSUS.map(({ id, label }) => ({ id, label })), TABLE_TAB];

export const COMPARISON_TOC: TocEntry[] = TABS.map(({ id, label }) => ({ id, text: label, children: [] }));

const SUPPORT: Record<Support, { label: string; Icon: typeof CheckIcon; className: string }> = {
  yes: { label: "Yes", Icon: CheckIcon, className: STATUS_GOOD_TEXT_CLASS },
  partial: { label: "Partly", Icon: TildeIcon, className: STATUS_MIXED_TEXT_CLASS },
  no: { label: "No", Icon: XIcon, className: STATUS_BAD_TEXT_CLASS },
  unknown: { label: "Unknown", Icon: QuestionIcon, className: MUTED_TEXT_CLASS },
};

/** The Dormouse column sits on the card tint, so its muted text takes the
 *  token corrected for that surface. */
const HIGHLIGHT_CLASS = "bg-[var(--color-text)]/[0.04]";

/** The label column stays put while the tool columns scroll under it on a
 *  phone, so it needs the page's own background to cover them. */
const STICKY_CLASS = "sticky left-0 z-[1] bg-[var(--color-bg)]";

function SupportMark({ support }: { support: Support }) {
  const { label, Icon, className } = SUPPORT[support];
  return (
    <span className={`inline-flex ${className}`}>
      <Icon size={18} weight="bold" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function CellContent({ cell, highlighted }: { cell: Cell; highlighted: boolean }) {
  const { support, note } = typeof cell === "string" ? { support: cell, note: undefined } : cell;
  return (
    <>
      <SupportMark support={support} />
      {note ? (
        // A note takes its verdict's colour, which clears AA on the highlight
        // tint too; only an unknown's stays muted.
        <div
          className={`text-xs ${
            support !== "unknown" ? SUPPORT[support].className
              : highlighted ? CARD_MUTED_TEXT_CLASS : MUTED_TEXT_CLASS
          }`}
        >
          {note}
        </div>
      ) : null}
    </>
  );
}

function ToolHeader({ tool, highlighted }: { tool: Tool; highlighted: boolean }) {
  return (
    // Not TH_CLASS: its `whitespace-nowrap` would run the blurb into the next column.
    <th scope="col" className={`px-3 py-2 align-bottom font-display font-normal ${highlighted ? HIGHLIGHT_CLASS : ""}`}>
      {tool.href ? (
        <a href={tool.href} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
          {tool.name}
        </a>
      ) : (
        <span className={ACCENT_TEXT_CLASS}>{tool.name}</span>
      )}
      <div className={`font-sans text-xs ${highlighted ? CARD_MUTED_TEXT_CLASS : MUTED_TEXT_CLASS}`}>
        {tool.blurb}
      </div>
    </th>
  );
}

function ComparisonTable() {
  const highlighted = (tool: Tool) => tool.id === "dormouse";
  return (
    <div className={TABLE_WRAP_CLASS}>
      <table className={`${TABLE_CLASS} min-w-[640px] table-fixed text-sm`}>
        <colgroup>
          <col className="w-32 md:w-[24%]" />
          {TOOLS.map((tool) => (
            <col key={tool.id} />
          ))}
        </colgroup>
        <thead>
          <tr className={TABLE_HEAD_ROW_CLASS}>
            <td className={STICKY_CLASS} />
            {TOOLS.map((tool) => (
              <ToolHeader key={tool.id} tool={tool} highlighted={highlighted(tool)} />
            ))}
          </tr>
        </thead>
        {COMPARISON.map((group) => (
          <tbody key={group.title}>
            <tr>
              <th
                scope="rowgroup"
                className={`${TH_CLASS} ${STICKY_CLASS} pt-6 pb-1 text-base ${MUTED_TEXT_CLASS}`}
              >
                {group.title}
              </th>
              <td colSpan={TOOLS.length} />
            </tr>
            {group.rows.map((row) => (
              <tr key={row.label} className={TABLE_ROW_CLASS}>
                <th scope="row" className={`${STICKY_CLASS} py-2 pr-4 font-normal`}>
                  {row.label}
                </th>
                {TOOLS.map((tool) => (
                  <td
                    key={tool.id}
                    className={`px-3 py-2 align-top ${highlighted(tool) ? HIGHLIGHT_CLASS : ""}`}
                  >
                    <CellContent cell={row.cells[tool.id]} highlighted={highlighted(tool)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function Legend() {
  return (
    <ul className={`mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm ${MUTED_TEXT_CLASS}`}>
      {(Object.keys(SUPPORT) as Support[]).map((support) => (
        <li key={support} className="inline-flex items-center gap-1.5">
          <SupportMark support={support} />
          <span aria-hidden="true">{SUPPORT[support].label}</span>
        </li>
      ))}
    </ul>
  );
}

function SuggestEdit() {
  return (
    <p className={NOTE_CLASS}>
      We wrote this about our own competitors, so read it with that in mind. See something wrong?
      Want to add another tool?{" "}
      <a href={COMPARISON_SOURCE_URL} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
        Let us know
      </a>
      <span className={NOTE_MUTED_TEXT_CLASS}> — every claim on this page is in one file you can edit.</span>
    </p>
  );
}

function PointList({ points }: { points: readonly Point[] }) {
  if (points.length === 0) return null;
  return (
    <ul className={`mb-4 space-y-2 pl-6 list-disc ${BODY_TEXT_CLASS}`}>
      {points.map((point, i) =>
        point && typeof point === "object" && "because" in point ? (
          <li key={i}>
            {point.point}
            <ul className="mt-2 space-y-1 pl-6 list-[circle]">
              {point.because.map((reason, j) => (
                <li key={j}>{reason}</li>
              ))}
            </ul>
          </li>
        ) : (
          <li key={i}>{point}</li>
        ),
      )}
    </ul>
  );
}

function VersusPanel({ versus }: { versus: Versus }) {
  return versus.sections.map((section, i) => (
    <div key={i}>
      <p className="mt-6 mb-3 text-lg leading-relaxed">{section.lead}</p>
      <PointList points={section.points} />
    </div>
  ));
}

/** The tab a hash names, or the first when it names none. */
function tabFromHash(hash: string): string {
  const id = hash.replace(/^#/, "");
  return TABS.some((tab) => tab.id === id) ? id : TABS[0].id;
}

/**
 * WAI-ARIA tabs: arrows and Home/End move between them, and only the open one
 * sits in the tab order. Every panel is rendered, hidden but one, so each id
 * the rail links exists in the prerendered page.
 */
function ComparisonTabs() {
  const [active, setActive] = useState(TABS[0].id);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tablistRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A hash naming a tab — a shared link, or a rail entry on this same page —
    // opens it and brings the tabs into view, since the browser cannot scroll
    // to a panel that was hidden when it looked.
    const followHash = () => {
      const id = tabFromHash(window.location.hash);
      setActive(id);
      if (window.location.hash === `#${id}`) tablistRef.current?.scrollIntoView({ block: "start" });
    };
    followHash();
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, []);

  // On a phone the strip scrolls sideways; keep the open tab in it. Scrolled by
  // hand rather than `scrollIntoView`, which would also move the page.
  useEffect(() => {
    const list = tablistRef.current;
    const tab = tabRefs.current[active];
    if (!list || !tab) return;
    if (tab.offsetLeft < list.scrollLeft || tab.offsetLeft + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2;
    }
  }, [active]);

  const open = (id: string) => {
    setActive(id);
    // Replace rather than push: switching tabs is not navigation worth a Back.
    history.replaceState(null, "", `#${id}`);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const i = TABS.findIndex((tab) => tab.id === active);
    const next = {
      ArrowRight: (i + 1) % TABS.length,
      ArrowLeft: (i - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    open(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  };

  return (
    <>
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Compare Dormouse with"
        onKeyDown={onKeyDown}
        className={`relative mt-8 flex gap-1 overflow-x-auto border-b border-[var(--color-text)]/15 ${SCROLL_MT_CLASS}`}
      >
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={tab.id}
              tabIndex={selected ? 0 : -1}
              onClick={() => open(tab.id)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 font-display text-sm whitespace-nowrap ${
                selected ? `${ACCENT_BORDER_CLASS} ${ACCENT_TEXT_CLASS}` : `border-transparent ${MUTED_ACCENT_LINK_CLASS}`
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {VERSUS.map((versus) => (
        <section
          key={versus.id}
          id={versus.id}
          role="tabpanel"
          aria-labelledby={`tab-${versus.id}`}
          hidden={versus.id !== active}
          className={SCROLL_MT_CLASS}
        >
          <VersusPanel versus={versus} />
        </section>
      ))}
      <section
        id={TABLE_TAB.id}
        role="tabpanel"
        aria-labelledby={`tab-${TABLE_TAB.id}`}
        hidden={TABLE_TAB.id !== active}
        className={`pt-6 ${SCROLL_MT_CLASS}`}
      >
        <ComparisonTable />
        <Legend />
      </section>
    </>
  );
}

export default function Comparison() {
  return (
    <DocsLayout
      activePath="/comparison"
      intro="There are plenty of ways to run coding agents side by side. These are the ones we hear about most."
      toc={COMPARISON_TOC}
    >
      <SuggestEdit />
      <ComparisonTabs />
    </DocsLayout>
  );
}
