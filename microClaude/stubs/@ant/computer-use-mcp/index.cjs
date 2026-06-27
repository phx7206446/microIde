const { DEFAULT_GRANT_FLAGS } = require("./types.cjs");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const API_RESIZE_PARAMS = {
  maxWidth: 1280,
  maxHeight: 800,
};

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

const TOOL_DESCRIPTORS = [
  tool("request_access", "Request access to one or more desktop applications.", {
    apps: { type: "array" },
  }),
  tool("screenshot", "Capture a screenshot of the active display."),
  tool("zoom", "Capture a zoomed-in screenshot for a specific region.", {
    region: { type: "array" },
  }),
  tool("left_click", "Click the left mouse button at the given coordinate.", {
    coordinate: { type: "array" },
  }),
  tool("right_click", "Click the right mouse button at the given coordinate.", {
    coordinate: { type: "array" },
  }),
  tool("middle_click", "Click the middle mouse button at the given coordinate.", {
    coordinate: { type: "array" },
  }),
  tool("double_click", "Double click at the given coordinate.", {
    coordinate: { type: "array" },
  }),
  tool("triple_click", "Triple click at the given coordinate.", {
    coordinate: { type: "array" },
  }),
  tool("mouse_move", "Move the mouse cursor to the given coordinate.", {
    coordinate: { type: "array" },
  }),
  tool("left_mouse_down", "Press and hold the left mouse button."),
  tool("left_mouse_up", "Release the left mouse button."),
  tool("left_click_drag", "Drag from one coordinate to another.", {
    start_coordinate: { type: "array" },
    coordinate: { type: "array" },
  }),
  tool("scroll", "Scroll at the current or specified coordinate.", {
    coordinate: { type: "array" },
    direction: { type: "string" },
    amount: { type: "number" },
  }),
  tool("type", "Type text into the active application.", {
    text: { type: "string" },
  }),
  tool("key", "Press a key or key chord.", {
    text: { type: "string" },
  }),
  tool("hold_key", "Hold one or more keys for a duration.", {
    text: { type: "string" },
    duration: { type: "number" },
  }),
  tool("wait", "Wait for a short duration.", {
    duration: { type: "number" },
  }),
  tool("write_clipboard", "Write text to the clipboard.", {
    text: { type: "string" },
  }),
  tool("read_clipboard", "Read text from the clipboard."),
  tool("cursor_position", "Return the current cursor position."),
  tool("list_granted_applications", "List currently granted applications."),
  tool("switch_display", "Switch the targeted display.", {
    text: { type: "string" },
  }),
  tool("open_application", "Open an application by bundle identifier.", {
    bundle_id: { type: "string" },
  }),
  tool("computer_batch", "Execute a batch of computer-use actions.", {
    actions: { type: "array" },
  }),
];

function targetImageSize(width, height, params = API_RESIZE_PARAMS) {
  const maxWidth = params.maxWidth ?? width;
  const maxHeight = params.maxHeight ?? height;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return [Math.round(width * scale), Math.round(height * scale)];
}

function buildComputerUseTools(_capabilities, coordinateMode = "pixels", installedAppNames) {
  const appHint = Array.isArray(installedAppNames) && installedAppNames.length > 0
    ? ` Popular apps: ${installedAppNames.slice(0, 12).join(", ")}.`
    : "";

  return TOOL_DESCRIPTORS.map(toolDef => {
    if (toolDef.name !== "request_access") {
      return toolDef;
    }
    return {
      ...toolDef,
      description:
        `${toolDef.description} Coordinates are interpreted in ${coordinateMode} mode.` +
        appHint,
    };
  });
}

function fallbackToolResult(name) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Computer use shim active: "${name}" requires Anthropic's native ` +
          "@ant/computer-use-* packages, which are unavailable in this local replica.",
      },
    ],
    telemetry: {
      shim: true,
      tool_name: name,
      error_kind: "missing_native_runtime",
    },
    flags: DEFAULT_GRANT_FLAGS,
  };
}

function createComputerUseMcpServer(adapter, coordinateMode) {
  const server = new Server(
    { name: "computer-use", version: "0.0.0-shim" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildComputerUseTools(adapter?.executor?.capabilities, coordinateMode),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request =>
    fallbackToolResult(request.params.name),
  );

  return server;
}

function bindSessionContext(_adapter, _coordinateMode, _context) {
  return async name => fallbackToolResult(name);
}

module.exports = {
  API_RESIZE_PARAMS,
  DEFAULT_GRANT_FLAGS,
  bindSessionContext,
  buildComputerUseTools,
  createComputerUseMcpServer,
  targetImageSize,
};
