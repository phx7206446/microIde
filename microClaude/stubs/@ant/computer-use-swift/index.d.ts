export interface DisplayGeometry {
  id?: number;
  width: number;
  height: number;
  scaleFactor: number;
  originX?: number;
  originY?: number;
}

export interface InstalledApp {
  bundleId: string;
  displayName: string;
  path: string;
}

export interface RunningApp {
  bundleId: string;
  displayName: string;
  pid?: number;
}

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
}

export interface ResolvePrepareCaptureResult {
  displayId?: number;
  allowedBundleIds?: string[];
  hiddenBundleIds?: string[];
}

export interface ComputerUseAPI {
  _drainMainRunLoop(): void;
  hotkey: {
    registerEscape(onEscape: () => void): boolean;
    unregister(): void;
    notifyExpectedEscape(): void;
  };
  tcc: {
    checkAccessibility(): boolean;
    checkScreenRecording(): boolean;
  };
  display: {
    getSize(displayId?: number): DisplayGeometry;
    listAll(): DisplayGeometry[];
  };
  screenshot: {
    captureExcluding(
      allowedBundleIds: readonly string[],
      quality: number,
      width: number,
      height: number,
      displayId?: number,
    ): Promise<ScreenshotResult>;
    captureRegion(
      allowedBundleIds: readonly string[],
      x: number,
      y: number,
      width: number,
      height: number,
      outWidth: number,
      outHeight: number,
      quality: number,
      displayId?: number,
    ): Promise<ScreenshotResult>;
  };
  apps: {
    listInstalled(): Promise<InstalledApp[]>;
    listRunning(): Promise<RunningApp[]>;
    prepareDisplay(
      allowlistBundleIds: readonly string[],
      hostBundleId: string,
      displayId?: number,
    ): Promise<{ hidden: string[]; activated?: string }>;
    previewHideSet(
      allowlistBundleIds: readonly string[],
      displayId?: number,
    ): Promise<Array<{ bundleId: string; displayName: string }>>;
    findWindowDisplays(
      bundleIds: readonly string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>>;
    appUnderPoint(
      x: number,
      y: number,
    ): Promise<{ bundleId: string; displayName: string } | null>;
    iconDataUrl(path: string): string | undefined;
    open(bundleId: string): Promise<void>;
    hide(bundleIds: readonly string[]): Promise<void>;
    unhide(bundleIds: readonly string[]): Promise<void>;
  };
  resolvePrepareCapture(
    allowedBundleIds: readonly string[],
    hostBundleId: string,
    quality: number,
    width: number,
    height: number,
    displayId?: number,
    autoResolve?: boolean,
    doHide?: boolean,
  ): Promise<ResolvePrepareCaptureResult>;
  captureExcluding(
    allowedBundleIds: readonly string[],
    quality: number,
    width: number,
    height: number,
    displayId?: number,
  ): Promise<ScreenshotResult>;
  captureRegion(
    allowedBundleIds: readonly string[],
    x: number,
    y: number,
    width: number,
    height: number,
    outWidth: number,
    outHeight: number,
    quality: number,
    displayId?: number,
  ): Promise<ScreenshotResult>;
  prepareDisplay(
    allowlistBundleIds: readonly string[],
    hostBundleId: string,
    displayId?: number,
  ): Promise<{ hidden: string[]; activated?: string }>;
  hideApps(bundleIds: readonly string[]): Promise<void>;
  unhideApps(bundleIds: readonly string[]): Promise<void>;
  activateApp(bundleId: string): Promise<void>;
}

declare const computerUseApi: ComputerUseAPI;

export default computerUseApi;
