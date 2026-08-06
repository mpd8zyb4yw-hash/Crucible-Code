// Episodic memory — compressed session summaries that give the agent a sense
// of history. After each session a summariser reduces the full exchange to
// 3-5 sentences: goal, approach, surprise, outcome. The 3 most similar
// episodes are injected at session start. Bullet facts (world.md) tell the
// agent what it knows; episodes tell it what it has experienced.

import fs from 'fs'
import path from 'path'

function vectorize(text: string): number[] {
  const tokens = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  const freq: Record<string, number> = {}
  for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1
  const dim = 32
  const vec = new Array(dim).fill(0)
  for (const [word, count] of Object.entries(freq)) {
    let h = 0
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0
    vec[h % dim] += count
  }
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
  return vec.map(x => x / n)
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * (b[i] ?? 0); na += a[i] ** 2; nb += (b[i] ?? 0) ** 2 }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

export interface Episode {
  id: string
  ts: number
  goal: string
  summary: string  // 3-5 sentence compressed narrative
  vec: number[]    // embedding for retrieval
  outcome: 'success' | 'partial' | 'failed'
  projectPath: string
}

const episodeFile = () => path.join(process.env.HOME ?? '~', '.crucible', 'episodes.json')
const MAX_EPISODES = 100

export function loadEpisodes(): Episode[] {
  try { return JSON.parse(fs.readFileSync(episodeFile(), 'utf8')) } catch { return [] }
}

function saveEpisodes(eps: Episode[]) {
  const f = episodeFile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(eps, null, 2))
}

export function addEpisode(ep: Omit<Episode, 'vec'>): void {
  const eps = loadEpisodes()
  const full: Episode = { ...ep, vec: vectorize(`${ep.goal} ${ep.summary}`) }
  eps.push(full)
  // Evict oldest when over cap
  if (eps.length > MAX_EPISODES) eps.splice(0, eps.length - MAX_EPISODES)
  saveEpisodes(eps)
}

export function recallSimilarEpisodes(query: string, topK = 3): Episode[] {
  const eps = loadEpisodes()
  if (!eps.length) return []
  const qvec = vectorize(query)
  return eps
    .map(e => ({ e, sim: cosineSim(qvec, e.vec) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK)
    .filter(x => x.sim > 0.25)
    .map(x => x.e)
}

export function buildEpisodeContext(query: string): string {
  const episodes = recallSimilarEpisodes(query)
  if (!episodes.length) return ''
  const lines = episodes.map(e =>
    `[${new Date(e.ts).toLocaleDateString()}] Goal: ${e.goal} — ${e.summary} (${e.outcome})`
  )
  return `Relevant past sessions:\n${lines.join('\n')}`
}

// Summarise a completed session into an episode.
// callModel is injected from server.ts to avoid circular imports.
export async function summariseSession(
  goal: string,
  finalText: string,
  projectPath: string,
  outcome: Episode['outcome'],
  callModel: (model: any, messages: any[]) => Promise<string>
): Promise<void> {
  try {
    const summary = await Promise.race([
      callModel(null, [
        { role: 'system', content: 'You are a session historian. Write exactly 2-3 sentences summarising this AI session. Cover: what the goal was, the key approach or discovery, and the outcome. Be specific and concrete. No filler phrases.' },
        { role: 'user', content: `Goal: ${goal}\n\nResult:\n${finalText.slice(0, 800)}` },
      ]),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ])
    if (!summary || summary.length < 20) return
    addEpisode({
      id: `ep_${Date.now()}`,
      ts: Date.now(),
      goal: goal.slice(0, 120),
      summary: summary.slice(0, 400),
      outcome,
      projectPath,
    })
    console.log(`[Episodes] Saved: "${goal.slice(0, 60)}"`)
  } catch { /* non-blocking */ }
}
