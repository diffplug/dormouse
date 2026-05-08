import { describe, it, expect } from 'vitest';
import {
  migrateSessionV1toV2,
  migrateSessionV2toV3,
  readPersistedSession,
  type PersistedSessionV1,
  type PersistedSessionV2,
} from './session-types';

describe('session migration v1 → v2', () => {
  it('migrates a v1 blob with doors to v2, renaming fields', () => {
    const v1: PersistedSessionV1 = {
      version: 1,
      layout: { panels: { 'pane-a': {} } },
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: '/home/ned', scrollback: '$ ls\n', resumeCommand: null, alert: null },
        { id: 'pane-b', title: 'Pane B', cwd: null, scrollback: null, resumeCommand: null },
      ],
      detached: [
        {
          id: 'pane-b',
          title: 'Pane B',
          neighborId: 'pane-a',
          direction: 'right',
          remainingPanelIds: ['pane-a'],
          restoreLayout: { panels: { 'pane-a': {}, 'pane-b': {} } },
          detachedLayoutSignature: 'sig-abc',
        },
      ],
    };

    const v2 = migrateSessionV1toV2(v1);

    expect(v2).toEqual({
      version: 2,
      layout: { panels: { 'pane-a': {} } },
      panes: v1.panes,
      doors: [
        {
          id: 'pane-b',
          title: 'Pane B',
          neighborId: 'pane-a',
          direction: 'right',
          remainingPaneIds: ['pane-a'],
          layoutAtMinimize: { panels: { 'pane-a': {}, 'pane-b': {} } },
          layoutAtMinimizeSignature: 'sig-abc',
        },
      ],
    });
  });

  it('migrates a v1 blob with no detached field to v2 with empty doors', () => {
    const v1: PersistedSessionV1 = {
      version: 1,
      layout: null,
      panes: [{ id: 'pane-a', title: 'Pane A', cwd: null, scrollback: null, resumeCommand: null }],
    };

    const v2 = migrateSessionV1toV2(v1);

    expect(v2.version).toBe(2);
    expect(v2.doors).toEqual([]);
  });
});

describe('session migration v2 → v3', () => {
  it('converts numeric TODO_HARD (2) to boolean true', () => {
    const v2: PersistedSessionV2 = {
      version: 2,
      layout: null,
      panes: [
        {
          id: 'pane-hard',
          title: 'Pane Hard',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW', todo: 2 },
        },
      ],
    };
    const v3 = migrateSessionV2toV3(v2);
    expect(v3.panes[0].alert?.todo).toBe(true);
    expect(v3.version).toBe(3);
  });

  it('converts numeric soft-bucket values ([0,1]) to boolean true', () => {
    const v2: PersistedSessionV2 = {
      version: 2,
      layout: null,
      panes: [
        {
          id: 'pane-soft-full',
          title: 'full',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW', todo: 1 },
        },
        {
          id: 'pane-soft-half',
          title: 'half',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW', todo: 0.5 },
        },
        {
          id: 'pane-soft-zero',
          title: 'zero',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW', todo: 0 },
        },
      ],
    };
    const v3 = migrateSessionV2toV3(v2);
    expect(v3.panes[0].alert?.todo).toBe(true);
    expect(v3.panes[1].alert?.todo).toBe(true);
    expect(v3.panes[2].alert?.todo).toBe(true);
  });

  it('converts TODO_OFF (-1) to boolean false', () => {
    const v2: PersistedSessionV2 = {
      version: 2,
      layout: null,
      panes: [
        {
          id: 'pane-off',
          title: 'off',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW', todo: -1 },
        },
      ],
    };
    const v3 = migrateSessionV2toV3(v2);
    expect(v3.panes[0].alert?.todo).toBe(false);
  });

  it('converts unknown numeric TODO values to boolean false', () => {
    const v2: PersistedSessionV2 = {
      version: 2,
      layout: null,
      panes: [
        {
          id: 'pane-unknown-high',
          title: 'unknown high',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW', todo: 3 },
        },
        {
          id: 'pane-unknown-low',
          title: 'unknown low',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW', todo: -2 },
        },
        {
          id: 'pane-unknown-nan',
          title: 'unknown nan',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW', todo: Number.NaN },
        },
      ],
    };
    const v3 = migrateSessionV2toV3(v2);
    expect(v3.panes[0].alert?.todo).toBe(false);
    expect(v3.panes[1].alert?.todo).toBe(false);
    expect(v3.panes[2].alert?.todo).toBe(false);
  });

  it('preserves panes with null alert', () => {
    const v2: PersistedSessionV2 = {
      version: 2,
      layout: null,
      panes: [
        { id: 'pane-null', title: 'null', cwd: null, scrollback: null, resumeCommand: null, alert: null },
      ],
    };
    const v3 = migrateSessionV2toV3(v2);
    expect(v3.panes[0].alert).toBeNull();
  });
});

