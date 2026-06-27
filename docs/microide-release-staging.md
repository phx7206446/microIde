# MicroIDE Release Staging

This document records the concrete bundle layout used by the current
Code-OSS sidecar integration.

## Runtime Bundle

The Electron main process resolves a production bundle from:

```text
resources/microide/
  sidecars/microclaude/
    adapter/index.js
    manifest.json
    schemas/
  microClaude/
    cli.js
    package.json
    vendor/
    stubs/bundle/
    node_modules/
  defaults/
    microclaude.config.json
  runtime/
    node.exe              # Windows
    bin/node              # macOS/Linux
  manifest.json
```

`node` runs both the sidecar adapter and the bundled `microClaude` CLI by
default. The bundled CLI is emitted with a small Node prelude so Bun's
`import.meta.require` output resolves through `node:module` `createRequire`.
`MICROIDE_MICROCLAUDE_RUNTIME` or `--microclaude-runtime` can override the CLI
runtime for compatibility testing, but the production bundle should be prepared
around the signed Node runtime shipped with MicroIDE.

`microClaude/node_modules` is staged with the CLI because the current bundle
still has runtime imports for packages such as `@anthropic-ai/sdk` and optional
tooling like `node-pty`; users should not need to install those separately.

Development mode can still use the workspace copies:

```text
D:/project/microIDE/sidecars/microclaude
D:/project/microIDE/microClaude/cli.js
```

## Stage The Bundle

Dry run:

```bash
node build/microide/stage-sidecar.mjs --dry-run
```

Create the bundle:

```bash
node build/microide/stage-sidecar.mjs --clean --include-tests
```

Use a signed/runtime directory prepared by CI:

```bash
node build/microide/stage-sidecar.mjs --clean --runtime D:/runtimes/node-v24-win-x64
```

Use an explicit Node runtime for the microClaude CLI:

```bash
node build/microide/stage-sidecar.mjs --clean --microclaude-runtime D:/runtimes/node-v24-win-x64/node.exe
```

The default output is:

```text
dist/microide/resources/microide
```

That output path mirrors the production `resources/microide` directory consumed
by `MicroClaudeSidecarService`.

## IDE Probe

After the workbench starts, run this command from the Command Palette:

```text
MicroIDE: Ping microClaude Sidecar
```

It calls the renderer proxy, crosses the Electron main IPC channel, starts the
sidecar lazily, sends `sidecar.ping`, and shows the returned PID, engine, and
protocol version. The command is available in the local development session
without a MicroIDE sign-in step.

## Environment Overrides

The main process supports these overrides for development and CI:

```text
MICROIDE_ROOT
MICROIDE_RELEASE_ROOT
MICROIDE_RESOURCES_ROOT
MICROIDE_MICROCLAUDE_SIDECAR_ROOT
MICROIDE_MICROCLAUDE_SIDECAR_RUNTIME
MICROIDE_MICROCLAUDE_SIDECAR_ENTRY
MICROIDE_MICROCLAUDE_ENGINE
MICROIDE_MICROCLAUDE_CLI
MICROIDE_MICROCLAUDE_RUNTIME
MICROIDE_USER_DATA_DIR
MICROIDE_PROJECT_DATA_DIR
MICROIDE_WORKSPACE
```

Source/development runs default to `lightweight` so the IDE can validate the
protocol without model credentials. Built releases default to `microclaude`.
Set `MICROIDE_MICROCLAUDE_ENGINE=lightweight` or
`MICROIDE_MICROCLAUDE_ENGINE=microclaude` to override either mode.

The default model and provider settings are read from
`microclaude.config.json`. Development uses
`.runtime/microide/microclaude.config.json`; production first copies that file
into `resources/microide/defaults/microclaude.config.json`, then the user data
copy at `MICROIDE_PROJECT_DATA_DIR/microclaude.config.json` can override it.

## Agent Access

The editor, Explorer, file editing, and regular workbench features are available
without signing in. The right-side MicroIDE Agent panel also starts in a local
session by default, so microClaude agent capability can be used without a
separate MicroIDE account prompt.

The upstream VS Code authentication extension sources may still exist in the
tree for merge compatibility, but `github-authentication` and
`microsoft-authentication` are excluded from the packaged local extension set.
