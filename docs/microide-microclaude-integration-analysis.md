# MicroIDE 接入 microClaude 作为 AI Coding 引擎的实现分析

更新时间：2026-06-06

## 1. 结论概览

当前 MicroIDE 接入 microClaude 的方式是进程隔离式 sidecar 架构，而不是在 Workbench 前端或 Electron 主进程中直接引入 microClaude 代码。

整体链路如下：

```text
Agent Panel UI
  -> MicroIDEAgentService
  -> IMicroClaudeSidecarService
  -> Electron IPC / ProxyChannel
  -> Electron Main MicroClaudeSidecarService
  -> MicroClaudeSidecarProcess
  -> sidecars/microclaude/adapter/index.js
  -> MicroClaudeCliEngine
  -> microClaude/cli.js
  -> stream-json events
  -> Agent Panel 渲染
```

这个设计把 UI 状态管理、Electron 进程管理、microClaude CLI 执行和事件协议转换分开处理。Workbench 负责交互和状态展示，Electron main 负责托管 sidecar 进程，sidecar adapter 负责把 MicroIDE 内部 JSON-RPC 协议转换为 microClaude CLI 的 stream-json 协议，microClaude CLI 才是真正执行 AI coding、工具调用、文件修改和权限交互的引擎。

## 2. 关键代码位置

### 2.1 Workbench UI 和 Agent Panel

主要文件：

```text
code-oss/src/vs/workbench/contrib/microide/browser/microideAgentViews.ts
code-oss/src/vs/workbench/contrib/microide/browser/media/microideAgent.css
code-oss/src/vs/workbench/contrib/microide/electron-browser/microide.contribution.ts
```

职责：

- 注册并渲染 MicroIDE Agent Panel。
- 处理输入框提交、发送/停止按钮、会话 tab、历史会话、模型栏、权限模式浮窗和 slash command 浮窗。
- 渲染 assistant 消息、tool result、permission request 和 diff preview。

用户在 Agent Panel 输入内容后，UI 层不会直接调用 microClaude，而是调用：

```ts
this.microIDEAgentService.sendPrompt(prompt)
```

这意味着 UI 只依赖 `IMicroIDEAgentService`，不会感知 microClaude CLI 的进程、协议和 runtime 细节。

### 2.2 Workbench Agent 服务

主要文件：

```text
code-oss/src/vs/workbench/contrib/microide/browser/microideAgentService.ts
code-oss/src/vs/workbench/contrib/microide/common/microideAgentService.ts
code-oss/src/vs/workbench/contrib/microide/common/microideLocalAuthConfig.ts
```

`MicroIDEAgentService` 是 browser 侧的核心编排层。它注入：

```ts
@IMicroClaudeSidecarService private readonly microClaudeSidecarService
```

它负责：

- 本地账号密码登录校验。
- 初始化 sidecar 能力和配置。
- 创建、切换、销毁 microClaude session。
- 发送 prompt 到 sidecar。
- 维护 selected model 和 permission mode。
- 接收 sidecar 流式事件并转换为 UI state。
- 生成 tool result 和 diff preview。
- 处理 cancel 和 permission resolve。

登录配置当前写死在：

```text
code-oss/src/vs/workbench/contrib/microide/common/microideLocalAuthConfig.ts
```

当前值为：

```ts
export const MICROIDE_LOCAL_AUTH_CONFIG = {
  username: 'microide',
  password: 'microclaude',
  displayName: 'MicroIDE'
};
```

当前实现逻辑是：编辑器本体不依赖登录，未登录仍可完成普通代码编辑和文件编辑；但调用 microClaude Agent 能力前会执行登录校验。`sendPrompt()`、`setSelectedModel()`、`setPermissionMode()`、`startNewSession()` 等 Agent 能力入口都会检查认证状态。

## 3. Workbench 到 Electron Main 的 IPC 桥接

主要文件：

```text
code-oss/src/vs/platform/microide/common/microClaudeSidecarService.ts
code-oss/src/vs/platform/microide/electron-browser/microClaudeSidecarService.ts
code-oss/src/vs/code/electron-main/app.ts
```

公共接口定义在：

