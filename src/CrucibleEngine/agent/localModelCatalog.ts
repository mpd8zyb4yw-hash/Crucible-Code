// Catalog of optional, fully-local, free-forever small models a user may download.
// Every entry is open-weight with no usage fees or royalties, and ships a GGUF quant
// small enough to run on iPhone-class RAM. Nothing here is bundled with the app —
// the user opts in per-model and modelDownloadManager pulls the file on demand.

export interface LocalModelSpec {
  id: string
  label: string
  /** Approximate parameter count, for display. */
  params: string
  /** Quantized file size on disk, for display before download. */
  approxSizeGB: number
  /** Direct HTTPS URL to the GGUF quant (HuggingFace resolve link). */
  url: string
  /** SHA-256 of the file, checked after download before the model is marked usable. */
  sha256: string
  /** Filename written under the models directory. */
  filename: string
  /** License family, for the UI to display — informational only, all are free/open. */
  license: string
  /** Rough capability tier used by localModelRouter for escalation ordering. */
  tier: 'fast' | 'balanced' | 'quality'
  /** Domains this model is known to be strong at — used to route a query to its best-fit model. */
  strengths: Domain[]
  /** One line surfaced in the UI so the user knows what a model is actually good for. */
  strengthNote: string
}

/** Coarse query domains used for strength-based routing, not a general taxonomy. */
export type Domain = 'code' | 'reasoning' | 'creative' | 'factual' | 'multilingual' | 'speed'

const DOMAIN_SIGNALS: Array<{ domain: Domain; re: RegExp }> = [
  { domain: 'code', re: /\b(function|bug|refactor|compile|stack trace|regex|api|typescript|python|code|error:|exception)\b/i },
  { domain: 'reasoning', re: /\b(why|explain|prove|step by step|logic|because|reason|analyz|compare|trade[\s-]?off)\b/i },
  { domain: 'creative', re: /\b(write|story|poem|brainstorm|idea|imagine|creative|draft)\b/i },
  { domain: 'multilingual', re: /[À-ɏЀ-ӿ一-鿿぀-ヿ가-힣]/ },
  { domain: 'factual', re: /\b(what is|who is|when did|where is|define|fact|history of)\b/i },
]

/** Cheap lexical guess at the query's dominant domain — no model call. */
export function classifyDomain(goal: string): Domain {
  for (const { domain, re } of DOMAIN_SIGNALS) if (re.test(goal)) return domain
  return 'speed'
}

export const LOCAL_MODEL_CATALOG: LocalModelSpec[] = [
  {
    id: 'smollm2-1.7b',
    label: 'SmolLM2 1.7B Instruct',
    params: '1.7B',
    approxSizeGB: 1.1,
    url: 'https://huggingface.co/bartowski/SmolLM2-1.7B-Instruct-GGUF/resolve/main/SmolLM2-1.7B-Instruct-Q4_K_M.gguf',
    sha256: '77665ea4815999596525c636fbeb56ba8b080b46ae85efef4f0d986a139834d7',
    filename: 'smollm2-1.7b-instruct-q4_k_m.gguf',
    license: 'Apache 2.0',
    tier: 'fast',
    strengths: ['speed', 'factual'],
    strengthNote: 'Smallest and fastest — best for quick factual lookups and short chit-chat.',
  },
  {
    id: 'qwen2.5-1.5b',
    label: 'Qwen2.5 1.5B Instruct',
    params: '1.5B',
    approxSizeGB: 1.0,
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sha256: '9a598ca139ec14310db4eb3e4a4057a3be0108673e545846c77f93a50f10d44e',
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    license: 'Apache 2.0',
    tier: 'fast',
    strengths: ['multilingual', 'speed'],
    strengthNote: 'Strong multilingual coverage for its size — good default for non-English queries.',
  },
  {
    id: 'gemma2-2b',
    label: 'Gemma 2 2B Instruct',
    params: '2B',
    approxSizeGB: 1.6,
    url: 'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf',
    sha256: '65f50a06b918400195fb270758886075ef133f08118b15b73e0b593f4aea8944',
    filename: 'gemma-2-2b-it-q4_k_m.gguf',
    license: 'Gemma Terms of Use (free, no fees, redistribution/usage terms apply)',
    tier: 'balanced',
    strengths: ['creative', 'reasoning'],
    strengthNote: 'Best general-purpose writer of the set — favor it for creative or open-ended answers.',
  },
  {
    id: 'phi-3.5-mini',
    label: 'Phi-3.5 Mini Instruct',
    params: '3.8B',
    approxSizeGB: 2.3,
    url: 'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf',
    sha256: 'da56dece0a679a3e1da7ed952102024f4c3912a16341bad626aba02671528b94',
    filename: 'phi-3.5-mini-instruct-q4_k_m.gguf',
    license: 'MIT',
    tier: 'quality',
    strengths: ['reasoning', 'code'],
    strengthNote: 'Punches above its size on step-by-step reasoning and code — best default escalation target.',
  },
  {
    id: 'qwen2.5-3b',
    label: 'Qwen2.5 3B Instruct',
    params: '3B',
    approxSizeGB: 1.9,
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    sha256: 'd36743d0f66ace7703e66e42278eb4f3bac7df0bb0747371de7829446a767cd6',
    filename: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    license: 'Qwen license (free, no fees, redistribution terms apply over 100M MAU — n/a here)',
    tier: 'quality',
    strengths: ['code', 'multilingual'],
    strengthNote: 'Best code understanding of the set, plus solid multilingual reasoning at 3B.',
  },
]

export function findModelSpec(id: string): LocalModelSpec | undefined {
  return LOCAL_MODEL_CATALOG.find(m => m.id === id)
}
