# MicroIDE microClaude 独立 Sidecar 正式发行方案

## 1. 目标

MicroIDE 要做成类似 Qoder、Trae、Cursor 一样的可下载安装桌面 AI IDE。核心形态是：

```text
MicroIDE Desktop App
  ├─ Code-OSS / Electron Shell
  ├─ Workbench AI UI
  ├─ Extension Host
  └─ microClaude Sidecar Engine
```

`microClaude` 不作为普通 VS Code 插件运行，也不要求用户单独安装命令行工具。它作为 MicroIDE 安装包内置的独立 sidecar 进程，由 Electron main process 管理生命周期，并通过结构化协议和 Workbench UI 通信。

该方案的目标：

- 用户下载一个安装包即可使用。
- `microClaude` 与 IDE 主进程隔离，崩溃、升级、重启不影响整个 IDE。
- 保留 microClaude 原有 CLI/agent 能力，优先通过 wrapper/bridge 接入，减少侵入式改造。
- 支持后续热更新 sidecar、灰度发布、多模型、多 MCP、企业策略和权限审计。
- 避免污染当前 `D:\project\microClaude` 原始代码，只基于 `D:\project\microIDE\microClaude` 副本开发。

## 2. 总体架构

```text
┌───────────────────────────────────────────────────────┐
│ MicroIDE Installer / Portable Package                  │
└───────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────┐
│ MicroIDE Electron Main Process                         │
│                                                       │
│  MicroClaudeSidecarService                             │
│   ├─ resolve bundled sidecar path                      │
│   ├─ spawn / restart / kill                            │
│   ├─ health check                                      │
│   ├─ session registry                                  │
│   ├─ permission gate                                   │
│   ├─ terminal / file / git mediation                   │
│   └─ JSON-RPC / stream event bridge                    │
└───────────────────────────────────────────────────────┘
        ▲                                      │
        │ IPC                                  │ stdio / named pipe / localhost
        ▼                                      ▼
┌──────────────────────────────┐     ┌──────────────────────────────┐
│ MicroIDE Workbench Renderer   │     │ microClaude Sidecar           │
│                              │     │                              │
│  Agent Panel                 │     │  microclaude-sidecar.exe      │
│  Quest / Spec View           │     │   ├─ cli adapter              │
│  Knowledge Center            │     │   ├─ agent runtime            │
│  Diff / Apply Review         │     │   ├─ MCP tools                │
│  Permission Center           │     │   └─ provider clients         │
└──────────────────────────────┘     └──────────────────────────────┘
```

关键原则：

- Electron main process 是控制面，不直接承载 agent 推理逻辑。
- sidecar 是执行面，负责 microClaude runtime、模型调用、MCP、工具编排。
- Workbench renderer 是展示面，只显示会话、任务、todo、diff、命令卡片、知识库进度。
- 文件写入、终端命令、git 操作等高风险动作必须经过 main process 的权限网关。

## 3. 为什么采用独立 sidecar

相比把 microClaude 直接塞进 Electron main process：

- sidecar 崩溃后可独立重启。
- native dependencies、PTY、MCP、模型 SDK 不会污染 IDE 主进程依赖树。
- 可以单独签名、单独更新、单独记录版本。
- 可以在不同平台使用不同 runtime 和 native binary。
- 企业版可以替换 sidecar 为私有构建。

相比普通 VS Code 插件：

- 不受 extension host 生命周期和 API 能力限制。
- 更容易实现深度 UI、diff zone、checkpoint、Knowledge Center、Spec/Quest。
- 能更好控制终端、文件系统、权限审批和自动模式策略。

## 4. 仓库与目录规划

当前工作区：

```text
D:\project\microIDE
  ├─ code-oss/              # Code-OSS fork baseline
  ├─ microClaude/           # microClaude 本地副本
  ├─ refs/                  # VSCodium / Void / Cline / Theia references
  └─ docs/
```

建议新增：

```text
D:\project\microIDE
  ├─ sidecars/
  │   └─ microclaude/
  │       ├─ adapter/       # IDE protocol wrapper
  │       ├─ packaging/     # per-platform package scripts/config
  │       ├─ schemas/       # JSON-RPC/event schemas
  │       └─ tests/         # sidecar protocol tests
  ├─ build/microide/
  │   ├─ product.microide.json
  │   ├─ patches/
  │   ├─ assets/
  │   └─ installers/
  └─ docs/
```

