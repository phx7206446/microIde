export const CANONICAL_REMOTE_SKILL_PREFIX = '_canonical_'

export type DiscoveredRemoteSkill = {
  slug: string
  description: string
  url: string
  shortId?: string
  discoveredAt: number
}

const discoveredRemoteSkills = new Map<string, DiscoveredRemoteSkill>()

function normalizeSlug(slug: string): string {
  return slug.trim().replace(/^\/+|\/+$/g, '')
}

export function getCanonicalRemoteSkillName(slug: string): string {
  return `${CANONICAL_REMOTE_SKILL_PREFIX}${normalizeSlug(slug)}`
}

export function stripCanonicalPrefix(name: string): string | null {
  if (!name.startsWith(CANONICAL_REMOTE_SKILL_PREFIX)) {
    return null
  }

  const slug = normalizeSlug(name.slice(CANONICAL_REMOTE_SKILL_PREFIX.length))
  return slug.length > 0 ? slug : null
}

export function setDiscoveredRemoteSkill(
  skill: Omit<DiscoveredRemoteSkill, 'discoveredAt'> & {
    discoveredAt?: number
  },
): void {
  const slug = normalizeSlug(skill.slug)
  if (!slug) {
    return
  }

  discoveredRemoteSkills.set(slug, {
    ...skill,
    slug,
    discoveredAt: skill.discoveredAt ?? Date.now(),
  })
}

export function setDiscoveredRemoteSkills(
  skills: Iterable<
    Omit<DiscoveredRemoteSkill, 'discoveredAt'> & { discoveredAt?: number }
  >,
): void {
  for (const skill of skills) {
    setDiscoveredRemoteSkill(skill)
  }
}

export function getDiscoveredRemoteSkill(
  slug: string,
): DiscoveredRemoteSkill | undefined {
  return discoveredRemoteSkills.get(normalizeSlug(slug))
}

export function getDiscoveredRemoteSkills(): DiscoveredRemoteSkill[] {
  return [...discoveredRemoteSkills.values()]
}

export function clearDiscoveredRemoteSkills(): void {
  discoveredRemoteSkills.clear()
}
