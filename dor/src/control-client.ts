import { createConnection } from 'node:net';
import type {
  ControlClient,
  EnsureSurfaceRequest,
  EnsureSurfaceResponse,
  IframeSurfaceRequest,
  IframeSurfaceResponse,
  KillSurfaceRequest,
  KillSurfaceResponse,
  ListSurfacesRequest,
  ListSurfacesResponse,
  ReadSurfaceRequest,
  ReadSurfaceResponse,
  SendSurfaceRequest,
  SendSurfaceResponse,
  SplitSurfaceRequest,
  SplitSurfaceResponse,
} from './commands/types.js';
import type { DorControlResult } from './protocol.js';

export interface SocketControlClientOptions {
  socketPath: string;
  token: string;
  surfaceId?: string;
  timeoutMs?: number;
}

export class SocketControlClient implements ControlClient {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly surfaceId: string | undefined;
  private readonly timeoutMs: number;
  private nextRequestId = 0;
  // Each `dor` invocation is its own short-lived process, so a plain counter
  // would emit `dor-1` for every concurrent call and collide in the server's
  // pending map. Mix in a per-process random base so request ids stay unique
  // across simultaneous invocations.
  private readonly idBase = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(options: SocketControlClientOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.surfaceId = options.surfaceId;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  listSurfaces(request: ListSurfacesRequest): Promise<ListSurfacesResponse> {
    return this.request<ListSurfacesResponse>('surface.list', request);
  }

  splitSurface(request: SplitSurfaceRequest): Promise<SplitSurfaceResponse> {
    return this.request<SplitSurfaceResponse>('surface.split', request);
  }

  ensureSurface(request: EnsureSurfaceRequest): Promise<EnsureSurfaceResponse> {
    return this.request<EnsureSurfaceResponse>('surface.ensure', request);
  }

  sendSurface(request: SendSurfaceRequest): Promise<SendSurfaceResponse> {
    return this.request<SendSurfaceResponse>('surface.send', request);
  }

  readSurface(request: ReadSurfaceRequest): Promise<ReadSurfaceResponse> {
    return this.request<ReadSurfaceResponse>('surface.read', request);
  }

  killSurface(request: KillSurfaceRequest): Promise<KillSurfaceResponse> {
    return this.request<KillSurfaceResponse>('surface.kill', request);
  }

  iframeSurface(request: IframeSurfaceRequest): Promise<IframeSurfaceResponse> {
    return this.request<IframeSurfaceResponse>('surface.iframe', request);
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const requestId = `dor-${this.idBase}-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let responseBuffer = '';
      let settled = false;

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        callback();
      };

      const timeout = setTimeout(() => {
        settle(() => reject(new Error(`timed out waiting for ${method}`)));
      }, this.timeoutMs);

      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({
          requestId,
          token: this.token,
          surfaceId: this.surfaceId,
          method,
          params,
        })}\n`);
      });
      socket.on('data', (chunk) => {
        responseBuffer += chunk;
        const newlineIndex = responseBuffer.indexOf('\n');
        if (newlineIndex === -1) return;
        const line = responseBuffer.slice(0, newlineIndex);
        settle(() => {
          try {
            const response = JSON.parse(line) as DorControlResult<T>;
            if (response.ok) {
              resolve(response.result as T);
            } else {
              reject(new Error(response.error || `${method} failed`));
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      socket.on('error', (error) => {
        settle(() => reject(error));
      });
      socket.on('end', () => {
        if (settled) return;
        settle(() => reject(new Error(`connection closed before ${method} response`)));
      });
    });
  }
}
