import Fuse from 'fuse.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import { getCommandName } from '../../types/command.js'

const SEPARATORS = /[:/_-]/g
const MIN_QUERY_LENGTH = 2
const TOKEN_SPLIT = /[\s:/_-]+/g

// Turn-zero discovery queries are often full natural-language requests rather
// than direct skill names. A raw fuzzy search over the whole sentence can miss
// local project skills, so keep a small token-overlap fallback for recall.
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'anything',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  'current',
  'directory',
  'do',
  'does',
  'else',
  'exact',
  'exactly',
  'file',
  'files',
  'final',
  'for',
  'from',
  'headings',
  'heading',
  'here',
  'if',
  'in',
  'include',
  'into',
  'is',
  'it',
  'its',
  'just',
  'matching',
  'need',
  'nothing',
  'of',
  'on',
  'only',
  'or',
  'please',
  'result',
  'results',
  'same',
  'save',
  'skill',
  'skills',
  'task',
  'tasks',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'this',
  'those',
  'to',
  'use',
  'using',
  'want',
  'when',
  'with',
  'write',
  'you',
  'your',
])

type SkillSearchItem = {
  name: string
  displayName?: string
  aliases?: string[]
  parts?: string[]
  description: string
  whenToUse?: string
  primaryTerms: string[]
  secondaryTerms: string[]
  normalizedNames: string[]
}

type SkillIndex = {
  signature: string
  items: SkillSearchItem[]
  fuse: Fuse<SkillSearchItem>
}

export type SkillSearchResult = {
  name: string
  description: string
  shortId?: string
}

let skillIndexCache: SkillIndex | null = null

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:/_-]+/gu, ' ')
    .trim()
}

function uniqueTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens)]
}

function splitIntoTokens(text: string): string[] {
  return normalize(text)
    .replace(SEPARATORS, ' ')
    .split(TOKEN_SPLIT)
    .filter(Boolean)
}

function tokenizeSearchField(text: string): string[] {
  return uniqueTokens(
    splitIntoTokens(text).filter(token => token.length >= MIN_QUERY_LENGTH),
  )
}

function tokenizeQuery(text: string): string[] {
  return uniqueTokens(
    splitIntoTokens(text).filter(
      token =>
        token.length >= MIN_QUERY_LENGTH && !STOP_WORDS.has(token),
    ),
  )
}

function hasPrefixTokenMatch(
  token: string,
  searchTerms: readonly string[],
): boolean {
  return searchTerms.some(
    searchTerm => searchTerm.startsWith(token) || token.startsWith(searchTerm),
  )
}

function buildSignature(commands: readonly Command[]): string {
  return commands
    .map(cmd =>
      [
        cmd.name,
        cmd.description,
        cmd.whenToUse ?? '',
        cmd.loadedFrom ?? '',
        'source' in cmd ? cmd.source : '',
      ].join('\u001f'),
    )
    .join('\u001e')
}

async function loadSkillCommands(
  context?: ToolUseContext,
): Promise<readonly Command[]> {
  const { getMcpSkillCommands, getSkillToolCommands } = await import(
    '../../commands.js'
  )
  const localCommands = await getSkillToolCommands(getProjectRoot())
  const mcpSkills = context
    ? getMcpSkillCommands(context.getAppState().mcp.commands)
    : []
  return uniqBy([...localCommands, ...mcpSkills], 'name')
}

function buildSearchItems(commands: readonly Command[]): SkillSearchItem[] {
  return commands
    .filter(cmd => !cmd.isHidden)
    .map(cmd => {
      const displayName = getCommandName(cmd)
      const parts = tokenizeSearchField(displayName)
      const aliases = cmd.aliases?.length ? [...cmd.aliases] : undefined
      const primaryTerms = uniqueTokens([
        ...tokenizeSearchField(cmd.name),
        ...tokenizeSearchField(displayName),
        ...parts,
        ...(aliases?.flatMap(alias => tokenizeSearchField(alias)) ?? []),
      ])
      const secondaryTerms = uniqueTokens([
        ...tokenizeSearchField(cmd.description),
        ...(cmd.whenToUse ? tokenizeSearchField(cmd.whenToUse) : []),
      ])
      const normalizedNames = uniqueTokens(
        [cmd.name, displayName, ...(aliases ?? [])]
          .map(normalize)
          .filter(value => value.length >= MIN_QUERY_LENGTH),
      )
      return {
        name: cmd.name,
        displayName: displayName !== cmd.name ? displayName : undefined,
        aliases,
        parts: parts.length > 1 ? parts : undefined,
        description: cmd.description,
        whenToUse: cmd.whenToUse,
        primaryTerms,
        secondaryTerms,
        normalizedNames,
      }
    })
}

