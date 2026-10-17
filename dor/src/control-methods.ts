// Browser-safe: the website playground's dor answers these through the page.
import type {
  AppRestartResponse,
  BrowserSurfaceRequest,
  BrowserSurfaceResponse,
  BrowserViewportRequest,
  BrowserViewportResponse,
  AwaitSurfaceRequest,
  AwaitSurfaceResponse,
  ControlClient,
  EnsureSurfaceRequest,
  EnsureSurfaceResponse,
  IframeSurfaceRequest,
  IframeSurfaceResponse,
  MoveSurfaceRequest,
  MoveSurfaceResponse,
  KillSurfaceRequest,
  KillSurfaceResponse,
  ListSurfacesRequest,
  ListSurfacesResponse,
  ListWorkspacesRequest,
  ListWorkspacesResponse,
  NewWorkspaceRequest,
  CloseWorkspaceRequest,
  RenameWorkspaceRequest,
  MoveWorkspaceRequest,
  SwitchWorkspaceRequest,
  PinWorkspaceRequest,
  WorkspaceMutationResponse,
  ReadSurfaceRequest,
  ReadSurfaceResponse,
  ReopenResponse,
  ResolveBrowserRequest,
  ResolveBrowserResponse,
  ResolveOpenTargetRequest,
  ResolveOpenTargetResponse,
  SendSurfaceRequest,
  SendSurfaceResponse,
  SplitSurfaceRequest,
  SplitSurfaceResponse,
  OpenHandlersRequest,
  OpenHandlersResponse,
  ToolListRequest,
  ToolListResponse,
  ToolSurfaceRequest,
  ToolSurfaceResponse,
} from './commands/types.js';
import {
  APP_CONTROL_METHODS,
  SURFACE_CONTROL_METHODS,
  TOOL_CONTROL_METHODS,
  WINDOW_CONTROL_METHODS,
  WORKSPACE_CONTROL_METHODS,
  type DorControlMethod,
} from './protocol.js';
import { BROWSER_REQUEST_TIMEOUT_MS } from 'dor-lib-common/browser-providers';

/** `dor workspace close` tears down every member Surface. Also covers moves:
 *  must exceed `ARRIVAL_MAX` in
 *  `standalone/src-tauri/src/routing.rs` so hand-back reasons arrive before timeout. */
const CLOSE_WORKSPACE_TIMEOUT_MS = 30_000;

/** Every `ControlClient` method as the control method it sends, with its
 * deadline; a transport supplies `request`. */
export abstract class MethodControlClient implements ControlClient {
  /** Sends `method` with `params` and answers its `result`; `timeoutMs`
   *  overrides the transport's deadline for one call. */
  protected abstract request<T>(method: DorControlMethod, params: unknown, options?: { timeoutMs?: number }): Promise<T>;

  listSurfaces(request: ListSurfacesRequest): Promise<ListSurfacesResponse> {
    return this.request<ListSurfacesResponse>(SURFACE_CONTROL_METHODS.list, request);
  }

  splitSurface(request: SplitSurfaceRequest): Promise<SplitSurfaceResponse> {
    return this.request<SplitSurfaceResponse>(SURFACE_CONTROL_METHODS.split, request);
  }

  ensureSurface(request: EnsureSurfaceRequest): Promise<EnsureSurfaceResponse> {
    return this.request<EnsureSurfaceResponse>(SURFACE_CONTROL_METHODS.ensure, request);
  }

  toolSurface(request: ToolSurfaceRequest): Promise<ToolSurfaceResponse> {
    return this.request<ToolSurfaceResponse>(SURFACE_CONTROL_METHODS.tool, request);
  }

  toolList(request: ToolListRequest): Promise<ToolListResponse> {
    return this.request<ToolListResponse>(TOOL_CONTROL_METHODS.list, request);
  }

