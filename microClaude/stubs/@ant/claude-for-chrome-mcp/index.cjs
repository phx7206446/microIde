const net = require("net");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const PACKAGE_VERSION = "0.4.0-local";
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

function tool(name, description, properties, required) {
  const inputSchema = { type: "object" };
  if (properties && Object.keys(properties).length > 0) {
    inputSchema.properties = properties;
  }
  if (required && required.length > 0) {
    inputSchema.required = required;
  }
  return { name, description, inputSchema };
}

const COORDINATE_SCHEMA = {
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
};

const STRINGISH_ADDITIONAL_PROPERTIES = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};

const TOOL_DESCRIPTORS = [
  tool(
    "tabs_context_mcp",
    "Read the current Chrome tab context so Claude can reuse or inspect existing tabs.",
  ),
  tool(
    "tabs_create_mcp",
    "Create a new Chrome tab, optionally navigating it to a URL.",
    {
      url: { type: "string", description: "URL to open in the new tab." },
      active: {
        type: "boolean",
        description: "Whether the new tab should become the active tab.",
      },
    },
  ),
  tool(
    "navigate",
    "Navigate a Chrome tab to a new URL.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      url: { type: "string", description: "Destination URL." },
      waitUntil: {
        type: "string",
        description: "Optional load state hint such as load or networkidle.",
      },
    },
    ["url"],
  ),
  tool(
    "read_page",
    "Read the current page structure and visible elements from a Chrome tab.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
    },
  ),
  tool(
    "get_page_text",
    "Extract visible text from the current page or from a specific selector.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      selector: {
        type: "string",
        description: "Optional selector or element reference to scope the text extraction.",
      },
    },
  ),
  tool(
    "find",
    "Find matching elements or text on the current page.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      query: {
        type: "string",
        description: "Search pattern, selector, or visible text to match.",
      },
    },
    ["query"],
  ),
  tool(
    "form_input",
    "Fill multiple form fields in the current page.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      fields: {
        type: "object",
        description: "Field identifiers mapped to values to type or select.",
        additionalProperties: STRINGISH_ADDITIONAL_PROPERTIES,
      },
      submit: {
        type: "boolean",
        description: "Whether the form should be submitted after filling.",
      },
    },
    ["fields"],
  ),
  tool(
    "computer",
    "Perform browser computer-use actions such as click, type, key press, drag, or scroll.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      action: {
        type: "string",
        enum: [
          "left_click",
          "right_click",
          "double_click",
          "middle_click",
          "left_click_drag",
          "type",
          "key",
          "scroll",
          "wait",
          "hover",
        ],
      },
      ref: {
        type: "string",
        description: "Element reference returned by prior page-reading tools.",
      },
      coordinate: COORDINATE_SCHEMA,
      start_coordinate: COORDINATE_SCHEMA,
      text: { type: "string", description: "Text to type or key chord to press." },
      scroll_direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
      },
      duration: {
        type: "number",
        description: "Optional wait or interaction duration in seconds.",
      },
    },
    ["action"],
  ),
  tool(
    "resize_window",
    "Resize the Chrome browser window.",
    {
      width: { type: "number" },
      height: { type: "number" },
    },
    ["width", "height"],
  ),
  tool(
    "gif_creator",
    "Start, capture, or stop a GIF recording of browser actions.",
    {
      action: { type: "string", enum: ["start", "capture", "stop"] },
      fileName: {
        type: "string",
        description: "Optional file name for the recorded GIF.",
      },
    },
    ["action"],
  ),
  tool(
    "upload_image",
    "Upload an image file into a file input on the page.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      ref: {
        type: "string",
        description: "Element reference for the target file input.",
      },
      filePath: {
        type: "string",
        description: "Absolute or workspace-relative image path to upload.",
      },
    },
    ["filePath"],
  ),
  tool(
    "javascript_tool",
    "Execute JavaScript in the current browser tab.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      text: {
        type: "string",
        description: "JavaScript source to execute in the page context.",
      },
    },
    ["text"],
  ),
  tool(
    "read_console_messages",
    "Read browser console output from the current tab.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      pattern: {
        type: "string",
        description: "Optional regex-compatible filter for console lines.",
      },
      onlyErrors: {
        type: "boolean",
        description: "When true, return only error-level console messages.",
      },
    },
  ),
  tool(
    "read_network_requests",
    "Inspect browser network requests from the current tab.",
    {
      tabId: { type: "number", description: "Existing Chrome tab identifier." },
      urlPattern: {
        type: "string",
        description: "Optional regex-compatible filter for request URLs.",
      },
      method: {
        type: "string",
        description: "Optional HTTP method filter.",
      },
    },
  ),
  tool(
    "shortcuts_list",
    "List browser-side shortcuts exposed by the Chrome extension.",
  ),
  tool(
    "shortcuts_execute",
    "Execute a named browser shortcut exposed by the Chrome extension.",
    {
      shortcutId: {
        type: "string",
        description: "Shortcut identifier returned by shortcuts_list.",
      },
      input: {
        type: "object",
        description: "Optional shortcut-specific input payload.",
      },
    },
    ["shortcutId"],
  ),
  tool(
    "update_plan",
    "Update an extension-managed browser task plan or checklist.",
    {
      notes: {
        type: "string",
        description: "Latest task-plan notes or summary text.",
      },
      items: {
        type: "array",
        description: "Optional structured plan items.",
        items: { type: "object" },
      },
      status: {
        type: "string",
        description: "Optional high-level plan status.",
      },
    },
  ),
];