Code-OSS 内部建议新增：

```text
code-oss/src/vs/workbench/contrib/microide/
  ├─ browser/
  │   ├─ agentPanel/
  │   ├─ quest/
  │   ├─ knowledge/
  │   ├─ diffReview/
  │   └─ microide.contribution.ts
  ├─ common/
  │   ├─ microClaudeProtocol.ts
  │   ├─ microideTypes.ts
  │   └─ microideConfiguration.ts
  └─ electron-main/
      ├─ microClaudeSidecarService.ts
      ├─ microClaudeProcess.ts
      ├─ microClaudeChannel.ts
      └─ microidePermissionService.ts
```

## 5. 正式发行包目录

### Windows

```text
MicroIDE/
  ├─ MicroIDE.exe
  ├─ resources/
  │   └─ app/
  │       ├─ product.json
  │       ├─ out/
  │       └─ microide/
  │           └─ sidecars/
  │               └─ microclaude/
  │                   ├─ current/
  │                   │   ├─ microclaude-sidecar.exe
  │                   │   ├─ manifest.json
  │                   │   ├─ cli.js
  │                   │   ├─ node.exe 或 bun.exe
  │                   │   ├─ node_modules/
  │                   │   └─ vendor/
  │                   └─ versions/
  └─ locales/
```

### macOS

```text
MicroIDE.app/
  └─ Contents/
      ├─ MacOS/MicroIDE
      ├─ Resources/
      │   └─ app/
      │       └─ microide/sidecars/microclaude/current/
      │           ├─ microclaude-sidecar
      │           ├─ manifest.json
      │           ├─ cli.js
      │           ├─ node 或 bun
      │           └─ vendor/
      └─ Info.plist
```

### Linux

```text
/opt/MicroIDE/
  ├─ microide
  ├─ resources/app/
  │   └─ microide/sidecars/microclaude/current/
  │       ├─ microclaude-sidecar
  │       ├─ manifest.json
  │       ├─ cli.js
  │       ├─ node 或 bun
  │       └─ vendor/
  └─ locales/
```

用户数据不写安装目录，统一写入：

```text
Windows: %APPDATA%\MicroIDE\
macOS:   ~/Library/Application Support/MicroIDE/
Linux:   ~/.config/MicroIDE/
```

项目级数据写入：

```text
<workspace>/.microide/
  ├─ sessions/
  ├─ checkpoints/
  ├─ repowiki/
  ├─ memory/
  ├─ tasks/
  └─ logs/
```

## 6. Sidecar 打包策略

推荐优先级：

### 方案 A：Runtime Bundle，首个正式版推荐

把 microClaude 的 `cli.js`、必要依赖、native vendor、Node/Bun runtime 一起放入 sidecar 目录。

启动方式：

```text
microclaude-sidecar.exe
  -> bundled node.exe/bun.exe
  -> cli.js
  -> IDE protocol adapter
```

优点：

- 对 microClaude 侵入最小。
- 对 native modules 兼容最好。
- 方便 Windows/macOS/Linux 分平台验证。
- 适合首个可下载安装版本。

缺点：

- 包体较大。
- 需要处理 runtime 签名和依赖裁剪。

### 方案 B：Single Binary，后续优化

将 adapter 和 runtime 编译为单文件可执行程序。

优点：

- 分发清爽。
- 启动路径简单。

缺点：

- native modules、PTY、sharp、MCP 相关包可能不稳定。
- 对动态 import、文件型依赖、vendor binary 处理复杂。

结论：首个正式发行版采用 **方案 A Runtime Bundle**。等 sidecar 协议稳定后再评估单文件化。

## 7. Sidecar Manifest

每个 sidecar 包必须带 manifest：

```json
{
  "name": "microclaude",
  "version": "0.2.2",
  "protocolVersion": "1.0.0",
  "platform": "win32-x64",
  "entry": "microclaude-sidecar.exe",
  "runtime": {
    "type": "node",
    "version": ">=18"
  },
  "capabilities": {
    "chat": true,
    "agent": true,
    "applyPatch": true,
    "terminal": true,
    "mcp": true,
    "repoWiki": true,
    "memory": true
  },
  "checksum": {
    "sha256": "<release-sha256>"
  }
}
```

