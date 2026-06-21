// Session J — Autonomous research mode.
//
// Give it a question and walk away: it runs an iterative search → read → extract →
// triangulate → gap-find → synthesize → critic loop and yields a cited, structured
// report with explicit per-claim confidence. Free-tier throughout — it reuses the
// existing web_search tool and the model pool via injected deps, so this module has
// ZERO server coupling and compiles/test-runs on its own.

export interface ResearchDeps {
  // Raw search results as text (we let the model parse them — robust to format drift).
  search: (query: string) => Promise<string>
  // One model completion. Should never throw (callers wrap), returns '' on failure.
  model: (prompt: string) => Promise<string>
  // Optional deep read of a source URL (read_pdf / web fetch). Omittable.
  readSource?: (url: string) => Promise<string>
}

export interface ResearchEvent {
  type: 'research_step' | 'research_done' | 'research_error'
  step?: number
  phase?: 'search' | 'extract' | 'gaps' | 'synthesize' | 'audit'
  detail?: string
  sources?: number
  claimsFound?: number
  gapsIdentified?: number
  text?: string        // final report on research_done; message on research_error
}

export interface ResearchOpts {
  maxIterations?: number   // hard cap on search rounds (default 4)
  minSources?: number      // stop early once this many distinct sources seen + no new gaps (default 4)
  maxMs?: number           // wall-clock cap (default 20 min) — synthesize whatever we have
}

const urlRe = /https?:\/\/[^\s)"'<>]+/g

// Never-throw model call wrapper.
async function ask(deps: ResearchDeps, prompt: string): Promise<string> {
  try { return (await deps.model(prompt))?.trim() ?? '' } catch { return '' }
}

function countSources(text: string, seen: Set<string>): number {
  for (const m of text.match(urlRe) ?? []) seen.add(m.replace(/[.,]+$/, ''))
  // The web_search tool returns numbered "N. Title" entries with the <a> hrefs stripped,
  // so also count distinct result titles as sources (keyed so re-seen results don't double).
  for (const m of text.match(/^\s*\d+\.\s+.+$/gm) ?? []) seen.add('r:' + m.trim().slice(0, 80).toLowerCase())
  return seen.size
}

function parseGaps(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.replace(/^\s*[-*\d.)\]]+\s*/, '').trim())
    .filter(l => l.length > 8 && /\?|gap|unknown|unclear|unverified|missing/i.test(l))
    .slice(0, 3)
}

export async function* runResearchSession(
  question: string,
  opts: ResearchOpts = {},
  deps: ResearchDeps,
): AsyncGenerator<ResearchEvent> {
  const maxIterations = opts.maxIterations ?? 4
  const minSources = opts.minSources ?? 4
  const maxMs = opts.maxMs ?? 20 * 60 * 1000
  const t0 = Date.now()

  const findings: string[] = []      // accumulated extracted-claim blocks
  const seenSources = new Set<string>()
  let gaps: string[] = []

  try {
    for (let step = 0; step < maxIterations; step++) {
      if (Date.now() - t0 > maxMs) break
      const focus = step === 0 ? question : (gaps[0] ?? question)
      const query = step === 0 ? question : `${question} — ${focus}`

      // 1) Search
      const raw = (await deps.search(query).catch(() => '')) || ''
      const nSources = countSources(raw, seenSources)
      yield { type: 'research_step', step, phase: 'search', detail: focus, sources: nSources }

      // 1b) Optionally deep-read the first fresh source (bounded — one per round).
      let deep = ''
      if (deps.readSource) {
        const url = (raw.match(urlRe) ?? [])[0]
        if (url) deep = (await deps.readSource(url.replace(/[.,]+$/, '')).catch(() => '')) || ''
      }

      // 2) Extract verifiable claims (model parses the raw results)
      const claims = await ask(deps,
        `You are researching: "${question}".\nFrom these search results${deep ? ' and source excerpt' : ''}, extract the key VERIFIABLE claims, each with its apparent source/citation. Be terse; one claim per line.\n\nSEARCH RESULTS:\n${raw.slice(0, 6000)}\n${deep ? `\nSOURCE EXCERPT:\n${deep.slice(0, 4000)}\n` : ''}`)
      if (claims) findings.push(claims)
      const claimsFound = claims ? claims.split('\n').filter(l => l.trim()).length : 0
      yield { type: 'research_step', step, phase: 'extract', claimsFound, sources: seenSources.size }

      // 3) Identify remaining gaps
      const gapText = await ask(deps,
        `Research question: "${question}".\nKnowledge gathered so far:\n${findings.join('\n').slice(0, 8000)}\n\nList up to 3 SPECIFIC unanswered sub-questions or gaps still needed for a complete, well-supported answer. One per line, end each with '?'. If the question is fully answered, reply exactly: NONE.`)
      gaps = /^\s*none\s*$/i.test(gapText) ? [] : parseGaps(gapText)
      yield { type: 'research_step', step, phase: 'gaps', gapsIdentified: gaps.length, sources: seenSources.size }

      // Terminate once we have enough sources and no fresh gaps (after >=1 round).
      if (step >= 1 && gaps.length === 0 && seenSources.size >= minSources) break
    }

    // 4) Synthesize the structured report
    yield { type: 'research_step', phase: 'synthesize', sources: seenSources.size }
    const draft = await ask(deps,
      `Write a structured research report that answers: "${question}".\nUse ONLY the gathered knowledge below — do not invent facts. Requirements:\n- Mark every substantive claim with a confidence tag: [HIGH], [MEDIUM], or [LOW].\n- Use inline numeric citations [1], [2]… and list the sources at the end.\n- Include an "Open questions" section and a "Contradictions" section (write "None identified." if empty).\nKeep it tight and well-organized in Markdown.\n\nGATHERED KNOWLEDGE:\n${findings.join('\n\n').slice(0, 12000)}`)

    // 5) Adversarial audit — correct unsupported claims / surface contradictions
    yield { type: 'research_step', phase: 'audit', sources: seenSources.size }
    const audited = await ask(deps,
      `Critically audit the research report below. Downgrade the confidence tag of any claim not clearly supported by the gathered knowledge, flag any internal contradiction, and keep all citations. Return the corrected full report in Markdown — nothing else.\n\nREPORT:\n${draft}`)

    const final = (audited || draft || 'Research produced no usable findings.').trim()
    yield { type: 'research_done', text: final, sources: seenSources.size }
  } catch (e: any) {
    yield { type: 'research_error', text: `Research failed: ${e?.message ?? e}` }
  }
}
