import type { DormouseTheme } from '../../lib/themes';
import { themePickerStyles as styles } from './styles';

export function ThemeSwatch({ theme, size }: { theme: DormouseTheme; size: 'sm' | 'md' }) {
  const swatchClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <span className={`relative flex shrink-0 items-center justify-center ${swatchClass}`}>
      <span
        className={`block rounded-full border ${swatchClass}`}
        style={{ ...styles.border, backgroundColor: theme.swatch }}
      />
      <span
        className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: theme.accent }}
      />
    </span>
  );
}
