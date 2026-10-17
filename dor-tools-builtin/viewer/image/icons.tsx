/** The image editor's toolbar glyphs: 16px, drawn in the current color. */
const paths = {
  select: <path d="M3.5 2.5v10l2.8-2.6 1.9 4.2 1.7-.8-1.9-4.1h3.8z" fill="currentColor" stroke="none" />,
  arrow: <><path d="M3 13 12.5 3.5" /><path d="M7 3h6v6" /></>,
  rect: <rect x="2.5" y="3.5" width="11" height="9" />,
  ellipse: <ellipse cx="8" cy="8" rx="6" ry="4.5" />,
  text: <path d="M3 3.5h10M8 3.5v10M6 13.5h4" />,
  callout: <><circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" /><path d="M7 6.2 8.4 5v6" stroke="var(--ie-icon-knockout)" /></>,
  highlight: <path d="M2.5 11.5 13.5 4.5" strokeWidth="4" strokeOpacity=".45" strokeLinecap="butt" />,
  redact: <><rect x="1.5" y="5" width="13" height="6" fill="currentColor" stroke="none" /></>,
  crop: <path d="M4.5 1v10.5H15M1 4.5h10.5V15" />,
  brush: <><path d="M10.5 2.5l3 3-7 7H3.5v-3z" /><path d="M9 4l3 3" /></>,
  bucket: <><path d="M2.5 8 7.5 3l5 5-5 5z" /><path d="M2.5 8h10" /><path d="M14 10.5c.8 1.2 1 2.5 0 2.5s-.8-1.3 0-2.5z" fill="currentColor" /></>,
  eyedropper: <><path d="M9.5 4.5 3 11v2h2l6.5-6.5" /><path d="M8.5 3.5l4 4M10.5 5.5l2-2a1.4 1.4 0 0 0-2-2l-2 2" /></>,
  marquee: <rect x="2.5" y="3.5" width="11" height="9" strokeDasharray="2 1.6" />,
  lasso: <><path d="M5.5 11.5C2.5 10.5 1.5 8 3 5.5S9 2 12 3.5s2.5 5-1 6.5-4.5.5-5.5 1.5" strokeDasharray="2 1.6" /><path d="M5.5 11.5c-.5 1 0 2.5 1.5 3" /></>,
  seam: <><path d="M1.5 8h13" strokeDasharray="1.5 1.5" /><path d="M8 1.5v4M6 3.5l2-2 2 2M8 14.5v-4M6 12.5l2 2 2-2" /></>,
  ruler: <><path d="M1.5 10.5 10.5 1.5l4 4-9 9z" /><path d="M4.5 7.5l1.5 1.5M6.5 5.5l1 1M8.5 3.5l1.5 1.5" /></>,
  undo: <><path d="M5 3 2 6l3 3" /><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6" /></>,
  redo: <><path d="M11 3l3 3-3 3" /><path d="M13.5 6H6a3.5 3.5 0 0 0 0 7h4" /></>,
  square: <rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" />,
  round: <circle cx="8" cy="8" r="4.5" fill="currentColor" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
};
export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
