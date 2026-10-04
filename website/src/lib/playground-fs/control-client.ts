import { MethodControlClient } from "dor/control-methods";
import type { DorControlMethod } from "dor/protocol";
import { cancelDorControlRequest, dispatchDorControlRequest } from "dormouse-lib/lib/platform/dor-control-dispatch";

/** The real CLI's `ControlClient` over the page: each request goes straight to
 * the Wall's `dormouse:control-request` handler, as a host's socket relays it. */
export class PlaygroundControlClient extends MethodControlClient {
  private readonly inFlight = new Set<string>();

  constructor(private readonly surfaceId: string) {
    super();
  }

  protected request<T>(method: DorControlMethod, params: unknown, options?: { timeoutMs?: number }): Promise<T> {
    const requestId = crypto.randomUUID();
    this.inFlight.add(requestId);
    return new Promise<T>((resolve, reject) => {
      dispatchDorControlRequest({
        requestId, surfaceId: this.surfaceId, method, params: params as Record<string, unknown>,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }, ({ ok, result, error }) => {
        this.inFlight.delete(requestId);
        if (ok) resolve(result as T);
        else reject(new Error(error ?? "request failed"));
      });
    });
  }

  /** Abandons every request still waiting, as Ctrl+C does to the real CLI. */
  cancel(): void {
    for (const requestId of this.inFlight) cancelDorControlRequest(requestId);
    this.inFlight.clear();
  }
}
