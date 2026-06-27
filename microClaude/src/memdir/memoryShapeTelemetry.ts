// Referenced behind feature flags from multiple memory-related paths, but the
// implementation is absent from both upstream snapshots available in this fork.
// Keep the feature surface inert rather than guessing telemetry semantics.

export function logMemoryRecallShape(
  _memories: readonly unknown[],
  _selected: readonly unknown[],
): void {}

export function logMemoryWriteShape(
  _toolName: string,
  _toolInput: unknown,
  _filePath: string,
  _scope: string,
): void {}