describe('readPersistedSession', () => {
  it('returns a v3 blob unchanged', () => {
    const v3 = {
      version: 3 as const,
      layout: null,
      panes: [{ id: 'pane-a', title: 'Pane A', cwd: null, scrollback: null, resumeCommand: null }],
      doors: [],
    };
    expect(readPersistedSession(v3)).toBe(v3);
  });

  it('reads a JSON-stringified v3 blob', () => {
    const v3 = {
      version: 3 as const,
      layout: null,
      panes: [{ id: 'pane-a', title: 'Pane A', cwd: null, scrollback: 'saved output', resumeCommand: null }],
      doors: [],
    };

    expect(readPersistedSession(JSON.stringify(v3))).toEqual(v3);
  });

  it('decodes escaped control bytes in JSON-stringified scrollback', () => {
    const v3 = {
      version: 3 as const,
      layout: null,
      panes: [{ id: 'pane-a', title: 'Pane A', cwd: null, scrollback: '\u001b[31mred', resumeCommand: null }],
      doors: [],
    };

    expect(readPersistedSession(JSON.stringify(v3))?.panes[0].scrollback).toBe('\x1b[31mred');
  });

  it('accepts persisted terminal bell notification detail', () => {
    const v3 = {
      version: 3 as const,
      layout: null,
      panes: [
        {
          id: 'pane-a',
          title: 'Pane A',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: {
            status: 'ALERT_RINGING' as const,
            todo: true,
            notification: { source: 'BEL' as const, title: 'Terminal bell', body: null },
          },
        },
      ],
      doors: [],
    };

    expect(readPersistedSession(v3)).toBe(v3);
  });

  it('migrates a v2 blob on read (numeric TODO → boolean)', () => {
    const v2 = {
      version: 2 as const,
      layout: null,
      panes: [
        {
          id: 'pane-a',
          title: 'Pane A',
          cwd: null,
          scrollback: null,
          resumeCommand: null,
          alert: { status: 'NOTHING_TO_SHOW' as const, todo: 2 },
        },
      ],
      doors: [],
    };
    const result = readPersistedSession(v2);
    expect(result?.version).toBe(3);
    expect(result?.panes[0].alert?.todo).toBe(true);
  });

  it('migrates a v1 blob on read through v2 to v3', () => {
    const v1 = {
      version: 1 as const,
      layout: null,
      panes: [{ id: 'pane-a', title: 'Pane A', cwd: null, scrollback: null, resumeCommand: null }],
      detached: [
        {
          id: 'pane-b',
          title: 'Pane B',
          neighborId: null,
          direction: 'right' as const,
          remainingPanelIds: [],
          restoreLayout: null,
          detachedLayoutSignature: '',
        },
      ],
    };
    const result = readPersistedSession(v1);
    expect(result?.version).toBe(3);
    expect(result?.doors?.[0]).toMatchObject({
      id: 'pane-b',
      remainingPaneIds: [],
      layoutAtMinimize: null,
      layoutAtMinimizeSignature: '',
    });
  });

  it('returns null for malformed or missing blobs', () => {
    expect(readPersistedSession(null)).toBeNull();
    expect(readPersistedSession(undefined)).toBeNull();
    expect(readPersistedSession({ version: 99 })).toBeNull();
    expect(readPersistedSession('not an object')).toBeNull();
    expect(readPersistedSession('{')).toBeNull();
    expect(readPersistedSession(JSON.stringify({ version: 99 }))).toBeNull();
    expect(readPersistedSession({ version: 2, layout: null, panes: 'nope' })).toBeNull();
    expect(readPersistedSession({ version: 2, layout: null, panes: [], doors: {} })).toBeNull();
    expect(readPersistedSession({ version: 1, layout: null, panes: [] as const, detached: {} })).toBeNull();
    expect(readPersistedSession({ version: 1, layout: null, panes: {} })).toBeNull();
  });
});