Electron main 启动前校验：

- platform 是否匹配。
- protocolVersion 是否兼容。
- checksum 是否匹配。
- entry 是否存在且可执行。
- runtime/native vendor 是否完整。

## 8. 进程启动与生命周期

### 启动时机

默认 lazy start：

- 打开 Agent Panel。
- 触发 Quest/Spec。
- 生成 Repo Wiki。
- 执行 `/microide.startAgent` 命令。

可配置 eager start：

- 企业版预热。
- 开启后台索引。
- 自动恢复上次会话。

### 启动参数

建议标准化为：

```text
microclaude-sidecar
  --protocol microide-jsonrpc-v1
  --transport stdio
  --workspace <absolute-workspace-path>
  --user-data-dir <MicroIDE-user-data>
  --project-data-dir <workspace>/.microide
  --session-id <optional-session-id>
  --log-dir <workspace>/.microide/logs
```

### 生命周期状态

```text
idle
starting
ready
busy
waiting_for_permission
restarting
stopped
crashed
```

### 崩溃恢复

- 5 秒内最多重启 1 次。
- 1 分钟内最多重启 3 次。
- 崩溃后保留最后 2000 行 sidecar log。
- UI 显示“恢复会话”或“查看日志”。
- 未提交文件变更不自动继续执行，必须用户确认。

## 9. 通信协议

首版建议使用 stdio JSON-RPC + NDJSON event stream。以后可切换 named pipe 或 localhost websocket。

### 请求格式

```json
{
  "jsonrpc": "2.0",
  "id": "req_001",
  "method": "session.start",
  "params": {
    "workspace": "D:/project/example",
    "mode": "agent",
    "autoApprove": false
  }
}
```

### 响应格式

```json
{
  "jsonrpc": "2.0",
  "id": "req_001",
  "result": {
    "sessionId": "sess_abc",
    "status": "ready"
  }
}
```

### 事件格式

```json
{
  "type": "event",
  "sessionId": "sess_abc",
  "event": "todo.update",
  "payload": {
    "items": [
      { "id": "t1", "text": "Inspect project structure", "status": "completed" },
      { "id": "t2", "text": "Implement feature", "status": "in_progress" }
    ]
  }
}
```

## 10. 核心方法

```text
sidecar.ping
sidecar.getCapabilities
session.start
session.resume
session.cancel
session.pause
session.dispose
message.send
message.continue
quest.createSpec
quest.build
knowledge.generateRepoWiki
knowledge.createCard
memory.read
memory.write
permission.resolve
tool.result
```

## 11. 核心事件

```text
assistant.delta
assistant.message
todo.update
tool.request
tool.result
file.proposedPatch
file.applied
terminal.request
terminal.output
terminal.exit
permission.request
permission.resolved
checkpoint.created
checkpoint.restored
knowledge.progress
knowledge.completed
spec.created
spec.updated
session.status
session.error
```

## 12. 权限模型

所有高风险操作必须经过 `MicroIdePermissionService`：

```text
sidecar proposes tool call
  -> main process receives tool.request
  -> permission policy evaluates
  -> renderer shows approval card if needed
  -> user accepts/rejects
  -> main process sends permission.resolve
  -> sidecar continues
```

权限分级：

```text
read-only:
  - read file
  - search
  - read diagnostics
  - read git status

review-required:
  - edit file
  - create file
  - delete file
  - git add/commit
  - terminal command

blocked-by-default:
  - destructive recursive delete
  - credential file access
  - network exfiltration of workspace archive
  - arbitrary shell outside workspace
  - install global package
```

自动模式只允许：

- 读文件、搜索、读取 diagnostics。
- 写入明确 diff 且可回滚的工作区文件。
- 执行项目白名单命令，例如 `npm test`、`npm run build`。
- 禁止无提示删除、移动大量文件、改系统配置、访问敏感路径。

## 13. 文件修改与 Checkpoint

推荐流程：

