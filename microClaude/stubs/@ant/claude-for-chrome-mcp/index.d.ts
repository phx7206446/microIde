export type PermissionMode =
  | "ask"
  | "skip_all_permission_checks"
  | "follow_a_plan";

export interface Logger {
  silly(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface BridgeConfig {
  url: string;
  getUserId?: () => string | undefined | Promise<string | undefined>;
  getOAuthToken?: () => string | Promise<string>;
  devUserId?: string;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: unknown[];
  stop_sequences?: string[];
  signal?: AbortSignal;
}

export interface AnthropicMessagesResponse {
  content: Array<{ type: "text"; text: string }>;
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ClaudeForChromeContext {
  serverName?: string;
  logger?: Logger;
  socketPath?: string;
  getSocketPaths?: () => string[];
  clientTypeId?: string;
  initialPermissionMode?: PermissionMode;
  bridgeConfig?: BridgeConfig;
  onAuthenticationError?: () => void;
  onToolCallDisconnected?: () => string;
  onExtensionPaired?: (deviceId: string, name: string) => void;
  getPersistedDeviceId?: () => string | undefined;
  callAnthropicMessages?: (
    request: AnthropicMessagesRequest,
  ) => Promise<AnthropicMessagesResponse>;
  trackEvent?: (
    eventName: string,
    metadata?: Record<string, string | number | boolean | undefined>,
  ) => void;
  [key: string]: unknown;
}

export interface BrowserTool {
  name: string;
  description?: string;
}

export const BROWSER_TOOLS: ReadonlyArray<BrowserTool>;

export interface ClaudeForChromeMcpServer {
  setRequestHandler: (...args: unknown[]) => void;
  connect: (...args: unknown[]) => Promise<void>;
  close: () => Promise<void>;
  context: ClaudeForChromeContext;
}

export function createClaudeForChromeMcpServer(
  context?: ClaudeForChromeContext,
): ClaudeForChromeMcpServer;
