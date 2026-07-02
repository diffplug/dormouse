/**
 * The Pocket terminal view: a live xterm rendering of a remote Host pane.
 *
 * Attach-is-the-resize (remote-api.md): on mount we fit xterm to the phone and
 * `surface.attach` with those `cols`/`rows`, which resizes the Host PTY and
 * makes it repaint into our screen from the live stream — no snapshot transfer.
 * Output (`terminal.data`) is base64url PTY bytes we `write` straight into
 * xterm; keystrokes go back as `terminal.write`; a phone rotate/resize re-fits
 * and re-sends `terminal.resize`.
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fromBase64Url, toBase64Url, utf8Encode } from 'server-lib-common';
import '@xterm/xterm/css/xterm.css';
import type { PocketClient } from '../remote/client/pocket-client';

const TERMINAL_THEME = {
  background: '#000000',
  foreground: '#e6e8ec',
  cursor: '#4a9eff',
  selectionBackground: '#264f7860',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

/** Control sequences for the on-screen key bar. */
const KEYS: Array<{ label: string; seq: string; wide?: boolean }> = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\x09' },
  { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: 'enter', seq: '\r', wide: true },
];

export interface PocketTerminalProps {
  client: PocketClient;
  surfaceId: string;
  onBack: () => void;
}

export function PocketTerminal({ client, surfaceId, onBack }: PocketTerminalProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [closed, setClosed] = useState<{ exitCode?: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      theme: TERMINAL_THEME,
      scrollback: 2000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let disposed = false;
    let subId: string | undefined;

    const inputSub = term.onData((data) => {
      void client.write(surfaceId, toBase64Url(utf8Encode(data)));
    });

    client
      .attach(surfaceId, term.cols, term.rows, {
        onData: (bytes) => term.write(fromBase64Url(bytes)),
        onResize: (cols, rows) => term.resize(cols, rows),
        onClosed: (exitCode) => setClosed({ exitCode }),
      })
      .then(({ subId: id, result }) => {
        if (disposed) {
          void client.detach(surfaceId, id);
          return;
        }
        subId = id;
        // Sync xterm to the authoritative PTY size the Host reports back.
        if (result.cols > 0 && result.rows > 0 && (result.cols !== term.cols || result.rows !== term.rows)) {
          term.resize(result.cols, result.rows);
        }
      })
      .catch(() => setClosed({ exitCode: undefined }));

    const onResize = () => {
      if (disposed) return;
      fit.fit();
      void client.resize(surfaceId, term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    // Bring up the on-screen keyboard by focusing xterm's helper textarea.
    term.focus();

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      inputSub.dispose();
      void client.detach(surfaceId, subId);
      term.dispose();
      termRef.current = null;
    };
  }, [client, surfaceId]);

  const sendKey = (seq: string) => {
    void client.write(surfaceId, toBase64Url(utf8Encode(seq)));
    termRef.current?.focus();
  };

  return (
    <>
      <div className="pk-term-wrap">
        <div ref={hostRef} className="pk-term-host" onClick={() => termRef.current?.focus()} />
        {closed ? (
          <div className="pk-term-closed">
            session ended{closed.exitCode !== undefined ? ` (exit ${closed.exitCode})` : ''}
          </div>
        ) : null}
      </div>
      <div className="pk-keybar">
        <button type="button" className="pk-key" onClick={onBack} aria-label="Back to panes">
          ‹
        </button>
        {KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className={`pk-key${key.wide ? ' wide' : ''}`}
            onClick={() => sendKey(key.seq)}
          >
            {key.label}
          </button>
        ))}
      </div>
    </>
  );
}
