import { isRemoteControlMethod, REMOTE_CONTROL_METHODS, unsupportedControlMethodMessage } from 'dor/protocol';
import type { RemoteDevicesResponse, RemoteLogResponse, RemoteRevokeResponse } from 'dor/commands/types';
import { getPlatformOrNull } from '../../lib/platform';
import type {
  AccessLogResult,
  PairedDevicesResult,
  RevokeDeviceParams,
  RevokeDeviceResult,
} from '../../host/remote/service-protocol';
import { stringParam } from './dor-control-shared';
import type { DorControlRequest } from './use-dor-control';

/** What a host with no Burrow link answers — the website playground among them. */
export const REMOTE_UNAVAILABLE = 'remote control is not available in this Dormouse';

/**
 * The `remote.*` verbs (`docs/specs/dor-cli.md` → "dor remote"): the Burrow's
 * paired phones and access log, and its one revocation, relayed over the
 * Burrow link. A Burrow refusal rejects, and the router answers it.
 */
export async function handleRemoteControl(detail: DorControlRequest): Promise<void> {
  // Narrowed before the switch, whose exhaustiveness is then what makes a new
  // remote verb a compile error here.
  if (!isRemoteControlMethod(detail.method)) {
    detail.respond({ ok: false, error: unsupportedControlMethodMessage(detail.method) });
    return;
  }
  const burrow = getPlatformOrNull()?.burrow;
  if (!burrow) {
    detail.respond({ ok: false, error: REMOTE_UNAVAILABLE });
    return;
  }
  switch (detail.method) {
    case REMOTE_CONTROL_METHODS.devices: {
      const { devices } = await burrow.command('pairedDevices') as PairedDevicesResult;
      detail.respond({ ok: true, result: { devices } satisfies RemoteDevicesResponse });
      return;
    }
    case REMOTE_CONTROL_METHODS.revoke: {
      const id = stringParam(detail.params?.id)?.trim();
      if (!id) {
        detail.respond({ ok: false, error: 'Name the paired phone to revoke by its id.' });
        return;
      }
      const params: RevokeDeviceParams = { id, by: 'dor' };
      const { revoked, labels } = await burrow.command('revokeDevice', params) as RevokeDeviceResult;
      detail.respond({ ok: true, result: { revoked, labels } satisfies RemoteRevokeResponse });
      return;
    }
    case REMOTE_CONTROL_METHODS.log: {
      const { entries } = await burrow.command('accessLog') as AccessLogResult;
      detail.respond({ ok: true, result: { entries } satisfies RemoteLogResponse });
      return;
    }
    default: {
      const unhandled: never = detail.method;
      throw new Error(`unhandled remote control method '${String(unhandled)}'`);
    }
  }
}
