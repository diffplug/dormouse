import { createConnection } from 'node:net';
import type { ControlClient, ListSurfacesRequest, ListSurfacesResponse } from './cli.js';

export interface SocketControlClientOptions {
  socketPath: string;
  token: string;
  surfaceId?: string;
  timeoutMs?: number;
}

interface SocketResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

export class SocketControlClient implements ControlClient {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly surfaceId: string | undefined;
  private readonly timeoutMs: number;
  private nextRequestId = 0;

  constructor(options: SocketControlClientOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.surfaceId = options.surfaceId;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  listSurfaces(request: ListSurfacesRequest): Promise<ListSurfacesResponse> {
    return this.request<ListSurfacesResponse>('surface.list', request);
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const requestId = `dor-${++this.nextRequestId}`;
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
            const response = JSON.parse(line) as SocketResponse<T>;
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
