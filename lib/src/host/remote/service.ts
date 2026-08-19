/**
 * The remote Host as a service in the process that owns the PTYs.
 *
 * It holds everything an access decision depends on — the relay socket, the
 * enrollment, the ACL, the pairing ceremony — and serves remote-api v1 through
 * an injected {@link HostSurfaceProvider}. The webview keeps only what a webview
 * is for: the approval modal, the console hook, and answering what its own panes
 * are called and how big they are. Nothing a webview says can widen access.
 *
 * Every dependency is injected, so this module is environment-free: it runs in
 * the Tauri sidecar today (`sidecar-entry.ts`) and in the VS Code extension host
 * next, and its tests drive it with a fake socket and an in-memory store.
 *
 * Commands arrive from the webview over the bridge in `service-protocol.ts` and
 * are dispatched in {@link RemoteHostService.handleCommand}. The two that carry
 * no reply — `answer` and `notify` — belong to whoever built the provider and
 * are settled there (`sidecar-entry.ts`), so they never reach this dispatch.
 */

import type { HostAclRecord } from 'server-lib-common';
import { performEnrollment, type HostEnrollment } from '../../remote/host/enrollment';
import type { HostSurfaceProvider } from '../../remote/host/host-surface-provider';
import type { PendingPairing } from '../../remote/host/pairing-approval';
import { loadPushDevices, sendPush, type AlertPushDeps } from '../../remote/host/push-delivery';
import { RemoteApiSession } from '../../remote/host/remote-api';
import { RemoteHost, type WebSocketLike } from '../../remote/host/remote-host';
import { originAllowedByConnectSrc } from './connect-src';
import type { HostStateStore } from './host-state-store';
import {
  REMOTE_HOST_EVENT_EVENT,
  REMOTE_HOST_RESULT_EVENT,
  type AdoptParams,
  type AdoptResult,
  type ApproveParams,
  type DenyParams,
  type EnrollParams,
  type EnrollResult,
  type PairingQueueEvent,
  type PairingQueueItem,
  type PushDevicesResult,
  type PushParams,
  type RemoteHostCommand,
  type RemoteHostConsoleStatus,
} from './service-protocol';