async function getSkillIndex(context?: ToolUseContext): Promise<SkillIndex> {
  const commands = await loadSkillCommands(context)
  const signature = buildSignature(commands)
  if (skillIndexCache?.signature === signature) {
    return skillIndexCache
  }

  const items = buildSearchItems(commands)
  const fuse = new Fuse(items, {
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
    keys: [
      { name: 'name', weight: 3 },
      { name: 'displayName', weight: 3 },
      { name: 'parts', weight: 2 },
      { name: 'aliases', weight: 2 },
      { name: 'description', weight: 1 },
      { name: 'whenToUse', weight: 0.75 },
    ],
  })

  skillIndexCache = { signature, items, fuse }
  return skillIndexCache
}

function formatResult(item: SkillSearchItem): SkillSearchResult {
  return {
    name: item.name,
    description: item.whenToUse
      ? `${item.description} - ${item.whenToUse}`
      : item.description,
  }
}

function collectExactMatches(
  items: readonly SkillSearchItem[],
  normalizedQuery: string,
  seen: Set<string>,
): SkillSearchResult[] {
  const results: SkillSearchResult[] = []

  for (const item of items) {
    const haystacks = [
      item.name,
      item.displayName,
      ...(item.aliases ?? []),
    ]
      .filter(Boolean)
      .map(value => normalize(value as string))
    if (
      !haystacks.some(
        value => value === normalizedQuery || value.startsWith(normalizedQuery),
      )
    ) {
      continue
    }
    if (seen.has(item.name)) {
      continue
    }
    seen.add(item.name)
    results.push(formatResult(item))
  }

  return results
}

function scoreTokenOverlapMatch(
  item: SkillSearchItem,
  normalizedQuery: string,
  queryTokens: readonly string[],
): number {
  let score = 0
  let matchedPrimaryTerms = 0
  let matchedSecondaryTerms = 0

  for (const token of queryTokens) {
    if (item.primaryTerms.includes(token)) {
      score += 10
      matchedPrimaryTerms++
      continue
    }
    if (hasPrefixTokenMatch(token, item.primaryTerms)) {
      score += 7
      matchedPrimaryTerms++
      continue
    }
    if (item.secondaryTerms.includes(token)) {
      score += 4
      matchedSecondaryTerms++
      continue
    }
    if (hasPrefixTokenMatch(token, item.secondaryTerms)) {
      score += 2
      matchedSecondaryTerms++
    }
  }

  if (item.normalizedNames.some(name => normalizedQuery.includes(name))) {
    score += 18
  }

  if (item.parts?.length) {
    const matchedParts = item.parts.filter(
      part =>
        queryTokens.includes(part) || hasPrefixTokenMatch(part, queryTokens),
    ).length

    if (matchedParts === item.parts.length) {
      score += 12
    } else if (matchedParts >= 2) {
      score += 6
    }
  }

  if (matchedPrimaryTerms === 0 && matchedSecondaryTerms < 2) {
    return 0
  }

  return score
}

function collectTokenOverlapMatches(
  items: readonly SkillSearchItem[],
  normalizedQuery: string,
  seen: Set<string>,
): SkillSearchResult[] {
  const queryTokens = tokenizeQuery(normalizedQuery)
  if (queryTokens.length === 0) {
    return []
  }

  return items
    .map(item => ({
      item,
      score: scoreTokenOverlapMatch(item, normalizedQuery, queryTokens),
    }))
    .filter(match => match.score > 0 && !seen.has(match.item.name))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      return left.item.name.localeCompare(right.item.name)
    })
    .map(match => {
      seen.add(match.item.name)
      return formatResult(match.item)
    })
}

export async function searchSkills(
  query: string,
  context: ToolUseContext,
  options?: {
    limit?: number
    excludeNames?: ReadonlySet<string>
  },
): Promise<SkillSearchResult[]> {
  const normalizedQuery = normalize(query)
  if (normalizedQuery.length < MIN_QUERY_LENGTH) {
    return []
  }

  const { fuse, items } = await getSkillIndex(context)
  const limit = options?.limit ?? 5
  const excludeNames = options?.excludeNames ?? new Set<string>()
  const seen = new Set<string>()
  const results: SkillSearchResult[] = []

  for (const result of collectExactMatches(items, normalizedQuery, seen)) {
    if (excludeNames.has(result.name)) {
      continue
    }
    results.push(result)
    if (results.length >= limit) {
      return results
    }
  }

  for (const result of collectTokenOverlapMatches(items, normalizedQuery, seen)) {
    if (excludeNames.has(result.name)) {
      continue
    }
    results.push(result)
    if (results.length >= limit) {
      return results
    }
  }

  for (const match of fuse.search(query, { limit: limit * 3 })) {
    const item = match.item
    if (excludeNames.has(item.name) || seen.has(item.name)) {
      continue
    }
    seen.add(item.name)
    results.push(formatResult(item))
    if (results.length >= limit) {
      break
    }
  }

  return results
}

export function clearSkillIndexCache(): void {
  skillIndexCache = null
}
