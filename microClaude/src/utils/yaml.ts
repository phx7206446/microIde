/**
 * YAML parsing wrapper.
 *
 * Uses Bun.YAML (built-in, zero-cost) when running under Bun, otherwise falls
 * back to the `yaml` npm package. The package is lazy-required inside the
 * non-Bun branch so native Bun builds never load the ~270KB yaml parser.
 */

export function parseYaml(input: string): unknown {
  const bunYamlParse =
    typeof Bun !== 'undefined'
      ? (
          Bun as typeof Bun & {
            YAML?: {
              parse?: (value: string) => unknown
            }
          }
        ).YAML?.parse
      : undefined

  if (typeof bunYamlParse === 'function') {
    return bunYamlParse(input)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input)
}
