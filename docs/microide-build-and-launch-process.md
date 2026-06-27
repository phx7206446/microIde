# MicroIDE 编译与启动流程记录

更新时间：2026-06-06

本文档记录当前项目在 Windows / PowerShell 环境下的完整编译、Electron 运行时准备和开发版启动流程。

## 1. 项目目录

当前 workspace 根目录：

```powershell
D:\project\microIDE
```

Code-OSS 主工程目录：

```powershell
D:\project\microIDE\code-oss
```

当前项目根目录 `D:\project\microIDE` 没有 `package.json`，因此不能在根目录直接执行：

```powershell
npm run compile-client
```

正确的执行目录是：

```powershell
D:\project\microIDE\code-oss
```

## 2. 使用项目内置 Node

当前使用项目内置 Node：

```powershell
D:\project\microIDE\.tools\node-v24.15.0-win-x64\node.exe
```

为避免系统 Node 版本不一致，建议每次编译前先把内置 Node 放到 `Path` 最前面：

```powershell
$env:Path='D:\project\microIDE\.tools\node-v24.15.0-win-x64;' + $env:Path
```

## 3. 编译命令

进入 Code-OSS 工程目录：

```powershell
Set-Location D:\project\microIDE\code-oss
```

执行编译：

```powershell
$env:Path='D:\project\microIDE\.tools\node-v24.15.0-win-x64;' + $env:Path
D:\project\microIDE\.tools\node-v24.15.0-win-x64\npm.cmd run compile-client
```

对应 `code-oss/package.json` 中的脚本：

```json
{
  "compile-client": "npm run gulp compile"
}
```

本次编译结果：

```text
compile-src: 0 errors
compile-client: success
```

编译成功后，输出目录主要在：

```text
D:\project\microIDE\code-oss\out
```

## 4. 准备 Electron 开发运行时

如果 `.build\electron` 不存在，需要先执行 `preLaunch.ts` 准备 Electron 运行时和内置扩展：

```powershell
$env:Path='D:\project\microIDE\.tools\node-v24.15.0-win-x64;' + $env:Path
D:\project\microIDE\.tools\node-v24.15.0-win-x64\node.exe build/lib/preLaunch.ts
```

成功后会生成：

```text
D:\project\microIDE\code-oss\.build\electron\MicroIDE.exe
```

本次确认到的 Electron 开发运行时目录：

```text
D:\project\microIDE\code-oss\.build\electron
```

其中主可执行文件为：

```text
D:\project\microIDE\code-oss\.build\electron\MicroIDE.exe
```

## 5. 正确启动命令

开发态启动前必须确保没有设置 `ELECTRON_RUN_AS_NODE=1`。如果该环境变量存在，Electron 会被当成 Node 执行，导致启动失败。

推荐启动命令：

```powershell
Set-Location D:\project\microIDE\code-oss

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$env:NODE_ENV='development'
$env:VSCODE_DEV='1'
$env:VSCODE_CLI='1'
$env:ELECTRON_ENABLE_LOGGING='1'
$env:ELECTRON_ENABLE_STACK_DUMPING='1'

Start-Process `
  -FilePath 'D:\project\microIDE\code-oss\.build\electron\MicroIDE.exe' `
  -ArgumentList '.','--disable-extension=vscode.vscode-api-tests','--skip-welcome' `
  -WorkingDirectory 'D:\project\microIDE\code-oss'
```

本次最终成功启动的窗口信息：

```text
Process: MicroIDE
Window title: MicroIDE Dev
PID: 64684
```

PID 每次启动都会变化，不能作为固定值使用。

## 6. 完整一键流程

从仓库根目录执行：

```powershell
Set-Location D:\project\microIDE\code-oss

$env:Path='D:\project\microIDE\.tools\node-v24.15.0-win-x64;' + $env:Path

D:\project\microIDE\.tools\node-v24.15.0-win-x64\npm.cmd run compile-client

D:\project\microIDE\.tools\node-v24.15.0-win-x64\node.exe build/lib/preLaunch.ts

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$env:NODE_ENV='development'
$env:VSCODE_DEV='1'
$env:VSCODE_CLI='1'
$env:ELECTRON_ENABLE_LOGGING='1'
$env:ELECTRON_ENABLE_STACK_DUMPING='1'