```text
code-oss/src/vs/platform/microide/common/microClaudeSidecarService.ts
```

核心接口包括：

```ts
ping(): Promise<IMicroClaudePingResult>;
getCapabilities(): Promise<IMicroClaudeCapabilitiesResult>;
getConfiguration(): Promise<IMicroClaudeConfiguration>;
startSession(params): Promise<IMicroClaudeStartSessionResult>;
resumeSession(params): Promise<IMicroClaudeStartSessionResult>;
sendMessage(params): Promise<IMicroClaudeSendMessageResult>;
cancelSession(sessionId): Promise<IMicroClaudeCancelSessionResult>;
disposeSession(sessionId): Promise<IMicroClaudeDisposeSessionResult>;
resolvePermission(params): Promise<IMicroClaudeResolvePermissionResult>;
```

Browser 侧实现是一个 IPC proxy：

```ts
ProxyChannel.toService<IMicroClaudeSidecarService>(
  mainProcessService.getChannel(MicroClaudeSidecarChannelName)
)
```

Electron main 侧在 `app.ts` 中注册同名 channel：

```ts
const microClaudeSidecarChannel = ProxyChannel.fromService(
  accessor.get(IMicroClaudeSidecarService),
  disposables
);
mainProcessElectronServer.registerChannel(
  MicroClaudeSidecarChannelName,
  microClaudeSidecarChannel
);
```

因此 Workbench renderer 中调用 `IMicroClaudeSidecarService`，实际会跨进程调用 Electron main 中的 `MicroClaudeSidecarService`。

## 4. Electron Main 如何托管 sidecar

主要文件：

```text
code-oss/src/vs/platform/microide/electron-main/microClaudeSidecarService.ts
code-oss/src/vs/platform/microide/electron-main/microClaudeSidecarProcess.ts
```

`MicroClaudeSidecarService` 是 Electron main 侧服务。它内部创建 `MicroClaudeSidecarProcess`，并把服务方法转换成 JSON-RPC 方法名：

```text
ping              -> sidecar.ping
getCapabilities   -> sidecar.getCapabilities
getConfiguration  -> sidecar.getConfiguration
startSession      -> session.start
resumeSession     -> session.resume
sendMessage       -> message.send
cancelSession     -> session.cancel
disposeSession    -> session.dispose
resolvePermission -> permission.resolve
```

sidecar 进程默认使用 Node runtime 启动 adapter：

```ts
spawn(this.options.runtimePath, args, {
  cwd: this.options.sidecarRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ...this.options.env
  },
  windowsHide: true
})
```

默认解析的关键路径包括：

```text
sidecarRoot:
  <defaultRoot>/sidecars/microclaude

sidecar entry:
  <sidecarRoot>/adapter/index.js

microClaude CLI:
  <defaultRoot>/microClaude/cli.js

config:
  .runtime/microide/microclaude.config.json
```

支持的主要环境变量包括：

```text
MICROIDE_RELEASE_ROOT
MICROIDE_ROOT
MICROIDE_WORKSPACE
MICROIDE_USER_DATA_DIR
MICROIDE_PROJECT_DATA_DIR
MICROIDE_MICROCLAUDE_SIDECAR_ROOT
MICROIDE_MICROCLAUDE_SIDECAR_ENTRY
MICROIDE_MICROCLAUDE_SIDECAR_RUNTIME
MICROIDE_MICROCLAUDE_ENGINE
MICROIDE_MICROCLAUDE_CLI
MICROIDE_MICROCLAUDE_RUNTIME
MICROIDE_MICROCLAUDE_CONFIG
MICROIDE_MICROCLAUDE_DEFAULT_CONFIG
MICROIDE_MICROCLAUDE_REQUEST_TIMEOUT_MS
```

这说明当前实现已经为开发态和正式安装包态做了路径抽象。开发态可以使用 workspace 内的 `sidecars/microclaude` 和 `microClaude/cli.js`，正式包可以使用 `resources/microide` 下的内置产物。

## 5. Sidecar Adapter 的协议和职责

主要文件：

