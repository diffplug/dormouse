import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HostsView, type HostView } from './App';

const hosts: HostView[] = [
  { hostId: 'host-1', label: 'First laptop', online: true },
  { hostId: 'host-2', label: 'Second laptop', online: true },
];

describe('HostsView push registration', () => {
  it('shows Alerts on only for the Host whose server registration succeeded', () => {
    const html = renderToStaticMarkup(
      <HostsView
        hosts={hosts}
        busy={null}
        error={null}
        isPaired={() => true}
        isPushSubscribed={(hostId) => hostId === 'host-1'}
        pushState="ready"
        needsLocalPasskey={false}
        onRefresh={() => undefined}
        onPair={() => undefined}
        onConnect={() => undefined}
        onEnablePush={() => undefined}
        onSetup={() => undefined}
      />,
    );

    expect(html.match(/Alerts on\./g)).toHaveLength(1);
    expect(html.match(/Enable alerts/g)).toHaveLength(1);
    expect(html.indexOf('Alerts on.')).toBeLessThan(html.indexOf('Second laptop'));
    expect(html.indexOf('Enable alerts')).toBeGreaterThan(html.indexOf('Second laptop'));
  });
});
