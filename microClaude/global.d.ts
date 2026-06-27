declare module "bun:bundle" {
  export function feature(name: string): boolean;
}

declare module "bun:*" {
  const bunModule: any;
  export = bunModule;
}

declare module "react/compiler-runtime" {
  export function c(size: number): any[];
}

declare module "qrcode" {
  export function toString(
    text: string | Array<{ data: string; mode?: string }>,
    options?: {
      type?: string;
      errorCorrectionLevel?: string;
      small?: boolean;
      [key: string]: unknown;
    },
  ): Promise<string>;
}

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}

declare const MACRO: {
  VERSION: string;
  PACKAGE_URL?: string;
  NATIVE_PACKAGE_URL?: string;
  VERSION_CHANGELOG?: string;
  ISSUES_EXPLAINER?: string;
  [key: string]: unknown;
};

interface GlobalThis {
  MACRO?: {
    VERSION?: string;
    PACKAGE_URL?: string;
    NATIVE_PACKAGE_URL?: string;
    VERSION_CHANGELOG?: string;
    ISSUES_EXPLAINER?: string;
    BUILD_TIME?: string;
    FEEDBACK_CHANNEL?: string;
    [key: string]: unknown;
  };
}

interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

declare namespace Bun {
  function hash(
    input: string | ArrayBuffer | ArrayBufferView,
    seed?: number | bigint,
  ): number | bigint;
  function stringWidth(
    input: string,
    options?: {
      countAnsiEscapeCodes?: boolean;
      ambiguousIsNarrow?: boolean;
      [key: string]: unknown;
    },
  ): number;
  function wrapAnsi(
    input: string,
    columns: number,
    options?: {
      hard?: boolean;
      trim?: boolean;
      wordWrap?: boolean;
      [key: string]: unknown;
    },
  ): string;
  function which(command: string): string | null;
  function spawn(
    cmd: string[],
    options?: Record<string, unknown>,
  ): {
    stdout: unknown;
    stderr: unknown;
    exited: Promise<number>;
  };
  function gc(full?: boolean): void;
  const semver: {
    order(a: string, b: string): -1 | 0 | 1;
    satisfies(version: string, range: string): boolean;
  };
  const YAML: {
    parse(input: string): any;
    stringify(value: unknown, options?: unknown): string;
  };
}
