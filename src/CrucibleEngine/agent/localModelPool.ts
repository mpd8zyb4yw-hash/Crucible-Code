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
  session: any // LlamaChatSession from node-llama-cpp
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

  const entry: LoadedModel = { id, session }
  loaded.set(id, entry)
  return entry
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
  const response = await session.prompt(prompt)
  return stripThinkBlock(String(response ?? ''))
}