const BROWSER_TOOLS = TOOL_DESCRIPTORS.map(({ name, description }) => ({
  name,
  description,
}));

function stringifySafe(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (_err) {
    return String(value);
  }
}

function textContent(text) {
  return [{ type: "text", text: String(text) }];
}

function errorResult(message, extras) {
  return {
    isError: true,
    content: textContent(message),
    ...(extras && extras._meta ? { _meta: extras._meta } : {}),
  };
}

function normalizeContentItem(item) {
  if (typeof item === "string") {
    return { type: "text", text: item };
  }

  if (!item || typeof item !== "object") {
    return { type: "text", text: stringifySafe(item) };
  }

  if (item.type === "text" && typeof item.text === "string") {
    return { type: "text", text: item.text };
  }

  if (
    item.type === "image" &&
    typeof item.data === "string" &&
    typeof item.mimeType === "string"
  ) {
    return {
      type: "image",
      data: item.data,
      mimeType: item.mimeType,
    };
  }

  if (item.type === "audio" && typeof item.data === "string") {
    return {
      type: "audio",
      data: item.data,
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    };
  }

  if (
    item.type === "resource" &&
    item.resource &&
    typeof item.resource === "object"
  ) {
    return { type: "resource", resource: item.resource };
  }

  if (item.type === "resource_link" && typeof item.uri === "string") {
    const next = {
      type: "resource_link",
      uri: item.uri,
      name: typeof item.name === "string" ? item.name : item.uri,
    };
    if (typeof item.description === "string") {
      next.description = item.description;
    }
    return next;
  }

  if (typeof item.text === "string") {
    return { type: "text", text: item.text };
  }

  return { type: "text", text: stringifySafe(item) };
}

function normalizeContentArray(content) {
  const items = Array.isArray(content) ? content : [content];
  return items.map(normalizeContentItem);
}

function extractErrorMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return "Claude in Chrome tool failed.";
  }

  if (typeof payload.error === "string") {
    return payload.error;
  }

  if (
    payload.error &&
    typeof payload.error === "object" &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  if (typeof payload.details === "string") {
    return payload.details;
  }

  if (payload.content !== undefined) {
    const content = normalizeContentArray(payload.content);
    const firstText = content.find(item => item.type === "text");
    if (firstText && typeof firstText.text === "string") {
      return firstText.text;
    }
  }

  return "Claude in Chrome tool failed.";
}

function normalizeCallToolResult(payload) {
  if (payload === undefined || payload === null) {
    return { content: textContent("Tool call completed.") };
  }

  if (typeof payload === "string") {
    return { content: textContent(payload) };
  }

  if (Array.isArray(payload)) {
    return { content: normalizeContentArray(payload) };
  }

  if (typeof payload !== "object") {
    return { content: textContent(String(payload)) };
  }

  if (payload.result !== undefined) {
    const result = normalizeCallToolResult(payload.result);
    if (payload._meta && result._meta === undefined) {
      result._meta = payload._meta;
    }
    if (
      payload.structuredContent !== undefined &&
      result.structuredContent === undefined
    ) {
      result.structuredContent = payload.structuredContent;
    }
    return result;
  }

  const hasErrorFlag =
    payload.isError === true ||
    payload.is_error === true ||
    payload.success === false;

  if (hasErrorFlag) {
    return errorResult(extractErrorMessage(payload), {
      _meta: payload._meta,
    });
  }

  if (payload.toolResult !== undefined) {
    return {
      content: textContent(payload.toolResult),
      ...(payload._meta ? { _meta: payload._meta } : {}),
    };
  }

  if (payload.content !== undefined) {
    return {
      content: normalizeContentArray(payload.content),
      ...(payload.structuredContent !== undefined
        ? { structuredContent: payload.structuredContent }
        : {}),
      ...(payload._meta ? { _meta: payload._meta } : {}),
    };
  }

  if (payload.text !== undefined) {
    return {
      content: textContent(payload.text),
      ...(payload._meta ? { _meta: payload._meta } : {}),
    };
  }

  const imageBase64 =
    typeof payload.imageBase64 === "string"
      ? payload.imageBase64
      : typeof payload.image_base64 === "string"
        ? payload.image_base64
        : undefined;
  const imageMimeType =
    typeof payload.mimeType === "string"
      ? payload.mimeType
      : typeof payload.mime_type === "string"
        ? payload.mime_type
        : "image/png";

  if (imageBase64) {
    return {
      content: [
        {
          type: "image",
          data: imageBase64,
          mimeType: imageMimeType,
        },
      ],
      ...(payload._meta ? { _meta: payload._meta } : {}),
    };
  }

  if (payload.structuredContent !== undefined) {
    return {
      content: textContent(stringifySafe(payload.structuredContent)),
      structuredContent: payload.structuredContent,
      ...(payload._meta ? { _meta: payload._meta } : {}),
    };
  }

  return {
    content: textContent(stringifySafe(payload)),
    ...(payload._meta ? { _meta: payload._meta } : {}),
  };
}

function isLikelyToolPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return true;
  }

  return (
    payload.result !== undefined ||
    payload.success !== undefined ||
    payload.isError !== undefined ||
    payload.is_error !== undefined ||
    payload.error !== undefined ||
    payload.content !== undefined ||
    payload.text !== undefined ||
    payload.toolResult !== undefined ||
    payload.structuredContent !== undefined ||
    payload.imageBase64 !== undefined ||
    payload.image_base64 !== undefined
  );
}

function socketPathsFromContext(context) {
  const ordered = [];
  const seen = new Set();

  const push = value => {
    if (typeof value !== "string" || value.length === 0) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    ordered.push(value);
  };

  if (context && typeof context.getSocketPaths === "function") {
    try {
      const values = context.getSocketPaths();
      if (Array.isArray(values)) {
        values.forEach(push);
      }
    } catch (_err) {}
  }

  if (context && typeof context.socketPath === "string") {
    push(context.socketPath);
  }

  return ordered;
}

function errorTypeOf(error) {
  if (!error || typeof error !== "object") {
    return "unknown";
  }

  if (error.code === "ENOENT") return "socket_not_found";
  if (error.code === "ECONNREFUSED") return "connection_refused";
  if (error.code === "EPIPE") return "broken_pipe";
  if (error.code === "ETIMEDOUT") return "timeout";
  if (typeof error.message === "string") {
    if (/auth/i.test(error.message)) return "authentication";
    if (/timed out/i.test(error.message)) return "timeout";
    if (/disconnected/i.test(error.message)) return "disconnected";
  }

  return "unknown";
}

function makeDisconnectedError(context, cause) {
  const message =
    context && typeof context.onToolCallDisconnected === "function"
      ? context.onToolCallDisconnected()
      : "Browser extension is not connected. Install or reconnect the Claude Chrome extension and try again.";
  const error = new Error(message);
  if (cause && typeof cause === "object") {
    error.cause = cause;
  }
  return error;
}

class ChromeNativeHostBridge {
  constructor(context) {
    this.context = context || {};
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connectPromise = null;
    this.serial = Promise.resolve();
    this.pending = null;
    this.connectedPath = null;
  }

  callTool(name, args) {
    return this.enqueue(async () => {
      const socket = await this.ensureConnected();
      this.track("chrome_bridge_tool_call_started", {
        tool_name: name,
      });

      try {
        const response = await this.sendAndWait(socket, {
          method: name,
          params: args || {},
        });
        const normalized = normalizeCallToolResult(response);
        this.track("chrome_bridge_tool_call_completed", {
          tool_name: name,
        });
        return normalized;
      } catch (error) {
        const errorType = errorTypeOf(error);
        if (errorType === "authentication") {
          this.context.onAuthenticationError?.();
        }
        this.track(
          errorType === "timeout"
            ? "chrome_bridge_tool_call_timeout"
            : "chrome_bridge_tool_call_error",
          {
            tool_name: name,
            error_type: errorType,
          },
        );
        throw error;
      }
    });
  }

  enqueue(task) {
    const run = this.serial.then(task, task);
    this.serial = run.catch(() => {});
    return run;
  }

