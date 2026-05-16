import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState } from 'react';

const HOST_VARS = [
  ['sideBar.background', '--vscode-sideBar-background'],
  ['sideBar.foreground', '--vscode-sideBar-foreground'],
  ['terminal.background', '--vscode-terminal-background'],
  ['terminal.foreground', '--vscode-terminal-foreground'],
  ['list.activeSelectionBackground', '--vscode-list-activeSelectionBackground'],
  ['list.activeSelectionForeground', '--vscode-list-activeSelectionForeground'],
  ['list.inactiveSelectionBackground', '--vscode-list-inactiveSelectionBackground'],
  ['list.inactiveSelectionForeground', '--vscode-list-inactiveSelectionForeground'],
  ['focusBorder', '--vscode-focusBorder'],
] as const;

const SEMANTIC_VARS = [
  ['app bg', '--color-app-bg'],
  ['app fg', '--color-app-fg'],
  ['terminal bg', '--color-terminal-bg'],
  ['terminal fg', '--color-terminal-fg'],
  ['active header bg', '--color-header-active-bg'],
  ['active header fg', '--color-header-active-fg'],
  ['inactive header bg', '--color-header-inactive-bg'],
  ['inactive header fg', '--color-header-inactive-fg'],
  ['door bg', '--color-door-bg'],
  ['door fg', '--color-door-fg'],
  ['focus ring', '--color-focus-ring'],
] as const;

const DYNAMIC_BODY_VARS = [
  ['door bg', '--color-door-bg'],
  ['door fg', '--color-door-fg'],
  ['focus ring', '--color-focus-ring'],
] as const;

type VarRow = readonly [label: string, name: string];
type VarSource = 'computed' | 'body-style';

function useCssVars(rows: readonly VarRow[], source: VarSource) {
  const [values, setValues] = useState<Record<string, string>>({});

  useLayoutEffect(() => {
    let frame = 0;

    const readVars = () => {
      const styles =
        source === 'body-style' ? document.body.style : getComputedStyle(document.body);
      const nextValues: Record<string, string> = {};
      for (const [, name] of rows) {
        nextValues[name] = styles.getPropertyValue(name).trim();
      }
      setValues(nextValues);
    };

    readVars();

    const scheduleRead = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(readVars);
    };

    const observer = new MutationObserver(scheduleRead);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [rows, source]);

  return values;
}

function VarTable({
  rows,
  source = 'computed',
}: {
  rows: readonly VarRow[];
  source?: VarSource;
}) {
  const values = useCssVars(rows, source);

  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border font-mono text-xs">
      {rows.map(([label, name]) => {
        const value = values[name] || 'missing';
        const isMissing = !values[name];

        return (
          <div
            key={name}
            className="grid grid-cols-1 gap-1 bg-app-bg px-3 py-2 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(13rem,1.2fr)_minmax(7rem,0.7fr)] sm:items-center sm:gap-3"
          >
            <span className="text-app-fg">{label}</span>
            <span className="truncate text-muted">{name}</span>
            <span className={isMissing ? 'text-error' : 'text-app-fg'}>{value}</span>
          </div>
        );
      })}
    </div>
  );
}

function Swatch({ label, token }: { label: string; token: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded border border-border bg-app-bg p-2">
      <div
        className="h-8 w-8 shrink-0 rounded border border-border"
        style={{ background: `var(${token})` }}
      />
      <div className="min-w-0">
        <div className="truncate font-medium text-app-fg">{label}</div>
        <div className="truncate font-mono text-xs text-muted">{token}</div>
      </div>
    </div>
  );
}

function ThemeCheck() {
  return (
    <div className="min-h-screen bg-app-bg p-6 font-sans text-app-fg">
      <div className="grid max-w-7xl gap-5">
        <header className="grid gap-1">
          <h1 className="text-lg font-semibold">Storybook Theme Smoke Test</h1>
          <p className="max-w-3xl text-sm text-muted">
            Verifies the resolved VSCode host variables, Dormouse semantic tokens, and dynamic
            palette picks that Storybook injects for isolated stories.
          </p>
        </header>

        <section className="grid gap-3">
          <h2 className="text-sm font-semibold">Chrome Preview</h2>
          <div className="grid overflow-hidden rounded-lg border border-border bg-app-bg shadow-sm md:grid-cols-[1fr_9rem]">
            <div className="grid grid-rows-[auto_1fr]">
              <div className="grid grid-cols-2 text-sm font-medium">
                <div className="bg-header-active-bg px-3 py-2 text-header-active-fg">
                  Active terminal
                </div>
                <div className="bg-header-inactive-bg px-3 py-2 text-header-inactive-fg">
                  Waiting terminal
                </div>
              </div>
              <div className="grid min-h-44 gap-3 bg-terminal-bg p-4 font-mono text-sm text-terminal-fg ring-2 ring-focus-ring ring-inset">
                <div>$ pnpm test</div>
                <div className="text-success">resolver defaults materialized</div>
                <div className="text-muted">dynamic palette published on body</div>
                <div className="text-error">missing tokens render as failures below</div>
              </div>
            </div>
            <aside className="grid content-start gap-2 bg-app-bg p-3">
              <div className="rounded-t-lg bg-door-bg px-3 py-2 text-sm font-medium text-door-fg">
                Door 1
              </div>
              <div className="rounded-t-lg bg-door-bg px-3 py-2 text-sm font-medium text-door-fg">
                Door 2
              </div>
            </aside>
          </div>
        </section>

        <section className="grid gap-3">
          <h2 className="text-sm font-semibold">Semantic Palette</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {SEMANTIC_VARS.map(([label, token]) => (
              <Swatch key={token} label={label} token={token} />
            ))}
          </div>
        </section>

        <section className="grid gap-3 xl:grid-cols-2">
          <div className="grid content-start gap-3">
            <h2 className="text-sm font-semibold">Resolved VSCode Variables</h2>
            <VarTable rows={HOST_VARS} />
          </div>
          <div className="grid content-start gap-3">
            <h2 className="text-sm font-semibold">Dormouse Tokens</h2>
            <VarTable rows={SEMANTIC_VARS} />
          </div>
        </section>

        <section className="grid gap-3">
          <h2 className="text-sm font-semibold">Storybook Dynamic Body Vars</h2>
          <VarTable rows={DYNAMIC_BODY_VARS} source="body-style" />
        </section>
      </div>
    </div>
  );
}

const meta: Meta<typeof ThemeCheck> = {
  title: 'Smoke Test',
  component: ThemeCheck,
};

export default meta;

type Story = StoryObj<typeof ThemeCheck>;

export const Default: Story = {};