```text
sidecars/microclaude/adapter/index.js
sidecars/microclaude/adapter/transport.js
sidecars/microclaude/adapter/config.js
sidecars/microclaude/adapter/sessionStore.js
```

adapter 使用 stdin/stdout 上的 NDJSON/JSON-RPC 通信。Electron main 写入 JSON-RPC request，adapter 读取后按 method 分发：

```text
sidecar.ping
sidecar.getCapabilities
sidecar.getConfiguration
session.start
session.resume
session.cancel
session.dispose
message.send
message.continue
permission.resolve
```

adapter 内部维护 session store 和 active turns。`message.send` 收到 prompt 后，会：

1. 校验 `sessionId`。
2. 查找对应 session。
3. 创建 `AbortController`。
4. 标记 session 为 busy。
5. 调用 engine 的 `sendMessage()`。
6. 异步把 engine 输出事件转发给 Electron main。
7. 完成或失败后更新 session 状态。

adapter 本身不是 AI 引擎，它是协议桥和生命周期管理层。

## 6. microClaude CLI Engine 的接入方式

主要文件：

```text
sidecars/microclaude/adapter/microClaudeCliEngine.js
sidecars/microclaude/adapter/microClaudeMessageMapper.js
microClaude/cli.js
```

adapter 根据 `--engine` 选择引擎：

```js
if (args.engine === 'microclaude') {
  return new MicroClaudeCliEngine(...)
}

return new LightweightEngine()
```

真实 AI coding 引擎是 `MicroClaudeCliEngine`。它使用 Node runtime 启动 `microClaude/cli.js`，启动参数类似：

```text
microClaude/cli.js
  --print
  --bare
  --input-format stream-json
  --output-format stream-json
  --verbose
  --include-partial-messages
  --replay-user-messages
  --permission-prompt-tool stdio
  --session-id <sessionId>
  [permission args]
```

权限参数映射为：

```text
acceptEdits        -> --permission-mode acceptEdits
bypassPermissions -> --dangerously-skip-permissions
ask/default        -> 不追加自动批准参数
```

prompt 发送方式是向 microClaude CLI stdin 写入 stream-json user message：

```js
writeJson(handle.child.stdin, createUserMessage(session.id, prompt));
```

这代表 MicroIDE 和 microClaude CLI 之间使用流式 JSON 协议通信，支持连续 session、流式 assistant 输出、工具调用、权限请求和取消任务。

## 7. 模型和 Provider 配置

主要文件：

```text
sidecars/microclaude/adapter/config.js
```

配置加载顺序是：

1. 默认配置文件。
2. 用户或运行时配置文件。
3. 环境变量和 model 级别 env。

adapter 会规范化模型配置，并向 UI 暴露：

```ts
interface IMicroClaudeConfiguration {
  configPath?: string;
  defaultModel: string;
  selectedModel: string;
  baseUrl?: string;
  models: readonly IMicroClaudeModelConfiguration[];
}
```

支持的关键 env 包括：

```text
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_API_KEY
ANTHROPIC_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL
OPENAI_MODEL
OPENAI_BASE_URL
OPENAI_API_KEY
OLLAMA_MODEL
OLLAMA_BASE_URL
OLLAMA_API_KEY
CLAUDE_CODE_USE_OPENAI_COMPATIBLE
CLAUDE_CODE_USE_OLLAMA
CLAUDE_CONFIG_DIR
```

Workbench 的模型下拉框来自 `getConfiguration()` 或 `ping()` 返回的 `configuration.models`。切换模型时，Workbench 会更新 `selectedModel`，如果已有 session，会重新创建或切换 session，使后续 `sendMessage()` 使用新的 model。

## 8. 权限模式如何串联

Workbench UI 中的权限模式是：

```ts
type MicroIDEPermissionMode = 'ask' | 'auto' | 'fullAccess';
```

Workbench 服务映射到 sidecar session 参数：

```text
ask:
  autoApprove: false

auto:
  autoApprove: true
  permissionMode: acceptEdits

fullAccess:
  autoApprove: true
  permissionMode: bypassPermissions
```

sidecar 再把这些值转换成 microClaude CLI 参数：

```text
acceptEdits        -> --permission-mode acceptEdits
bypassPermissions -> --dangerously-skip-permissions
```