export interface RemoteHostServiceOptions {
  store: HostStateStore;
  provider: HostSurfaceProvider;
  /** Emit one of the `remoteHost:*` events to the webview. */
  sendToUi: (event: string, data: unknown) => void;
  /** The CSP-shaped allowlist this build was compiled with (`connect-src.ts`). */
  connectSrc: string;
  createWebSocket?: (url: string) => WebSocketLike;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class RemoteHostService {
  readonly #store: HostStateStore;
  readonly #provider: HostSurfaceProvider;
  readonly #sendToUi: (event: string, data: unknown) => void;
  readonly #connectSrc: string;
  readonly #createWebSocket?: (url: string) => WebSocketLike;
  readonly #fetch?: typeof globalThis.fetch;
  readonly #now: () => number;

  #host: RemoteHost | null = null;
  #enrollment: HostEnrollment | null = null;
  /**
   * Pairings awaiting local approval, service-side. The webview mirrors a
   * serializable projection of this and answers by clientId; the approve/deny
   * closures the `RemoteHost` handed us never leave this process.
   */
  readonly #pairings = new Map<string, PendingPairing>();

  constructor(options: RemoteHostServiceOptions) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#sendToUi = options.sendToUi;
    this.#connectSrc = options.connectSrc;
    this.#createWebSocket = options.createWebSocket;
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Start from a persisted enrollment, if there is one this build may reach. */
  async start(): Promise<void> {
    const enrollment = await this.#store.loadEnrollment();
    if (!enrollment) return;
    if (!this.#allowed(enrollment.serverUrl)) {
      // Enrolled against an origin this build cannot connect to — a binary
      // downgraded from a custom build, or a moved server. Idle rather than
      // connect: the allowlist is the whole boundary (docs/specs/server.md).
      console.warn(
        `[remote-host] enrolled server ${enrollment.serverUrl} is outside this build's allowed sources (${this.#connectSrc}); staying idle`,
      );
      return;
    }
    await this.#startHost(enrollment);
  }

  /** Stop the Host and forget the connection-scoped state. */
  dispose(): void {
    this.#stopHost();
  }

  async handleCommand(raw: unknown): Promise<void> {
    const command = raw as RemoteHostCommand | null;
    if (!command || typeof command.rhId !== 'string' || typeof command.cmd !== 'string') return;
    try {
      const result = await this.#run(command.cmd, command.params);
      this.#sendToUi(REMOTE_HOST_RESULT_EVENT, { rhId: command.rhId, result });
    } catch (error) {
      this.#sendToUi(REMOTE_HOST_RESULT_EVENT, {
        rhId: command.rhId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #run(cmd: string, params: unknown): Promise<unknown> {
    switch (cmd) {
      case 'enroll':
        return this.#enroll(params as EnrollParams);
      case 'status':
        return this.#status();
      case 'reconnect':
        return this.#reconnect();
      case 'clearEnrollment':
        return this.#clearEnrollment();
      case 'approve':
        return this.#approve(params as ApproveParams);
      case 'deny':
        return this.#deny(params as DenyParams);
      case 'push':
        return this.#push(params as PushParams);
      case 'pushDevices':
        return this.#pushDevices();
      case 'pairingQueue':
        return this.#queueSnapshot();
      case 'adopt':
        return this.#adopt(params as AdoptParams);
      default:
        throw new Error(`unknown remote-host command: ${cmd}`);
    }
  }

  // --- Commands ---

  async #enroll(params: EnrollParams): Promise<EnrollResult> {
    if (!this.#allowed(params.serverUrl)) {
      // Refused before the password leaves the machine. Self-hosters widen the
      // list in their own build (docs/specs/server.md → "Host webview CSP").
      throw new Error(
        `${params.serverUrl} is outside this build's allowed remote sources (${this.#connectSrc}). ` +
          'A self-host build bakes its own via DORMOUSE_REMOTE_CONNECT_SRC.',
      );
    }
    const enrollment = await performEnrollment(params.serverUrl, params.password, params.label);
    this.#stopHost();
    await this.#store.saveEnrollment(enrollment);
    await this.#startHost(enrollment);
    return { hostId: enrollment.hostId, serverUrl: enrollment.serverUrl };
  }

  #status(): RemoteHostConsoleStatus {
    return {
      enrolled: !!this.#enrollment,
      serverUrl: this.#enrollment?.serverUrl ?? null,
      hostId: this.#enrollment?.hostId ?? null,
      connection: this.#host?.status ?? 'stopped',
      pairedClients: this.#host?.activeRecords.length ?? 0,
    };
  }

  /**
   * Re-open the relay socket now. The only way back from `displaced`: an evicted
   * Host stands down for good rather than fighting the Host that replaced it, so
   * returning has to be asked for.
   */
  async #reconnect(): Promise<RemoteHostConsoleStatus> {
    if (this.#host) this.#host.start();
    else await this.start();
    return this.#status();
  }

