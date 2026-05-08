import { describe, expect, it } from 'vitest';
import { ITERM2_DEVICE_ATTRIBUTES_RESPONSE, TerminalProtocolParser } from './terminal-protocol';

describe('TerminalProtocolParser', () => {
  it('parses and strips standalone terminal bells', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('before\x07after');

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);
  });

  it('collapses repeated standalone terminal bells in one parse batch', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x07before\x07after\x07');

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);
  });

  it('parses and strips OSC 9 notifications', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process(`before\x1b]9;Build finished\x07after`);

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Build finished' } },
    ]);
  });

  it('does not add terminal bell detail for the BEL terminator of a supported OSC notification', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]9;Build finished\x07');

    expect(result.visibleData).toBe('');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Build finished' } },
    ]);
  });

  it('prefers richer OSC notification detail over an extra terminal bell in the same batch', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('before\x1b]9;Build finished\x07\x07after');

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Build finished' } },
    ]);
  });

  it('handles chunked OSC sequences terminated by ST', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]777;notify;Title;Bo')).toEqual({ visibleData: '', events: [] });
    const result = parser.process('dy\x1b\\tail');

    expect(result.visibleData).toBe('tail');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 777', title: 'Title', body: 'Body' } },
    ]);
  });

  it('parses OSC 9;4 progress updates', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]9;4;1;25\x07').events).toEqual([
      { kind: 'progress', progress: { state: 'normal', percent: 25 } },
    ]);
    expect(parser.process('\x1b]9;4;3\x07').events).toEqual([
      { kind: 'progress', progress: { state: 'indeterminate', percent: null } },
    ]);
    expect(parser.process('\x1b]9;4\x07').events).toEqual([
      { kind: 'progress', progress: { state: 'clear', percent: null } },
    ]);
  });

  it('keeps additional OSC 777 semicolons in the body', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]777;notify;Title;one;two;three\x07');

    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 777', title: 'Title', body: 'one;two;three' } },
    ]);
  });

  it('assembles OSC 99 title and body chunks', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]99;i=n1:p=title:d=0;Build \x07').events).toEqual([]);
    expect(parser.process('\x1b]99;i=n1:p=body:d=0;Finished \x07').events).toEqual([]);
    const result = parser.process('\x1b]99;i=n1:p=body:e=1:d=1;c3VjY2Vzc2Z1bGx5\x07');

    expect(result.events).toEqual([
      {
        kind: 'notification',
        notification: { source: 'OSC 99', title: 'Build', body: 'Finished successfully' },
      },
    ]);
  });

  it('responds to OSC 99 support queries with title and body support', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]99;i=n1:p=?;\x07');

    expect(result.visibleData).toBe('');
    expect(result.events).toEqual([
      { kind: 'response', data: '\x1b]99;i=n1:p=?;o=always:p=title,body\x1b\\' },
    ]);
  });

  it('omits invalid or missing ids from OSC 99 support-query responses', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]99;p=?;\x07').events).toEqual([
      { kind: 'response', data: '\x1b]99;p=?;o=always:p=title,body\x1b\\' },
    ]);
    expect(parser.process('\x1b]99;i=bad id:p=?;\x07').events).toEqual([
      { kind: 'response', data: '\x1b]99;p=?;o=always:p=title,body\x1b\\' },
    ]);
  });

  it('passes unsupported OSC sequences through to xterm', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]0;title\x07text');

    expect(result.visibleData).toBe('\x1b]0;title\x07text');
    expect(result.events).toEqual([]);
  });

  it('responds to iTerm2 extended device attribute queries', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process(`before\x1b[>qafter`);

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('buffers split iTerm2 extended device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('before\x1b')).toEqual({ visibleData: 'before', events: [] });
    expect(parser.process('[>')).toEqual({ visibleData: '', events: [] });
    const result = parser.process('qafter');

    expect(result.visibleData).toBe('after');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('buffers split C1 extended device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('before\x9b>')).toEqual({ visibleData: 'before', events: [] });
    const result = parser.process('qafter');

    expect(result.visibleData).toBe('after');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('releases buffered CSI prefixes when they are not device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b[')).toEqual({ visibleData: '', events: [] });
    expect(parser.process('31mred')).toEqual({ visibleData: '\x1b[31mred', events: [] });
  });
});
