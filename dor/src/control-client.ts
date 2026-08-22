import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection } from 'node:net';
import type {
  AgentBrowserSurfaceRequest,
  AgentBrowserSurfaceResponse,
  AwaitSurfaceRequest,
  AwaitSurfaceResponse,
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
  ResolveOpenTargetRequest,
  ResolveOpenTargetResponse,
  SendSurfaceRequest,
  SendSurfaceResponse,
  SplitSurfaceRequest,
  SplitSurfaceResponse,
} from './commands/types.js';
import { SURFACE_CONTROL_METHODS, type SurfaceControlMethod } from './protocol.js';
import type { DorControlResult } from './protocol.js';

export interface SocketControlClientOptions {
  socketPath: string;
  token: string;
  surfaceId?: string;
  timeoutMs?: number;
}

// Must match standalone/sidecar/dor-control-server.js, the other half of this
// handshake. The two live in different packages (a bundled ESM CLI and a plain
// CJS module loaded by both hosts) with no shared build, so the constants and
// the proof construction are duplicated rather than imported.
const CLIENT_PROOF_DOMAIN = 'dor-control/client';
const SERVER_PROOF_DOMAIN = 'dor-control/server';

// Deliberately says nothing about which half of the handshake failed: from here
// a squatter, a torn-down host, and a stale socket file are the same event, and
// the user's next move is the same for all three.
const HANDSHAKE_FAILURE =
  'the process holding the Dormouse control socket could not prove it is Dormouse';

function proveToken(token: string, domain: string, nonce: string): string {
  return createHmac('sha256', token).update(`${domain} ${nonce}`).digest('hex');
}

function proofMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
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
    return this.request<ListSurfacesResponse>(SURFACE_CONTROL_METHODS.list, request);
  }

  splitSurface(request: SplitSurfaceRequest): Promise<SplitSurfaceResponse> {
    return this.request<SplitSurfaceResponse>(SURFACE_CONTROL_METHODS.split, request);
  }

  ensureSurface(request: EnsureSurfaceRequest): Promise<EnsureSurfaceResponse> {
    return this.request<EnsureSurfaceResponse>(SURFACE_CONTROL_METHODS.ensure, request);
  }

  sendSurface(request: SendSurfaceRequest): Promise<SendSurfaceResponse> {
    return this.request<SendSurfaceResponse>(SURFACE_CONTROL_METHODS.send, request);
  }

  readSurface(request: ReadSurfaceRequest): Promise<ReadSurfaceResponse> {
    return this.request<ReadSurfaceResponse>(SURFACE_CONTROL_METHODS.read, request);
  }

  // The host enforces its own `timeoutMs` ceiling and answers with a `timeout`
  // outcome, so the client's socket deadline must sit *above* it — otherwise the
  // socket would time out first and turn an ordinary timeout into a transport
  // error. The control server's deadline (client's + 10s) then outlasts both, so
  // the ordering is host ceiling < client socket < server reaper.
  awaitSurface(request: AwaitSurfaceRequest): Promise<AwaitSurfaceResponse> {
    return this.request<AwaitSurfaceResponse>(
      SURFACE_CONTROL_METHODS.await,
      request,
      { timeoutMs: request.timeoutMs + 5_000 },
    );
  }

  killSurface(request: KillSurfaceRequest): Promise<KillSurfaceResponse> {
    return this.request<KillSurfaceResponse>(SURFACE_CONTROL_METHODS.kill, request);
  }

  iframeSurface(request: IframeSurfaceRequest): Promise<IframeSurfaceResponse> {
    return this.request<IframeSurfaceResponse>(SURFACE_CONTROL_METHODS.iframe, request);
  }

  agentBrowserSurface(request: AgentBrowserSurfaceRequest): Promise<AgentBrowserSurfaceResponse> {
    return this.request<AgentBrowserSurfaceResponse>(SURFACE_CONTROL_METHODS.agentBrowser, request);
  }

  resolveOpenTarget(request: ResolveOpenTargetRequest): Promise<ResolveOpenTargetResponse> {
    return this.request<ResolveOpenTargetResponse>(SURFACE_CONTROL_METHODS.resolveOpen, request);
  }

  /**
   * One request over one socket, preceded by a mutual handshake.
   *
   * The token is a bearer credential for the whole surface-control API (`send`
   * types into any pane, `read` returns its scrollback), so it never goes on the
   * wire: the peer must first prove it holds the token over a nonce we did not
   * choose, and we answer over a nonce it did not choose. Whoever merely bound
   * the socket path learns two nonces and nothing else.
   *
   * `timeoutMs` overrides the client's configured deadline for one call. It also
   * travels on the wire — in the request frame, after the handshake — so the
   * control server can set a timer that outlasts it; otherwise a long request (a
   * parked `dor await`) would be killed by the server's default long before the
   * client gave up.
   */
  private request<T>(
    method: SurfaceControlMethod,
    params: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    const requestId = `dor-${this.idBase}-${++this.nextRequestId}`;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let responseBuffer = '';
      let settled = false;
      // 'challenge' → 'welcome' → 'response': the three lines the server sends,
      // in order, over one connection.
      let phase: 'challenge' | 'welcome' | 'response' = 'challenge';
      const nonce = randomBytes(16).toString('hex');

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        callback();
      };

      const timeout = setTimeout(() => {
        settle(() => reject(new Error(`timed out waiting for ${method}`)));
      }, timeoutMs);

      socket.setEncoding('utf8');
      // Deliberately nothing on 'connect': the server speaks first.
      socket.on('data', (chunk) => {
        responseBuffer += chunk;
        let newlineIndex = responseBuffer.indexOf('\n');
        while (newlineIndex !== -1 && !settled) {
          const line = responseBuffer.slice(0, newlineIndex);
          responseBuffer = responseBuffer.slice(newlineIndex + 1);
          let frame: { kind?: unknown; nonce?: unknown; proof?: unknown };
          if (phase === 'response') {
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
            return;
          }
          try {
            frame = JSON.parse(line);
          } catch {
            settle(() => reject(new Error(HANDSHAKE_FAILURE)));
            return;
          }
          if (phase === 'challenge') {
            if (frame?.kind !== 'challenge' || typeof frame.nonce !== 'string' || !frame.nonce) {
              settle(() => reject(new Error(HANDSHAKE_FAILURE)));
              return;
            }
            // Answering a challenge proves nothing about the challenger, which
            // is why this is all that is sent until the welcome comes back.
            socket.write(`${JSON.stringify({
              kind: 'hello',
              nonce,
              proof: proveToken(this.token, CLIENT_PROOF_DOMAIN, frame.nonce),
            })}\n`);
            phase = 'welcome';
          } else {
            if (
              frame?.kind !== 'welcome' ||
              !proofMatches(frame.proof, proveToken(this.token, SERVER_PROOF_DOMAIN, nonce))
            ) {
              settle(() => reject(new Error(HANDSHAKE_FAILURE)));
              return;
            }
            socket.write(`${JSON.stringify({
              requestId,
              surfaceId: this.surfaceId,
              method,
              params,
              timeoutMs,
            })}\n`);
            phase = 'response';
          }
          newlineIndex = responseBuffer.indexOf('\n');
        }
      });
      socket.on('error', (error) => {
        settle(() => reject(error));
      });
      socket.on('end', () => {
        if (settled) return;
        // A peer that drops us mid-handshake is the same event as one that
        // answers it wrongly — the server hangs up on a bad hello rather than
        // replying — so report it the same way.
        settle(() =>
          reject(new Error(phase === 'response' ? `connection closed before ${method} response` : HANDSHAKE_FAILURE)),
        );
      });
    });
  }
}
