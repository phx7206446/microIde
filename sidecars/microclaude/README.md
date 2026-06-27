# microClaude Sidecar

This package is the first MicroIDE sidecar adapter. It is intentionally small:

- zero runtime dependencies
- NDJSON transport over stdio
- JSON-RPC 2.0 request/response framing
- asynchronous event stream for agent output
- session lifecycle and cancellation

The current engine is a lightweight placeholder that exercises the protocol.
It can also run the real bundled microClaude CLI bridge by passing
`--engine microclaude`.

## Run

```bash
node sidecars/microclaude/adapter/index.js --workspace .
```

Run with the real microClaude CLI:

```bash
node sidecars/microclaude/adapter/index.js \
  --engine microclaude \
  --microclaude-cli ./microClaude/cli.js \
  --workspace .
```

Send one JSON-RPC request per line on stdin:

```json
{"jsonrpc":"2.0","id":"1","method":"sidecar.ping","params":{}}
```

## Agent Access

The sidecar is managed by MicroIDE and accepts session, message, and permission
requests directly over the local stdio bridge. The sidecar protocol itself does
not call GitHub, Google, OAuth, or other external login providers. MicroIDE gates
the Agent Panel in the renderer with the local account configured in
`microideLocalAuthConfig.ts`; normal editor and file editing remain available
without that local sign-in. Model and provider settings are read from
`microclaude.config.json`.

Permission requests from microClaude are emitted as `permission.request` events.
Resolve them by sending:

```json
{"jsonrpc":"2.0","id":"p1","method":"permission.resolve","params":{"requestId":"...","approve":true}}
```

## Smoke Test

```bash
node sidecars/microclaude/tests/smoke.mjs
```

## Release Staging

The Code-OSS main process expects the production bundle under
`resources/microide`. Stage that layout from the repository root with:

```bash
node build/microide/stage-sidecar.mjs --clean --include-tests
```

The default output is `dist/microide/resources/microide`. See
`docs/microide-release-staging.md` for the exact layout and environment
overrides.
