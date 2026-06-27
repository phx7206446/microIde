export type CoordinateMode = "pixels" | "normalized";

export interface CuSubGates {
  pixelValidation: boolean;
  clipboardPasteMultiline: boolean;
  mouseAnimation: boolean;
  hideBeforeAction: boolean;
  autoTargetDisplay: boolean;
  clipboardGuard: boolean;
}

export interface GrantFlags {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  systemKeyCombos: boolean;
}

export const DEFAULT_GRANT_FLAGS: GrantFlags;

export interface Logger {
  silly(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface DisplayGeometry {
  id?: number;
  width: number;
  height: number;
  scaleFactor: number;
  originX?: number;
  originY?: number;
}

export interface FrontmostApp {
  bundleId: string;
  displayName: string;
  pid?: number;
}

export interface InstalledApp {
  bundleId: string;
  displayName: string;
  path: string;
  iconDataUrl?: string;
}

export interface RunningApp {
  bundleId: string;
  displayName: string;
  pid?: number;
}

export interface ScreenshotDims {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  displayId?: number;
  originX?: number;
  originY?: number;
}

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  dims?: ScreenshotDims;
}

export interface ResolvePrepareCaptureResult {
  displayId?: number;
  allowedBundleIds?: string[];
  hiddenBundleIds?: string[];
}

export interface CuPermissionGrant {
  bundleId: string;
  displayName: string;
  grantedAt: number;
}

export interface CuPermissionDenied {
  bundleId: string;
  reason: "user_denied" | "not_installed";
}

export interface CuPermissionRequestApp {
  requestedName: string;
  resolved?: {
    bundleId: string;
    displayName: string;
    path?: string;
  };
  alreadyGranted?: boolean;
}

export interface ComputerExecutor {
  capabilities?: Record<string, unknown>;
  prepareForAction?(
    allowlistBundleIds: string[],
    displayId?: number,
  ): Promise<string[]>;
  previewHideSet?(
    allowlistBundleIds: string[],
    displayId?: number,
  ): Promise<Array<{ bundleId: string; displayName: string }>>;
  getDisplaySize?(displayId?: number): Promise<DisplayGeometry>;
  listDisplays?(): Promise<DisplayGeometry[]>;
  findWindowDisplays?(
    bundleIds: string[],
  ): Promise<Array<{ bundleId: string; displayIds: number[] }>>;
  resolvePrepareCapture?(opts: {
    allowedBundleIds: string[];
    preferredDisplayId?: number;
    autoResolve: boolean;
    doHide?: boolean;
  }): Promise<ResolvePrepareCaptureResult>;
  screenshot?(opts: {
    allowedBundleIds: string[];
    displayId?: number;
  }): Promise<ScreenshotResult>;
  zoom?(
    regionLogical: { x: number; y: number; w: number; h: number },
    allowedBundleIds: string[],
    displayId?: number,
  ): Promise<ScreenshotResult>;
  key?(keySequence: string, repeat?: number): Promise<void>;
  holdKey?(keyNames: string[], durationMs: number): Promise<void>;
  type?(text: string, opts: { viaClipboard: boolean }): Promise<void>;
  readClipboard?(): Promise<string>;
  writeClipboard?(text: string): Promise<void>;
  moveMouse?(x: number, y: number): Promise<void>;
  click?(
    x: number,
    y: number,
    button: "left" | "right" | "middle",
    count: 1 | 2 | 3,
    modifiers?: string[],
  ): Promise<void>;
  mouseDown?(): Promise<void>;
  mouseUp?(): Promise<void>;
  getCursorPosition?(): Promise<{ x: number; y: number }>;
  drag?(
    from: { x: number; y: number } | undefined,
    to: { x: number; y: number },
  ): Promise<void>;
  scroll?(x: number, y: number, dx: number, dy: number): Promise<void>;
  getFrontmostApp?(): Promise<FrontmostApp | null>;
  appUnderPoint?(
    x: number,
    y: number,
  ): Promise<{ bundleId: string; displayName: string } | null>;
  listInstalledApps?(): Promise<InstalledApp[]>;
  getAppIcon?(path: string): Promise<string | undefined>;
  listRunningApps?(): Promise<RunningApp[]>;
  openApp?(bundleId: string): Promise<void>;
}

export interface ComputerUseHostAdapter {
  serverName?: string;
  logger?: Logger;
  executor: ComputerExecutor;
  ensureOsPermissions?(): Promise<unknown>;
  isDisabled?(): boolean;
  getSubGates?(): CuSubGates;
  getAutoUnhideEnabled?(): boolean;
  cropRawPatch?(...args: unknown[]): unknown;
}

export interface CuPermissionApp {
  bundleId: string;
  displayName: string;
  grantedAt: number;
}

export interface CuPermissionRequest {
  apps: readonly CuPermissionRequestApp[];
  requestedFlags: GrantFlags;
  grantFlags?: GrantFlags;
  reason?: string;
  willHide?: readonly string[];
  tccState?: {
    accessibility: boolean;
    screenRecording: boolean;
  };
}

export interface CuPermissionResponse {
  granted: CuPermissionGrant[];
  denied: CuPermissionDenied[];
  flags: GrantFlags;
}

export type CuToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string }
  | { type: string; [key: string]: unknown };

export interface CuCallToolResult {
  content?: readonly CuToolContent[];
  isError?: boolean;
  telemetry?: Record<string, unknown> & {
    error_kind?: string;
    shim?: boolean;
    tool_name?: string;
  };
  flags?: GrantFlags;
  [key: string]: unknown;
}

export interface ComputerUseSessionContext {
  getAllowedApps?(): readonly CuPermissionGrant[];
  getGrantFlags?(): GrantFlags;
  getUserDeniedBundleIds?(): string[];
  getSelectedDisplayId?(): number | undefined;
  getDisplayPinnedByModel?(): boolean;
  getDisplayResolvedForApps?(): string | undefined;
  getLastScreenshotDims?(): ScreenshotDims | undefined;
  onPermissionRequest?(
    request: CuPermissionRequest,
    signal?: AbortSignal,
  ): Promise<CuPermissionResponse> | CuPermissionResponse;
  onAllowedAppsChanged?(
    apps: readonly CuPermissionGrant[],
    flags: GrantFlags,
  ): void;
  onAppsHidden?(bundleIds: string[]): void;
  onResolvedDisplayUpdated?(displayId: number): void;
  onDisplayPinned?(displayId?: number): void;
  onDisplayResolvedForApps?(key: string): void;
  onScreenshotCaptured?(dims: ScreenshotDims): void;
  checkCuLock?(): Promise<{ holder?: string; isSelf: boolean }>;
  acquireCuLock?(): Promise<void>;
  formatLockHeldMessage?(holder: string): string;
}
