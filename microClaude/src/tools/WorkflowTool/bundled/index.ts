import { registerBundledWorkflow } from '../workflowScripts.js'

const deepResearchWorkflow = String.raw`export const meta = {
  name: 'deep-research',
  description: 'Deep research harness - fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
  whenToUse: 'When the user wants a deep, multi-source, fact-checked research report on any topic. BEFORE invoking, check if the question is specific enough to research directly; if underspecified, ask 2-3 clarifying questions to narrow scope. Then pass the refined question as args, weaving the answers in.',
  phases: [
    { title: 'Scope', detail: 'Decompose question (from args) into 5 search angles' },
    { title: 'Search', detail: '5 parallel WebSearch agents, one per angle' },
    { title: 'Fetch', detail: 'URL-dedup, fetch top 15 sources, extract falsifiable claims' },
    { title: 'Verify', detail: '3-vote adversarial verification per claim (need 2/3 refutes to kill)' },
    { title: 'Synthesize', detail: 'Merge semantic dupes, rank by confidence, cite sources' },
  ],
}

const VOTES_PER_CLAIM = 3
const REFUTATIONS_REQUIRED = 2
const MAX_FETCH = 15
const MAX_VERIFY_CLAIMS = 25

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['question', 'angles', 'summary'],
  properties: {
    question: { type: 'string' },
    summary: { type: 'string' },
    angles: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['label', 'query'],
        properties: {
          label: { type: 'string' },
          query: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

const SEARCH_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['url', 'title', 'relevance'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          relevance: { enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: { enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string' },
    claims: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['claim', 'quote', 'importance'],
        properties: {
          claim: { type: 'string' },
          quote: { type: 'string' },
          importance: { enum: ['central', 'supporting', 'tangential'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'evidence', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'] },
    counterSource: { type: 'string' },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'findings', 'caveats'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'confidence', 'sources', 'evidence'],
        properties: {
          claim: { type: 'string' },
          confidence: { enum: ['high', 'medium', 'low'] },
          sources: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
          vote: { type: 'string' },
        },
      },
    },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

phase('Scope')
const QUESTION = (typeof args === 'string' && args.trim()) || ''
if (!QUESTION) {
  return {
    error: "No research question provided. Pass it as args: Workflow({name: 'deep-research', args: '<question>'}).",
  }
}

const scope = await agent(
  [
    'Decompose this research question into complementary search angles.',
    '',
    '## Question',
    QUESTION,
    '',
    '## Task',
    'Generate 5 distinct web search queries that together cover the question from different angles.',
    'Use domain-appropriate angles such as broad/primary, academic/technical, recent news, skeptical/contrarian, and practitioner/implementation.',
    'Make queries specific enough to surface high-signal results. Avoid redundancy.',
    'Return the normalized question, a 1-2 sentence decomposition strategy, and the angles.',
    '',
    'Structured output only.',
  ].join('\n'),
  { label: 'scope', phase: 'Scope', schema: SCOPE_SCHEMA },
)
if (!scope) {
  return { error: 'Scope agent returned no result; cannot decompose the research question.' }
}
log('Q: ' + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? '...' : ''))
log('Decomposed into ' + scope.angles.length + ' angles: ' + scope.angles.map(a => a.label).join(', '))

const normURL = u => {
  try {
    const p = new URL(u)
    return (p.hostname.replace(/^www\./, '') + p.pathname.replace(/\/$/, '')).toLowerCase()
  } catch {
    return String(u).toLowerCase()
  }
}
const seen = new Map()
const dupes = []
const budgetDropped = []
const relRank = { high: 0, medium: 1, low: 2 }
let fetchSlots = MAX_FETCH

const SEARCH_PROMPT = angle =>
  [
    '## Web Searcher: ' + angle.label,
    '',
    'Research question: "' + QUESTION + '"',
    '',
    'Your angle: ' + angle.label + ' - ' + (angle.rationale || ''),
    'Search query: ' + angle.query,
    '',
    '## Task',
    'Use WebSearch with the query above, or a refined version. Return the top 4-6 most relevant results.',
    'Rank by relevance to the original question, not just the search query. Skip obvious SEO spam/content farms.',
    'Include a short snippet capturing why each result is relevant.',
    '',
    'Structured output only.',
  ].join('\n')

const FETCH_PROMPT = (source, angle) =>
  [
    '## Source Extractor',
    '',
    'Research question: "' + QUESTION + '"',
    '',
    'Fetch and extract key claims from this source:',
    'URL: ' + source.url,
    'Title: ' + source.title,
    'Found via: ' + angle + ' search',
    '',
    '## Task',
    '1. Use WebFetch to retrieve the page content.',
    '2. Assess source quality: primary research/institution, secondary reporting, blog/opinion, forum, or unreliable.',
    '3. Extract 2-5 falsifiable claims that bear on the research question.',
    '4. Each claim must be concrete, checkable, include a direct quote, and be rated central/supporting/tangential.',
    '5. Note publish date if available.',
    '',
    'If fetch fails or the page is irrelevant/paywalled, return claims: [] and sourceQuality: "unreliable".',
    '',
    'Structured output only.',
  ].join('\n')

const VERIFY_PROMPT = (claim, v) =>
  [
    '## Adversarial Claim Verifier (voter ' + (v + 1) + '/' + VOTES_PER_CLAIM + ')',
    '',
    'Be skeptical. Try to refute this claim. ' + REFUTATIONS_REQUIRED + '/' + VOTES_PER_CLAIM + ' refutations kill it.',
    '',
    '## Research question',
    QUESTION,
    '',
    '## Claim under review',
    '"' + claim.claim + '"',
    '',
    'Source: ' + claim.sourceUrl + ' (' + claim.sourceQuality + ')',
    'Supporting quote: "' + claim.quote + '"',
    '',
    '## Checklist',
    '1. Is the claim actually supported by the quote, or is it an overreach/misread?',
    '2. WebSearch for contradicting evidence; does any credible source dispute or heavily qualify this?',
    '3. Is the source quality sufficient for the claim strength?',
    '4. Is the claim outdated?',
    '5. Is this a marketing claim, press release, cherry-picked benchmark, or forum speculation?',
    '',
    'Set refuted=true if unsupported, contradicted, low-quality for the claim strength, outdated, or marketing fluff.',
    'Set refuted=false only if the claim is well-supported, current, and source quality matches claim strength.',
    'Default to refuted=true if uncertain. Evidence must be specific.',
    '',
    'Structured output only.',
  ].join('\n')

phase('Search')
const searchResults = await pipeline(
  scope.angles,

  angle => agent(SEARCH_PROMPT(angle), {
    label: 'search:' + angle.label,
    phase: 'Search',
    schema: SEARCH_SCHEMA,
  }).then(r => {
    if (!r) return null
    log(angle.label + ': ' + r.results.length + ' results')
    return { angle: angle.label, results: r.results }
  }),

  searchResult => {
    const sorted = [...searchResult.results].sort((a, b) => relRank[a.relevance] - relRank[b.relevance])
    const novel = sorted.filter(r => {
      const key = normURL(r.url)
      if (seen.has(key)) {
        dupes.push({ ...r, angle: searchResult.angle, dupOf: seen.get(key) })
        return false
      }
      if (fetchSlots <= 0 && relRank[r.relevance] >= 1) {
        budgetDropped.push({ ...r, angle: searchResult.angle })
        return false
      }
      seen.set(key, { angle: searchResult.angle, title: r.title })
      fetchSlots--
      return true
    })
    if (novel.length < searchResult.results.length) {
      log(searchResult.angle + ': ' + novel.length + ' novel (' + (searchResult.results.length - novel.length) + ' filtered)')
    }
    return parallel(
      novel.map(source => () => {
        let host = 'unknown'
        try {
          host = new URL(source.url).hostname.replace(/^www\./, '')
        } catch {}
        return agent(FETCH_PROMPT(source, searchResult.angle), {
          label: 'fetch:' + host,
          phase: 'Fetch',
          schema: EXTRACT_SCHEMA,
        }).then(ext => {
          if (!ext) return null
          return {
            url: source.url,
            title: source.title,
            angle: searchResult.angle,
            sourceQuality: ext.sourceQuality,
            publishDate: ext.publishDate,
            claims: ext.claims.map(c => ({ ...c, sourceUrl: source.url, sourceQuality: ext.sourceQuality })),
          }
        }).catch(e => {
          log('fetch failed: ' + source.url + ' - ' + (e.message || e))
          return { url: source.url, title: source.title, angle: searchResult.angle, sourceQuality: 'unreliable', claims: [] }
        })
      }),
    )
  },
)

const allSources = searchResults.flat().filter(Boolean)
const allClaims = allSources.flatMap(s => s.claims)
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }
const rankedClaims = [...allClaims]
  .sort((a, b) => (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]))
  .slice(0, MAX_VERIFY_CLAIMS)

log('Fetched ' + allSources.length + ' sources -> ' + allClaims.length + ' claims -> verifying top ' + rankedClaims.length)

if (rankedClaims.length === 0) {
  return {
    question: QUESTION,
    summary: 'No claims extracted. ' + allSources.length + ' sources fetched, all empty/failed. ' + dupes.length + ' URL dupes, ' + budgetDropped.length + ' budget-dropped.',
    findings: [],
    refuted: [],
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality })),
    stats: { angles: scope.angles.length, sources: allSources.length, claims: 0, dupes: dupes.length },
  }
}

phase('Verify')
const voted = (await parallel(
  rankedClaims.map(claim => () =>
    parallel(
      Array.from({ length: VOTES_PER_CLAIM }, (_, v) => () =>
        agent(VERIFY_PROMPT(claim, v), {
          label: 'v' + v + ':' + claim.claim.slice(0, 40),
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
        }),
      ),
    ).then(verdicts => {
      const valid = verdicts.filter(Boolean)
      const refuted = valid.filter(v => v.refuted).length
      const abstained = VOTES_PER_CLAIM - valid.length
      const survives = valid.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED
      log('"' + claim.claim.slice(0, 50) + '...": ' + (valid.length - refuted) + '-' + refuted + (abstained > 0 ? ' (' + abstained + ' abstain)' : '') + ' ' + (survives ? 'survives' : 'killed'))
      return { ...claim, verdicts: valid, refutedVotes: refuted, survives }
    }),
  ),
)).filter(Boolean)

const confirmed = voted.filter(c => c.survives)
const killed = voted.filter(c => !c.survives)
log('Verify done: ' + voted.length + ' claims -> ' + confirmed.length + ' confirmed, ' + killed.length + ' killed')

if (confirmed.length === 0) {
  return {
    question: QUESTION,
    summary: 'All ' + voted.length + ' claims were refuted by adversarial verification. Research is inconclusive; sources may be low-quality or claims overstated.',
    findings: [],
    refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes, source: c.sourceUrl })),
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, claimCount: s.claims.length })),
    stats: { angles: scope.angles.length, sources: allSources.length, claims: allClaims.length, verified: voted.length, confirmed: 0, killed: killed.length },
  }
}

phase('Synthesize')
const confRank = { high: 0, medium: 1, low: 2 }
const block = confirmed.map((c, i) => {
  const best = c.verdicts.filter(v => !v.refuted).sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0]
  return [
    '### [' + i + '] ' + c.claim,
    'Vote: ' + (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes + ' | Source: ' + c.sourceUrl + ' (' + c.sourceQuality + ')',
    'Quote: "' + c.quote + '"',
    'Verifier evidence (' + best.confidence + '): ' + best.evidence,
  ].join('\n')
}).join('\n\n')

const killedBlock = killed.length > 0
  ? '\n## Refuted claims (for transparency)\n' + killed.map(c => '- "' + c.claim + '" (' + c.sourceUrl + ', vote ' + (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes + ')').join('\n')
  : ''

const report = await agent(
  [
    '## Synthesis: research report',
    '',
    'Question: ' + QUESTION,
    '',
    confirmed.length + ' claims survived ' + VOTES_PER_CLAIM + '-vote adversarial verification. Merge semantic duplicates and synthesize.',
    '',
    '## Confirmed claims',
    block,
    killedBlock,
    '',
    '## Instructions',
    '1. Merge semantically duplicate claims and combine their sources.',
    '2. Group related claims into coherent findings that directly answer the research question.',
    '3. Assign confidence per finding: high, medium, or low.',
    '4. Write a 3-5 sentence executive summary.',
    '5. Note caveats, weak sources, and time-sensitivity.',
    '6. List 2-4 open questions that emerged but were not answered.',
    '',
    'Structured output only.',
  ].join('\n'),
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA },
)

if (!report) {
  return {
    question: QUESTION,
    summary: 'Synthesis step was skipped or failed; returning ' + confirmed.length + ' verified claims unmerged.',
    findings: [],
    confirmed: confirmed.map(c => ({ claim: c.claim, source: c.sourceUrl, quote: c.quote, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes })),
    refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes, source: c.sourceUrl })),
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, claimCount: s.claims.length })),
    stats: { angles: scope.angles.length, sources: allSources.length, claims: allClaims.length, verified: voted.length, confirmed: confirmed.length, killed: killed.length, afterSynthesis: 0 },
  }
}

return {
  question: QUESTION,
  ...report,
  refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes, source: c.sourceUrl })),
  sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length })),
  stats: {
    angles: scope.angles.length,
    sourcesFetched: allSources.length,
    claimsExtracted: allClaims.length,
    claimsVerified: voted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSynthesis: report.findings.length,
    urlDupes: dupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls: 1 + scope.angles.length + allSources.length + (voted.length * VOTES_PER_CLAIM) + 1,
  },
}
`

let initialized = false

export function initBundledWorkflows(): void {
  if (initialized) return
  initialized = true
  registerBundledWorkflow(deepResearchWorkflow)
}