Start-Process `
  -FilePath 'D:\project\microIDE\code-oss\.build\electron\MicroIDE.exe' `
  -ArgumentList '.','--disable-extension=vscode.vscode-api-tests','--skip-welcome' `
  -WorkingDirectory 'D:\project\microIDE\code-oss'
```

如果 `.build\electron\MicroIDE.exe` 已经存在，可以跳过 `preLaunch.ts`，只重新编译并启动。

## 7. 本次遇到的问题和原因

### 7.1 在仓库根目录执行 npm 脚本失败

错误：

```text
npm error enoent Could not read package.json
```

原因：

```text
D:\project\microIDE
```

不是 npm 工程根目录。正确目录是：

```text
D:\project\microIDE\code-oss
```

### 7.2 错误使用 npm run electron 并传入运行参数

错误命令形态：

```powershell
npm run electron -- --disable-updates --skip-welcome
```

该脚本实际调用：

```text
node build/lib/electron.ts
```

`electron.ts` 只接受一个架构参数，例如 x64/arm64。传入 `--disable-updates` 后，脚本会误把它当成架构，进而尝试下载错误文件：

```text
electron-v42.2.0-win32---disable-updates.zip
```

因此不要用 `npm run electron -- <app args>` 来启动 IDE。

### 7.3 scripts\code.bat 可能使用系统 Node

`scripts\code.bat` 内部会执行：

```bat
node build/lib/preLaunch.ts
```

如果当前 shell 的 `Path` 中系统 Node 排在前面，可能会使用不兼容的 Node 版本，出现：

```text
ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"
```

规避方式：

- 编译和 preLaunch 显式使用项目内置 Node。
- 或在调用前确保内置 Node 在 `Path` 最前面。
- 如果 `.build\electron` 已准备好，可以直接启动 `.build\electron\MicroIDE.exe`。

### 7.4 ELECTRON_RUN_AS_NODE 导致 Electron 被当成 Node

错误：

```text
SyntaxError: The requested module 'electron' does not provide an export named 'Menu'
```

表现：

```powershell
.build\electron\MicroIDE.exe --version
```

输出类似：

```text
v24.15.0
```

这说明 Electron exe 被 `ELECTRON_RUN_AS_NODE=1` 影响，进入了 Node 模式，而不是 Electron app 模式。

修复：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

然后重新启动：

```powershell
Start-Process `
  -FilePath 'D:\project\microIDE\code-oss\.build\electron\MicroIDE.exe' `
  -ArgumentList '.','--disable-extension=vscode.vscode-api-tests','--skip-welcome' `
  -WorkingDirectory 'D:\project\microIDE\code-oss'
```

## 8. 启动状态检查

启动后可以检查进程：

```powershell
Get-Process | Where-Object {
  $_.ProcessName -match 'MicroIDE|Code|Electron|node|cmd'
} | Select-Object Id,ProcessName,MainWindowTitle,StartTime |
Sort-Object StartTime -Descending |
Select-Object -First 30
```

成功时应看到类似：

```text
Id      ProcessName   MainWindowTitle   StartTime
64684   MicroIDE      MicroIDE Dev      2026/6/6 11:05:37
```

也可以检查指定 PID：

```powershell
Get-Process -Id <PID> | Select-Object Id,ProcessName,MainWindowTitle,StartTime
```

## 9. 推荐后续改进

建议在仓库中增加一个专用脚本，例如：

```text
scripts/microide-dev.ps1
```

该脚本统一完成：

1. 切换到 `code-oss` 目录。
2. 注入项目内置 Node 到 `Path`。
3. 执行 `compile-client`。
4. 检查并准备 `.build\electron`。
5. 清除 `ELECTRON_RUN_AS_NODE`。
6. 设置开发态环境变量。
7. 启动 `.build\electron\MicroIDE.exe`。

这样可以避免后续再次踩到系统 Node、`npm run electron` 参数误用和 `ELECTRON_RUN_AS_NODE` 这三个问题。