```text
sidecar emits file.proposedPatch
  -> main creates checkpoint
  -> workbench opens diff review
  -> user accepts file / hunk / all
  -> main applies patch through VS Code text model/file service
  -> sidecar receives file.applied
```

Checkpoint 存储：

```text
.microide/checkpoints/
  └─ <session-id>/
      ├─ manifest.json
      ├─ before/
      ├─ after/
      └─ patches/
```

`manifest.json`：

```json
{
  "sessionId": "sess_abc",
  "createdAt": "2026-06-04T12:00:00.000Z",
  "workspace": "D:/project/example",
  "files": [
    {
      "path": "src/index.ts",
      "beforeSha256": "...",
      "afterSha256": "...",
      "status": "modified"
    }
  ]
}
```

## 14. UI 对齐 Qoder/Qoder 截图

### Agent Panel

右侧面板：

- 用户 prompt。
- Agent 流式回复。
- Todo checklist。
- 文件变更卡片：`index.tsx +34 Applied`。
- 终端命令卡片：可取消、查看 terminal。
- 输入框：`Plan and build, @ for context, / for commands`。
- 模式切换：`Agent`、`Auto`、`Spec`、`Ask`。

### Quest / Spec

独立任务页：

- 左侧 agent 执行轨迹。
- 右侧 markdown spec preview。
- `Spec Written` 状态。
- `Build` 按钮。
- 任务完成后生成 implementation report。

### Knowledge Center

左侧 Knowledge 入口：

- `Repo Wiki`
- `Knowledge Card`
- `Memory`

Repo Wiki 需要显示：

- 生成进度。
- 文档树。
- markdown 预览/编辑。
- 更新、重新生成、锁定页面。

## 15. Code-OSS 接入点

### Electron Main

实现：

```text
src/vs/workbench/contrib/microide/electron-main/microClaudeSidecarService.ts
```

职责：

- 解析 sidecar 路径。
- 启动/停止进程。
- 维护 session map。
- 处理 stdio JSON-RPC。
- 代理权限请求。
- 写日志。

### Browser Renderer

实现：

```text
src/vs/workbench/contrib/microide/browser/
```

职责：

- Agent Panel。
- Quest/Spec UI。
- Knowledge UI。
- Diff Review UI。
- Permission Cards。

### Common Protocol

实现：

```text
src/vs/workbench/contrib/microide/common/microClaudeProtocol.ts
```

职责：

- TypeScript 类型。
- JSON schema。
- 版本兼容判断。

## 16. 打包与安装器

### 产品配置

新增：

```text
build/microide/product.microide.json
```

关键字段：

```json
{
  "nameShort": "MicroIDE",
  "nameLong": "MicroIDE",
  "applicationName": "microide",
  "dataFolderName": ".microide",
  "win32DirName": "MicroIDE",
  "win32NameVersion": "MicroIDE",
  "darwinBundleIdentifier": "com.microide.desktop",
  "linuxIconName": "microide",
  "urlProtocol": "microide"
}
```

### 平台产物

```text
Windows:
  MicroIDESetup-x64.exe
  MicroIDESetup-arm64.exe

macOS:
  MicroIDE-darwin-x64.dmg
  MicroIDE-darwin-arm64.dmg

Linux:
  microide_amd64.deb
  microide_x86_64.rpm
  MicroIDE-x86_64.AppImage
```

### 签名

- Windows: Authenticode。
- macOS: Developer ID + notarization。
- Linux: deb/rpm repo signing。
- sidecar binary/runtime 同样需要签名或 checksum 校验。

## 17. Sidecar 更新策略

IDE 主程序和 sidecar 可分开更新：

```text
MicroIDE app version: 0.1.0
microClaude sidecar version: 0.2.2
protocol version: 1.0.0
```

更新前检查：

- protocol version 是否兼容。
- sidecar manifest checksum 是否正确。
- 是否存在运行中的 session。
- 是否有未提交 checkpoint。

更新流程：

```text
download new sidecar package
  -> verify signature/checksum
  -> unpack to versions/<version>
  -> run smoke test: sidecar.ping
  -> switch current pointer
  -> restart sidecar
```

回滚：

- 保留最近 2 个 sidecar 版本。
- 新版本启动失败自动回滚。
- protocol 不兼容时提示升级 IDE 主程序。