当 microClaude CLI 发出权限请求时，`MicroClaudeMessageMapper` 会映射为：

```text
permission.request
```

Workbench 收到后展示在 Agent Panel 的权限浮窗或 pending 状态中。用户批准或拒绝时，Workbench 调用：

```ts
microClaudeSidecarService.resolvePermission({ requestId, approve, reason })
```

sidecar adapter 再把结果写回 microClaude CLI stdin：

```json
{
  "type": "control_response",
  "request_id": "...",
  "response": {
    "approved": true
  }
}
```

## 9. 事件回流和 UI 渲染

协议事件定义在：

```text
code-oss/src/vs/platform/microide/common/microClaudeProtocol.ts
```

当前支持的主要事件：

```text
assistant.delta
assistant.message
todo.update
tool.request
tool.result
permission.request
permission.cancel
engine.started
engine.stdout
engine.stderr
session.result
session.status
session.error
```

microClaude CLI 输出先由：

```text
sidecars/microclaude/adapter/microClaudeMessageMapper.js
```

转换为 MicroIDE sidecar event。Electron main 的 `MicroClaudeSidecarProcess` 解析 stdout，如果识别为 sidecar event，就触发：

```ts
onDidEmitEvent
```

Workbench 的 `MicroIDEAgentService` 注册监听：

```ts
this.microClaudeSidecarService.onDidEmitEvent(
  event => this.acceptSidecarEvent(event)
)
```

随后按事件类型更新 UI state：

- `assistant.delta`：追加流式文本。
- `assistant.message`：完成 assistant 消息。
- `tool.request`：创建 tool message。
- `tool.result`：更新 tool message，必要时生成 diff preview。
- `permission.request`：加入 pending permission 列表。
- `session.status`：更新 session busy/ready 状态。
- `session.result`：完成当前 turn。
- `session.error`：展示错误并标记当前 turn 失败。

涉及代码或文件修改的工具结果会在 Workbench 层转换为 diff preview，再由 Agent Panel 用 diff 格式展示。

## 10. AI Coding 能力对应关系

当前接入已经覆盖 AI coding 中的核心能力：

```text
会话管理:
  startSession / resumeSession / disposeSession

模型选择:
  configuration.models / selectedModel / setSelectedModel

自然语言任务:
  sendPrompt -> message.send -> microClaude CLI

流式回复:
  assistant.delta / assistant.message

工具调用展示:
  tool.request / tool.result

代码和文件修改展示:
  tool result -> diff preview -> Agent Panel diff UI

权限控制:
  permission.request / permission.resolve

取消任务:
  cancelSession -> AbortController -> kill/abort active turn

Slash command:
  UI 输入 "/" 后弹出命令建议，实际作为 prompt 文本交给 microClaude CLI 处理
```

因此 Agent Panel 本身是 microClaude 能力的 IDE UI 外壳，具体智能能力仍来自 microClaude CLI。

## 11. 运行时和安装包依赖

当前实现倾向使用 Node 运行 sidecar adapter 和 microClaude CLI。生产包需要包含：

```text
resources/microide/
  sidecars/microclaude/
    adapter/index.js
    transport.js
    config.js
    microClaudeCliEngine.js
    microClaudeMessageMapper.js
    sessionStore.js
    manifest.json
  microClaude/
    cli.js
    package.json
    node_modules/
    vendor/
    stubs/
  defaults/
    microclaude.config.json
  runtime/
    node.exe 或 bin/node
```

如果正式安装包内缺少 `microClaude/cli.js`，而 engine 被设置为 `microclaude`，sidecar 会启动失败并报找不到 CLI。如果开发态或某些环境下 engine 被设置为 `lightweight`，则只会使用轻量 fallback engine，不具备完整 microClaude AI coding 能力。

因此要做到“安装包安装即可使用全部能力，无需用户额外安装 microClaude”，必须保证：

- 内置 Node runtime。
- 内置 `sidecars/microclaude` adapter。
- 内置 `microClaude/cli.js`。
- 内置 microClaude 运行所需依赖。
- 内置默认 `microclaude.config.json`。
- 打包路径和 Electron main 的 `resolveSidecarOptions()` 一致。