  async #clearEnrollment(): Promise<Record<string, never>> {
    this.#stopHost();
    this.#enrollment = null;
    // ACL records stay keyed by their hostId. They are unreachable without an
    // enrollment naming that host, and keeping them means a re-enrollment onto
    // the same hostId does not silently de-pair every device.
    await this.#store.clearEnrollment();
    return {};
  }

  #approve(params: ApproveParams): Record<string, never> {
    this.#pairings.get(params.clientId)?.approve(params.label);
    return {};
  }

  #deny(params: DenyParams): Record<string, never> {
    this.#pairings.get(params.clientId)?.deny();
    return {};
  }

  async #push(params: PushParams): Promise<Record<string, never>> {
    const deps = this.#pushDeps();
    // No Host means no ACL and no server to post to; the ring is simply not
    // pushed. Nothing to report to the webview, which cannot act on it either.
    if (deps) {
      // A push that fails must never break the alert path.
      await sendPush(deps, params.sessionId, params.title).catch((error: unknown) => {
        console.warn('[remote-host] push notification failed', error);
      });
    }
    return {};
  }

  async #pushDevices(): Promise<PushDevicesResult> {
    const deps = this.#pushDeps();
    if (!deps) return null;
    return { devices: await loadPushDevices(deps) };
  }

  async #adopt(params: AdoptParams): Promise<AdoptResult> {
    const existing = await this.#store.loadEnrollment();
    let adopted = false;
    if (!existing && isEnrollment(params.enrollment)) {
      const enrollment = params.enrollment;
      await this.#store.saveEnrollment(enrollment);
      const records = (params.aclRecords ?? []).filter(
        (record): record is HostAclRecord =>
          !!record && typeof record === 'object' && (record as HostAclRecord).hostId === enrollment.hostId,
      );
      if (records.length > 0) await this.#store.saveAcl(enrollment.hostId, records);
      adopted = true;
    }
    // Either way there may now be a Host to run: an adoption just supplied one,
    // and a rejected adoption means the store already had one this service may
    // not have started yet (a webview that reloads before `start()` lands).
    if (!this.#host) await this.start();
    return { adopted };
  }

  // --- Host lifecycle ---

  #allowed(serverUrl: string): boolean {
    try {
      return originAllowedByConnectSrc(new URL(serverUrl).origin, this.#connectSrc);
    } catch {
      return false;
    }
  }

  async #startHost(enrollment: HostEnrollment): Promise<void> {
    // The controller wants the ACL synchronously; the store is async because
    // the places it lives are. Read it before constructing, and let saves run
    // in the background — a failed write must not fail the pairing that is
    // already approved and already on the wire.
    const records = await this.#store.loadAcl(enrollment.hostId);
    this.#enrollment = enrollment;
    this.#host = new RemoteHost({
      enrollment,
      createWebSocket: this.#createWebSocket,
      createSession: (opts) =>
        new RemoteApiSession({
          hostId: opts.hostId,
          send: opts.send,
          provider: this.#provider,
        }),
      loadAcl: () => records,
      saveAcl: (hostId, next) => {
        void this.#store.saveAcl(hostId, next).catch((error: unknown) => {
          console.warn('[remote-host] could not persist the ACL', error);
        });
      },
      requestApproval: (pending) => this.#enqueuePairing(pending),
      dismissApproval: (clientId) => this.#resolvePairing(clientId),
      now: this.#now,
    });
    this.#host.start();
  }

  #stopHost(): void {
    this.#host?.stop();
    this.#host = null;
    // `stop()` dismisses every in-flight pairing, which empties the queue and
    // pushes the empty snapshot; clear defensively in case there was no Host.
    if (this.#pairings.size > 0) {
      this.#pairings.clear();
      this.#emitQueue();
    }
  }

  // --- Pairing queue ---

  #enqueuePairing(pending: PendingPairing): void {
    // Coalesce by clientId: a re-sent pair for the same client replaces the old.
    this.#pairings.set(pending.clientId, pending);
    this.#emitQueue();
  }

  #resolvePairing(clientId: string): void {
    if (!this.#pairings.delete(clientId)) return;
    this.#emitQueue();
  }

  #queueSnapshot(): PairingQueueItem[] {
    return [...this.#pairings.values()].map(({ clientId, request, requestedAt }) => ({
      clientId,
      request,
      requestedAt,
    }));
  }

  #emitQueue(): void {
    this.#sendToUi(REMOTE_HOST_EVENT_EVENT, {
      name: 'pairing-queue',
      queue: this.#queueSnapshot(),
    } satisfies PairingQueueEvent);
  }

  /** Push delivery needs a live Host: the ACL it reads is the running one's. */
  #pushDeps(): AlertPushDeps | null {
    const host = this.#host;
    const enrollment = this.#enrollment;
    if (!host || !enrollment) return null;
    return {
      enrollment,
      activeRecords: () => host.activeRecords,
      fetch: this.#fetch,
    };
  }
}

function isEnrollment(value: unknown): value is HostEnrollment {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.serverUrl === 'string' &&
    typeof v.hostId === 'string' &&
    typeof v.hostToken === 'string' &&
    typeof v.origin === 'string' &&
    typeof v.rpId === 'string'
  );
}