  openHandlers(request: OpenHandlersRequest): Promise<OpenHandlersResponse> {
    return this.request<OpenHandlersResponse>(TOOL_CONTROL_METHODS.openHandlers, request);
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

  moveSurface(request: MoveSurfaceRequest): Promise<MoveSurfaceResponse> {
    return this.request<MoveSurfaceResponse>(SURFACE_CONTROL_METHODS.move, request);
  }

  killSurface(request: KillSurfaceRequest): Promise<KillSurfaceResponse> {
    return this.request<KillSurfaceResponse>(SURFACE_CONTROL_METHODS.kill, request);
  }

  iframeSurface(request: IframeSurfaceRequest): Promise<IframeSurfaceResponse> {
    return this.request<IframeSurfaceResponse>(SURFACE_CONTROL_METHODS.iframe, request);
  }

  // The host asks the browser where it streams (`attach`) before answering,
  // which can wait behind a launch or close of that browser for as long as
  // the host's own request timeout; the socket deadline sits above it, so a
  // bind that succeeds late is never reported as a failure.
  browserSurface(request: BrowserSurfaceRequest): Promise<BrowserSurfaceResponse> {
    return this.request<BrowserSurfaceResponse>(
      SURFACE_CONTROL_METHODS.browser,
      request,
      { timeoutMs: BROWSER_REQUEST_TIMEOUT_MS + 5_000 },
    );
  }

  browserViewport(request: BrowserViewportRequest): Promise<BrowserViewportResponse> {
    return this.request<BrowserViewportResponse>(
      SURFACE_CONTROL_METHODS.browserViewport,
      request,
      { timeoutMs: BROWSER_REQUEST_TIMEOUT_MS + 5_000 },
    );
  }

  resolveBrowser(request: ResolveBrowserRequest): Promise<ResolveBrowserResponse> {
    return this.request<ResolveBrowserResponse>(SURFACE_CONTROL_METHODS.resolveBrowser, request);
  }

  resolveOpenTarget(request: ResolveOpenTargetRequest): Promise<ResolveOpenTargetResponse> {
    return this.request<ResolveOpenTargetResponse>(SURFACE_CONTROL_METHODS.resolveOpen, request);
  }

  listWorkspaces(request: ListWorkspacesRequest): Promise<ListWorkspacesResponse> {
    return this.request<ListWorkspacesResponse>(WORKSPACE_CONTROL_METHODS.list, request);
  }

  newWorkspace(request: NewWorkspaceRequest): Promise<WorkspaceMutationResponse> {
    return this.request<WorkspaceMutationResponse>(WORKSPACE_CONTROL_METHODS.new, request);
  }

  renameWorkspace(request: RenameWorkspaceRequest): Promise<WorkspaceMutationResponse> {
    return this.request<WorkspaceMutationResponse>(WORKSPACE_CONTROL_METHODS.rename, request);
  }

  // A Workspace close walks every member Surface through the closure
  // coordinator, so it can outlast the client's ordinary 5s deadline.
  closeWorkspace(request: CloseWorkspaceRequest): Promise<WorkspaceMutationResponse> {
    return this.request<WorkspaceMutationResponse>(
      WORKSPACE_CONTROL_METHODS.close,
      request,
      { timeoutMs: CLOSE_WORKSPACE_TIMEOUT_MS },
    );
  }

  switchWorkspace(request: SwitchWorkspaceRequest): Promise<WorkspaceMutationResponse> {
    return this.request<WorkspaceMutationResponse>(WORKSPACE_CONTROL_METHODS.switch, request);
  }

  pinWorkspace(request: PinWorkspaceRequest): Promise<WorkspaceMutationResponse> {
    return this.request<WorkspaceMutationResponse>(WORKSPACE_CONTROL_METHODS.pin, request);
  }

  // A move between windows serializes every terminal and waits for the target
  // to adopt the Workspace, so it too can outlast the ordinary deadline.
  moveWorkspace(request: MoveWorkspaceRequest): Promise<WorkspaceMutationResponse> {
    return this.request<WorkspaceMutationResponse>(
      WORKSPACE_CONTROL_METHODS.move,
      request,
      { timeoutMs: CLOSE_WORKSPACE_TIMEOUT_MS },
    );
  }

  restartApp(): Promise<AppRestartResponse> {
    return this.request<AppRestartResponse>(APP_CONTROL_METHODS.restart, {});
  }

  reopenClosed(): Promise<ReopenResponse> {
    return this.request<ReopenResponse>(WINDOW_CONTROL_METHODS.reopen, {});
  }
}
