// Pipeline self-patcher (Track B1) — the system reads its own debug bus history,
// identifies the stage that most frequently precedes low-score synthesis, and
// proposes a prompt config patch. Proposals go through the triumvirate before
// being written to .crucible/pipeline-patches.json, which server.ts loads at
// startup to override stage prompts.

import fs from 'fs'
import path from 'path'

export interface PipelinePatch {
  id: string
  ts: number
  stage: string
  promptType: string
  problem: string     // what failure mode this addresses
  patch: string       // the new prompt text to apply
  status: 'pending' | 'approved' | 'rejected' | 'active'
  approvedAt?: number
}

const patchFile = (dir: string) => path.join(dir, '.crucible', 'pipeline-patches.json')

export function loadPatches(dir: string): PipelinePatch[] {
  try { return JSON.parse(fs.readFileSync(patchFile(dir), 'utf8')) } catch { return [] }
}

export function savePatches(dir: string, patches: PipelinePatch[]) {
  fs.mkdirSync(path.dirname(patchFile(dir)), { recursive: true })
  fs.writeFileSync(patchFile(dir), JSON.stringify(patches, null, 2))
}

export function getActivePatches(dir: string): PipelinePatch[] {
  return loadPatches(dir).filter(p => p.status === 'active')
}

export function approvePatch(dir: string, id: string): void {
  const patches = loadPatches(dir)
  const p = patches.find(p => p.id === id)
  if (p) { p.status = 'active'; p.approvedAt = Date.now() }
  savePatches(dir, patches)
}

// Analyse debug history and quality data to identify the weakest pipeline stage.
// Returns a proposed patch or null if no clear improvement target.
export function analyseAndPropose(
  debugHistory: any[],
  qualityHistory: any[],
  promptType: string
): Omit<PipelinePatch, 'id' | 'ts' | 'status'> | null {
  // Count events by stage preceding low-quality outcomes
  const lowScoreRequests = new Set(
    qualityHistory
      .filter(q => (q.compositeScore ?? q.score ?? 1) < 0.55)
      .slice(-100)
      .map(q => q.requestId)
      .filter(Boolean)
  )

  if (lowScoreRequests.size < 5) return null  // not enough data

  // Count stage events that appear in low-score request chains
  const stageCounts: Record<string, number> = {}
  for (const event of debugHistory) {
    if (!lowScoreRequests.has(event.requestId)) continue
    if (event.category === 'pipeline' && event.type?.startsWith('stage')) {
      const key = `${event.data?.stage}_${event.data?.status}`
      stageCounts[key] = (stageCounts[key] ?? 0) + 1
    }
  }

  // Find the stage with most failures
  const sorted = Object.entries(stageCounts).sort((a, b) => b[1] - a[1])
  if (!sorted.length) return null

  const [worstKey, count] = sorted[0]
  const [stage] = worstKey.split('_')

  // Only propose patches for synthesis and critique stages (most impactful)
  const stageNum = parseInt(stage)
  if (![3, 5].includes(stageNum)) return null

  if (stageNum === 3) {
    return {
      stage: 'stage3_critique',
      promptType,
      problem: `Stage 3 critique appeared in ${count} low-score chains for ${promptType} queries`,
      patch: `When critiquing a ${promptType} response, focus specifically on: (1) factual accuracy of key claims, (2) completeness relative to the question, (3) logical consistency. Be concrete — quote the specific line that is problematic.`,
    }
  }

  if (stageNum === 5) {
    return {
      stage: 'stage5_synthesis',
      promptType,
      problem: `Stage 5 synthesis appeared in ${count} low-score chains for ${promptType} queries`,
      patch: `When synthesising ${promptType} responses, prioritise: leading with the direct answer, then supporting evidence, then caveats. Never lead with caveats. If models disagree on a key fact, name both positions and indicate which has stronger evidence.`,
    }
  }

  return null
}

// Run the full analyse-propose-submit cycle. callTriumvirate injected from server.ts.
export async function runSelfPatcher(
  dir: string,
  debugHistory: any[],
  qualityHistory: any[],
  promptTypes: string[],
  callTriumvirate: (proposal: string) => Promise<{ approved: boolean; reason: string }>
): Promise<void> {
  const patches = loadPatches(dir)
  const existingProblems = new Set(patches.map(p => p.problem))

  for (const pt of promptTypes) {
    const proposal = analyseAndPropose(debugHistory, qualityHistory, pt)
    if (!proposal || existingProblems.has(proposal.problem)) continue

    console.log(`[SelfPatcher] Proposing patch for ${pt} ${proposal.stage}: ${proposal.problem}`)
    try {
      const { approved, reason } = await callTriumvirate(
        `PIPELINE PATCH PROPOSAL\nStage: ${proposal.stage}\nPrompt type: ${proposal.promptType}\nProblem: ${proposal.problem}\nProposed patch text:\n${proposal.patch}`
      )
      const patch: PipelinePatch = {
        id: `pp_${Date.now()}`,
        ts: Date.now(),
        ...proposal,
        status: approved ? 'active' : 'rejected',
        ...(approved ? { approvedAt: Date.now() } : {}),
      }
      patches.push(patch)
      console.log(`[SelfPatcher] Patch ${approved ? 'APPROVED' : 'REJECTED'}: ${reason}`)
    } catch (e: any) {
      console.warn('[SelfPatcher] Triumvirate call failed:', e.message)
    }
  }

  if (patches.length > 0) savePatches(dir, patches)
}