  async ensureConnected() {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectImpl().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async connectImpl() {
    const paths = socketPathsFromContext(this.context);
    let lastError;

    for (const path of paths) {
      try {
        const socket = await this.openSocket(path);
        this.attachSocket(socket, path);
        this.logger("info", `Connected to Claude in Chrome native host at ${path}`);
        this.track("chrome_bridge_connection_succeeded", {
          bridge_status: "connected",
        });
        return socket;
      } catch (error) {
        lastError = error;
        this.logger(
          "warn",
          `Failed to connect to Claude in Chrome native host at ${path}: ${error.message}`,
        );
      }
    }

    this.track("chrome_bridge_connection_failed", {
      error_type: errorTypeOf(lastError),
    });

    throw makeDisconnectedError(this.context, lastError);
  }

  openSocket(path) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      const onError = error => {
        socket.removeListener("connect", onConnect);
        socket.destroy();
        reject(error);
      };
      const onConnect = () => {
        socket.removeListener("error", onError);
        resolve(socket);
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  attachSocket(socket, path) {
    this.socket = socket;
    this.connectedPath = path;
    this.buffer = Buffer.alloc(0);

    socket.on("data", chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flushFrames();
    });

    socket.on("error", error => {
      this.logger("warn", `Claude in Chrome socket error: ${error.message}`);
      this.resetSocket(error);
    });

    socket.on("close", () => {
      this.logger("info", "Claude in Chrome socket closed");
      this.resetSocket(makeDisconnectedError(this.context));
    });
  }

  flushFrames() {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length <= 0 || length > 16 * 1024 * 1024) {
        const error = new Error(
          `Invalid Claude in Chrome payload length: ${length}`,
        );
        this.resetSocket(error);
        return;
      }

      if (this.buffer.length < 4 + length) {
        return;
      }

      const payloadBytes = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      let payload;
      try {
        payload = JSON.parse(payloadBytes.toString("utf8"));
      } catch (error) {
        this.logger("warn", `Failed to parse Claude in Chrome payload: ${error}`);
        continue;
      }

      if (this.pending && isLikelyToolPayload(payload)) {
        clearTimeout(this.pending.timer);
        const resolve = this.pending.resolve;
        this.pending = null;
        resolve(payload);
        continue;
      }

      this.handleNotification(payload);
    }
  }

  handleNotification(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const event = typeof payload.event === "string" ? payload.event : "";
    if (
      event === "extension_paired" &&
      typeof payload.deviceId === "string" &&
      typeof payload.name === "string"
    ) {
      this.context.onExtensionPaired?.(payload.deviceId, payload.name);
      return;
    }

    if (
      typeof payload.error_type === "string" &&
      payload.error_type === "authentication"
    ) {
      this.context.onAuthenticationError?.();
      return;
    }

    if (event) {
      this.logger("debug", `Claude in Chrome notification: ${event}`);
    }
  }

  sendAndWait(socket, payload) {
    if (this.pending) {
      throw new Error("Concurrent Claude in Chrome tool calls are not supported");
    }

    const timeoutMs =
      Number.parseInt(process.env.CLAUDE_CHROME_TOOL_TIMEOUT_MS || "", 10) ||
      DEFAULT_TOOL_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
        }
        reject(new Error("Claude in Chrome tool call timed out."));
      }, timeoutMs);

      this.pending = { resolve, reject, timer };

      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const frame = Buffer.allocUnsafe(body.length + 4);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      socket.write(frame, error => {
        if (!error) {
          return;
        }
        if (this.pending) {
          clearTimeout(this.pending.timer);
          const pending = this.pending;
          this.pending = null;
          pending.reject(error);
        }
      });
    });
  }

  resetSocket(error) {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }
    this.socket = null;
    this.connectedPath = null;
    this.buffer = Buffer.alloc(0);

    if (this.pending) {
      clearTimeout(this.pending.timer);
      const pending = this.pending;
      this.pending = null;
      pending.reject(error || makeDisconnectedError(this.context));
    }

    this.track("chrome_bridge_disconnected", {
      bridge_status: "disconnected",
    });
  }

  async close() {
    this.resetSocket();
  }

  logger(level, message) {
    const logger = this.context && this.context.logger;
    const fn =
      logger && typeof logger[level] === "function"
        ? logger[level].bind(logger)
        : null;
    if (fn) {
      fn(message);
    }
  }

  track(eventName, metadata) {
    if (
      this.context &&
      typeof this.context.trackEvent === "function"
    ) {
      this.context.trackEvent(eventName, metadata || {});
    }
  }
}

function createClaudeForChromeMcpServer(context = {}) {
  const bridge = new ChromeNativeHostBridge(context);
  const server = new Server(
    { name: "claude-in-chrome", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    try {
      return await bridge.callTool(toolName, args);
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  return {
    context,
    setRequestHandler: (...args) => server.setRequestHandler(...args),
    connect: transport => server.connect(transport),
    close: async () => {
      await bridge.close();
      await server.close?.();
    },
  };
}

module.exports = {
  BROWSER_TOOLS,
  createClaudeForChromeMcpServer,
};
