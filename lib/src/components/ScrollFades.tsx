/** Overlay a scroll viewport's edges without intercepting its controls. */
export function ScrollFades({ above, below, backgroundColor = 'var(--color-surface-raised)' }: {
  above: boolean;
  below: boolean;
  backgroundColor?: string;
}) {
  return <>{[
    { edge: 'above', shown: above, side: 'top-0', direction: 'to bottom' },
    { edge: 'below', shown: below, side: 'bottom-0', direction: 'to top' },
  ].map(({ edge, shown, side, direction }) => shown ? (
    <div
      key={edge}
      aria-hidden="true"
      data-scroll-fade={edge}
      // 32px: at least twice the inset, so the fade doesn't read as a divider.
      className={`pointer-events-none absolute inset-x-0 h-8 ${side}`}
      style={{ background: `linear-gradient(${direction}, ${backgroundColor}, transparent)` }}
    />
  ) : null)}</>;
}
