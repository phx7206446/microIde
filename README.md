# MicroWorker

MicroWorker is a MicroIDE/Coding Agent workspace built on the Code OSS workbench, with a custom WorkBuddy-style task UI and a local microClaude sidecar.

## Repository Layout

- `code-oss/` - the Electron/Code OSS workbench fork and MicroWorker frontend.
- `sidecars/microclaude/` - the bridge process used by the workbench to talk to the agent engine.
- `microClaude/` - the bundled agent CLI/runtime source and checked-in CLI bundle.
- `build/microide/` - release staging scripts for sidecar resources.
- `docs/` - design, build, and integration notes.
- `scripts/` - helper scripts for local dependency setup.

## What Is Not Committed

Local dependencies, build output, Electron downloads, user data, logs, caches, and machine-local runtime configuration are intentionally ignored. Configure model credentials locally through your own runtime config or environment variables.

## Local Development

From the repository root:

```powershell
cd code-oss
npm ci
npm run compile-client
.\scripts\code.bat ..
```

If you use the bundled Windows Node runtime from a local checkout, prepend it to `PATH` before installing or compiling.

```powershell
$env:PATH = "$PWD\..\.tools\node-v24.15.0-win-x64;$env:PATH"
```

See `docs/microide-build-and-launch-process.md` for the longer build and launch checklist.
