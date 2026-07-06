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
}

export const LOCAL_MODEL_CATALOG: LocalModelSpec[] = [
  {
    id: 'smollm2-1.7b',
    label: 'SmolLM2 1.7B Instruct',
    params: '1.7B',
    approxSizeGB: 1.1,
    url: 'https://huggingface.co/bartowski/SmolLM2-1.7B-Instruct-GGUF/resolve/main/SmolLM2-1.7B-Instruct-Q4_K_M.gguf',
    sha256: '',
    filename: 'smollm2-1.7b-instruct-q4_k_m.gguf',
    license: 'Apache 2.0',
    tier: 'fast',
  },
  {
    id: 'qwen2.5-1.5b',
    label: 'Qwen2.5 1.5B Instruct',
    params: '1.5B',
    approxSizeGB: 1.0,
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sha256: '',
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    license: 'Apache 2.0',
    tier: 'fast',
  },
  {
    id: 'gemma2-2b',
    label: 'Gemma 2 2B Instruct',
    params: '2B',
    approxSizeGB: 1.6,
    url: 'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf',
    sha256: '',
    filename: 'gemma-2-2b-it-q4_k_m.gguf',
    license: 'Gemma Terms of Use (free, no fees, redistribution/usage terms apply)',
    tier: 'balanced',
  },
  {
    id: 'phi-3.5-mini',
    label: 'Phi-3.5 Mini Instruct',
    params: '3.8B',
    approxSizeGB: 2.3,
    url: 'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf',
    sha256: '',
    filename: 'phi-3.5-mini-instruct-q4_k_m.gguf',
    license: 'MIT',
    tier: 'quality',
  },
  {
    id: 'qwen2.5-3b',
    label: 'Qwen2.5 3B Instruct',
    params: '3B',
    approxSizeGB: 1.9,
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    sha256: '',
    filename: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    license: 'Qwen license (free, no fees, redistribution terms apply over 100M MAU — n/a here)',
    tier: 'quality',
  },
]

export function findModelSpec(id: string): LocalModelSpec | undefined {
  return LOCAL_MODEL_CATALOG.find(m => m.id === id)
}
