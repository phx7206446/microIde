export type {
  ComputerExecutor,
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  CoordinateMode,
  CuCallToolResult,
  CuPermissionRequest,
  CuPermissionResponse,
  CuSubGates,
  DisplayGeometry,
  FrontmostApp,
  GrantFlags,
  InstalledApp,
  Logger,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotDims,
  ScreenshotResult,
} from "./types";

export const API_RESIZE_PARAMS: {
  maxWidth: number;
  maxHeight: number;
};

export const DEFAULT_GRANT_FLAGS: import("./types").GrantFlags;

export function targetImageSize(
  width: number,
  height: number,
  params?: {
    maxWidth?: number;
    maxHeight?: number;
  },
): [number, number];

export function buildComputerUseTools(
  capabilities?: unknown,
  coordinateMode?: import("./types").CoordinateMode,
  installedAppNames?: string[],
): Array<{
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}>;

export function createComputerUseMcpServer(
  adapter?: import("./types").ComputerUseHostAdapter,
  coordinateMode?: import("./types").CoordinateMode,
): {
  setRequestHandler: (schema: unknown, handler: (...args: unknown[]) => unknown) => void;
  connect: (transport: unknown) => Promise<void>;
  close: () => Promise<void>;
};

export function bindSessionContext(
  adapter?: import("./types").ComputerUseHostAdapter,
  coordinateMode?: import("./types").CoordinateMode,
  context?: import("./types").ComputerUseSessionContext,
): (
  name: string,
  args: unknown,
) => Promise<import("./types").CuCallToolResult>;
