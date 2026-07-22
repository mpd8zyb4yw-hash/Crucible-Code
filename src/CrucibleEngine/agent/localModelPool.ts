// Runtime for optional downloaded GGUF models, loaded via node-llama-cpp. Mirrors the
// OpenAI-chat-completions shape Track S (_callLocalFm) already uses, so synthDriver and
// localModelRouter can treat every local backend the same way. node-llama-cpp is loaded
// lazily via dynamic import so Crucible still runs with zero local-model dependencies
// installed — this whole module is a no-op until both the package and a model file exist.

import fs from 'fs'
import { findModelSpec } from './localModelCatalog'
import { modelFilePath } from './modelDownloadManager'

interface LoadedModel {
  id: string
  model: any   // LlamaModel — kept so stateless completions can spin a fresh context per call
  session: any // LlamaChatSession from node-llama-cpp (legacy callLocalModel path)
}

const loaded = new Map<string, LoadedModel>()
let llamaModule: any = null

async function getLlama(): Promise<any> {
  if (llamaModule) return llamaModule
  try {
    llamaModule = await import('node-llama-cpp')
  } catch {
    throw new Error(
      "node-llama-cpp is not installed. Run `npm install node-llama-cpp` to enable local GGUF models."
    )
  }
  return llamaModule
}

export function isModelLoaded(id: string): boolean {
  return loaded.has(id)
}

// Whether the GGUF runtime (node-llama-cpp) is actually importable in this process.
// Cached after first probe. The UI uses this to avoid offering a GGUF the router can
// only fail to load — pinning one when this is false falls back per localModelRouter's
// pinned-call failure path, which reads as a silent no-op to the user.
let ggufRuntimeAvailable: boolean | null = null
export async function isGgufRuntimeAvailable(): Promise<boolean> {
  if (ggufRuntimeAvailable !== null) return ggufRuntimeAvailable
  try { await getLlama(); ggufRuntimeAvailable = true }
  catch { ggufRuntimeAvailable = false }
  return ggufRuntimeAvailable
}

async function loadModel(id: string): Promise<LoadedModel> {
  const cached = loaded.get(id)
  if (cached) return cached

  const spec = findModelSpec(id)
  if (!spec) throw new Error(`unknown local model id: ${id}`)
  const filePath = modelFilePath(spec)
  if (!fs.existsSync(filePath)) throw new Error(`model '${id}' is not downloaded yet`)

  const { getLlama: initLlama, LlamaChatSession } = await getLlama()
  const llama = await initLlama()
  const model = await llama.loadModel({ modelPath: filePath })
  const context = await model.createContext()
  const session = new LlamaChatSession({ contextSequence: context.getSequence() })

  const entry: LoadedModel = { id, model, session }
  loaded.set(id, entry)
  return entry
}

// Preload a model so the first real query doesn't pay the (multi-second) load cost. Returns
// true once resident. Safe to call repeatedly (loadModel is cached) and never throws.
export async function warmModel(id: string): Promise<boolean> {
  try { await loadModel(id); return true } catch { return false }
}

// Per-model serialization: a llama.cpp context runs one generation at a time. Chain calls so
// concurrent grounding synths on the same model never overlap (which corrupts the session).
const genLock = new Map<string, Promise<unknown>>()
function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = (genLock.get(id) ?? Promise.resolve()).catch(() => {})
  const run = prev.then(fn)
  genLock.set(id, run.catch(() => {}))
  return run
}

/**
 * STATELESS single-shot completion — unlike callLocalModel (which reuses one chat session and
 * therefore leaks conversation history across unrelated queries), this spins a FRESH context per
 * call so each answer is independent. The MODEL stays resident (cached), so only the lightweight
 * context is created/disposed per call. Serialized per model; bounded by maxTokens + a timeout.
 */
// Anti-repetition sampling. Small local models (esp. MiniCPM5-1B) fall into degenerate
// token loops that repeat a phrase until they hit maxTokens — to a user that reads as the
// model "never stopping". The DRY (Don't-Repeat-Yourself) sampler penalizes repeating any
// recent token SEQUENCE (the loop's signature), and the classic repeat/frequency penalties
// discourage single-token spam. These are applied to every local generation.
const ANTI_REPEAT = {
  repeatPenalty: { penalty: 1.18, frequencyPenalty: 0.4, presencePenalty: 0.3, lastTokens: 128 },
  dryRepeatPenalty: { strength: 0.8, base: 1.75, allowedLength: 2 },
} as const

