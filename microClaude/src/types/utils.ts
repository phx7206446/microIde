type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined

export type DeepImmutable<T> = T extends Primitive
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends Map<infer K, infer V>
      ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
      : T extends Set<infer U>
        ? ReadonlySet<DeepImmutable<U>>
        : T extends readonly (infer U)[]
          ? readonly DeepImmutable<U>[]
          : T extends object
            ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
            : T

/**
 * Used with `satisfies` for small exhaustiveness checks.
 * The upstream call sites only rely on "readonly array of T" behavior.
 */
export type Permutations<T> = readonly T[]