## 12. 当前架构的优点

### 12.1 解耦明确

Workbench 不直接依赖 microClaude 内部实现。microClaude 可以继续作为 CLI 演进，只要 stream-json 协议和 adapter 映射保持稳定，IDE 层改动较小。

### 12.2 进程隔离

microClaude CLI 崩溃不会直接拖垮 Workbench renderer。Electron main 可以管理 sidecar 生命周期，后续也可以加入重启、健康检查、日志采集和版本探测。

### 12.3 适合打包发布

Node runtime、sidecar adapter、microClaude CLI 和配置都可以放进 `resources/microide`，用户无需手动安装命令行工具。

### 12.4 便于权限治理

权限请求通过结构化事件回到 Workbench，UI 可以控制 ask/auto/fullAccess，并且可以在 IDE 层展示、审计和拦截。

### 12.5 支持完整 AI coding UI

流式文本、tool result、diff、permission、session tab、stop/cancel 都通过事件模型串起来，适合继续扩展成更完整的 Agent IDE。

## 13. 当前需要关注的风险点

### 13.1 stdout 必须保持协议干净

sidecar adapter 和 microClaude CLI 之间、Electron main 和 sidecar adapter 之间都依赖 stdout JSON line。非 JSON 日志如果直接写 stdout，可能破坏协议解析。日志应进入 stderr 或结构化 event。

### 13.2 fallback engine 可能掩盖正式引擎缺失

`lightweight` engine 只适合 smoke/dev，不代表完整 microClaude 能力。发布测试中必须确认 engine 为 `microclaude`，并且真实 CLI 已启动。

### 13.3 登录只是本地 gate

当前登录只是在 Workbench 层做本地硬编码校验，用来控制 Agent 能力入口。它不是服务端认证，也不提供强安全边界。如果未来要接入真实账号体系，需要替换 `microideLocalAuthConfig.ts` 和 `signIn()` 逻辑。

### 13.4 session tab 目前主要是前端状态

当前 Workbench 维护 session tabs 和 active session 状态。要支持真正持久化历史会话，需要进一步确认 session store 是否落盘，以及 Workbench 是否能按历史 session resume。

### 13.5 权限模式需要与 microClaude CLI 保持兼容

Workbench 的 `ask/auto/fullAccess` 最终会转换为 CLI 参数。如果 microClaude CLI 后续调整权限参数名称或语义，adapter 的 `permissionArgs()` 需要同步更新。

### 13.6 打包路径必须严格一致

Electron main 的默认路径是按 `resources/microide` 或开发态 workspace 推导的。打包脚本必须确保目录结构和 `resolveSidecarOptions()` 的默认路径完全匹配。

## 14. 后续优化建议

1. 增加 sidecar 运行态诊断面板或命令，明确展示当前 engine、CLI path、runtime path、config path 和 selected model。
2. 发布包测试中强制校验 `engine === 'microclaude'`，避免误用 lightweight engine。
3. 对 sidecar stdout 协议增加更严格的错误提示，遇到非 JSON 行时输出来源和最近 stderr。
4. 为 `message.send -> tool.result -> diff preview` 增加端到端 smoke test。
5. 为权限请求增加持久化审计记录，包括 tool name、input、approve/deny、timestamp、sessionId。
6. 将本地硬编码登录抽象为 auth provider，保留当前 local provider，便于后续替换真实账号体系。
7. 对 session history 做明确设计：仅 UI 内存态、sidecar 内存态、还是磁盘持久化态，需要在产品层确定。

## 15. 最终判断

当前 MicroIDE 已经形成了清晰的 microClaude AI coding 引擎接入闭环：

```text
UI 负责交互
Workbench service 负责状态和权限
Electron main 负责进程托管
sidecar adapter 负责协议转换
microClaude CLI 负责真实 AI coding 能力
```

这条链路符合桌面 AI IDE 的工程形态，也满足“安装包内置 microClaude 后无需用户额外安装”的目标。后续重点不在重写接入方式，而在完善发布包校验、真实 engine 诊断、权限审计、会话持久化和端到端测试。