export async function completeLocalModel(
  id: string,
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number; gbnf?: string } = {},
): Promise<string> {
  const { model } = await loadModel(id)
  const llama = await getLlama()
  const { LlamaChatSession } = llama
  // W2 constrained decoding: when the caller supplies a GBNF grammar, build it once and hand it
  // to the sampler so every token is masked to the grammar (malformed shape becomes unreachable).
  // Best-effort — a grammar this runtime rejects must not hard-fail the generation, so we fall
  // back to unconstrained decoding rather than throw.
  let grammar: any
  if (opts.gbnf) {
    try { grammar = await (llama.getLlama ? (await llama.getLlama()).createGrammar({ grammar: opts.gbnf }) : undefined) }
    catch { grammar = undefined }
  }
  return serialize(id, async () => {
    let context: any
    try {
      context = await model.createContext({ contextSize: 4096 })
      const session = new LlamaChatSession({ contextSequence: context.getSequence() })
      const prompt = system ? `${system}\n\n${user}` : user
      const gen = session.prompt(prompt, { maxTokens: opts.maxTokens ?? 700, ...(grammar ? { grammar } : {}), ...ANTI_REPEAT })
      const out = await Promise.race([
        gen,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`${id} generation timed out`)), opts.timeoutMs ?? 20_000)),
      ])
      return truncateRepetition(stripThinkBlock(String(out ?? '')))
    } finally {
      try { await context?.dispose() } catch { /* best-effort */ }
    }
  })
}

/** Unload a model's context to free RAM — call when the router hasn't used it in a while. */
export async function unloadModel(id: string): Promise<void> {
  loaded.delete(id)
}

/** Thinking models (MiniCPM5) emit a <think>…</think> scratchpad before the answer.
 *  Callers want only the answer: take what follows the last closing tag when present,
 *  otherwise strip the markers — a truncated think block still beats an empty string. */
function stripThinkBlock(raw: string): string {
  const parts = raw.split('</think>')
  if (parts.length > 1) {
    const after = parts[parts.length - 1].trim()
    if (after) return after
  }
  return raw.replace(/<\/?think>/g, '').trim()
}

/** Same shape as fmReact's callFm(): system+user in, plain text out. */
export async function callLocalModel(id: string, system: string, user: string): Promise<string> {
  const { session } = await loadModel(id)
  const prompt = system ? `${system}\n\n${user}` : user
  // maxTokens cap + anti-repeat: without a cap a degenerate loop runs until the context fills
  // (the "repeats indefinitely" bug). 800 is plenty for a chat/agent turn.
  const response = await session.prompt(prompt, { maxTokens: 800, ...ANTI_REPEAT })
  return truncateRepetition(stripThinkBlock(String(response ?? '')))
}

/**
 * Cut a degenerate repeated tail. Even with anti-repeat sampling a small model can still land
 * in a loop; if it does, the output ends in the SAME line or sentence repeated many times. We
 * detect a short unit (line or sentence) that repeats ≥3× consecutively at the end and keep just
 * one copy, so the user never sees a wall of duplication. Conservative: only collapses ≥3 exact
 * consecutive repeats, so legitimate repetition (a list, a refrain) is untouched. Never throws.
 */
export function truncateRepetition(text: string): string {
  const s = (text ?? '').trim()
  if (s.length < 40) return s
  // 1) Line-level: collapse a run of ≥3 identical trailing lines to one.
  const lines = s.split('\n')
  let end = lines.length
  const lastLine = lines[end - 1]?.trim()
  if (lastLine && lastLine.length >= 3) {
    let count = 0
    for (let i = end - 1; i >= 0 && lines[i].trim() === lastLine; i--) count++
    if (count >= 3) {
      const head = lines.slice(0, end - count)
      return [...head, lastLine].join('\n').trim()
    }
  }
  // 2) Sentence-level: a single sentence/phrase repeated ≥3× consecutively anywhere.
  const collapsed = s.replace(/(?:\s*([^.!?\n]{6,120}[.!?])\s*)(?:\1\s*){2,}/g, '$1 ')
  return collapsed.trim()
}