## 18. 日志与诊断

日志位置：

```text
<workspace>/.microide/logs/
  ├─ sidecar.log
  ├─ sidecar.stderr.log
  ├─ protocol.ndjson
  └─ permission-audit.ndjson
```

隐私要求：

- 默认不上传日志。
- 错误上报必须用户明确同意。
- 日志脱敏 API key、token、cookie、ssh key。
- 企业版支持完全关闭遥测。

## 19. 安全边界

必须实现：

- Workspace Trust 集成。
- 敏感文件访问拦截。
- 命令执行审批。
- 自动模式白名单。
- MCP server 权限隔离。
- 网络访问审计。
- 文件写入 checkpoint。
- Sidecar checksum 校验。

建议敏感路径：

```text
.env
.env.*
id_rsa
id_ed25519
*.pem
*.key
*.p12
credentials
secrets
token
cookies
```

## 20. 第一阶段 MVP

目标：做出可下载安装的 MicroIDE 内测版，内置 microClaude sidecar，能完成基础 agent 任务。

范围：

- Code-OSS 品牌替换为 MicroIDE。
- sidecar bundle 目录随 app 打包。
- Electron main 启动 microClaude sidecar。
- Agent Panel 发送 prompt。
- sidecar 返回流式 assistant 消息。
- 支持 read/search。
- 支持 proposed file patch。
- 支持 terminal command request + approval。
- 支持 session cancel。
- 生成基础日志。

暂不做：

- Repo Wiki 全量索引。
- 多 agent board。
- sidecar 热更新。
- 企业策略中心。
- 云端同步。

## 21. 第二阶段

- Quest/Spec 模式。
- Todo 卡片。
- 文件变更卡片。
- Checkpoint 回滚。
- Knowledge Center: Repo Wiki、Knowledge Card、Memory。
- MCP marketplace。
- Provider/model 设置页。
- Open VSX 默认扩展市场。

## 22. 第三阶段

- Sidecar 独立在线更新。
- 多 workspace session。
- Multi-agent worktree board。
- 企业策略、审计、离线包。
- 云端任务、远程容器、浏览器预览。
- ACP/CLI integration，兼容外部 agent。

## 23. 验收标准

安装体验：

- Windows/macOS/Linux 可以下载安装并启动。
- 用户不需要安装 Node、Bun、microClaude CLI。
- 首次打开能找到 sidecar，并通过 health check。

Agent 体验：

- Agent Panel 可发送消息并流式显示。
- 可以读取当前项目文件。
- 文件修改以 diff/review 形式出现。
- 终端命令必须显示审批卡片。
- 可取消正在运行的任务。

稳定性：

- sidecar crash 不导致 MicroIDE 退出。
- sidecar 可重启。
- 日志可定位启动失败原因。
- sidecar version/protocol mismatch 有明确提示。

安全性：

- 自动模式不能绕过高风险权限。
- 敏感文件读取有提示或阻断。
- 所有写操作有 checkpoint。
- sidecar checksum 校验失败禁止启动。

## 24. 立即可执行的开发任务

1. 新建 `sidecars/microclaude/adapter`，实现 microide-jsonrpc-v1 wrapper。
2. 新建 `sidecars/microclaude/schemas`，定义 request/response/event 类型。
3. 在 Code-OSS 新建 `src/vs/workbench/contrib/microide`。
4. 实现 `MicroClaudeSidecarService`，先支持 `ping`、`session.start`、`message.send`、`session.cancel`。
5. 实现最小 Agent Panel。
6. 添加 sidecar bundle copy task 到 build pipeline。
7. 新增 `product.microide.json` 和品牌 patch。
8. 产出 Windows x64 内测安装包。

## 25. 推荐决策

正式发行方案采用：

```text
Code-OSS fork
  + native MicroIDE workbench contribution
  + Electron main managed microClaude sidecar
  + Runtime Bundle sidecar packaging
  + JSON-RPC / event stream protocol
  + permission/checkpoint gateway
```

这是最接近 Qoder/Trae/Cursor 类桌面 AI IDE 的路线，也最适合当前已有 `microClaude` 引擎代码的情况。
