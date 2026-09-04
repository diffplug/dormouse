import type { DormouseTheme } from '../../lib/themes';

export function ThemeSwatch({ theme }: { theme: DormouseTheme }) {
  return (
    <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span
        className="block h-3.5 w-3.5 rounded-full border border-border"
        style={{ backgroundColor: theme.swatch }}
      />
      <span
        className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: theme.accent }}
      />
    </span>
  );
}
