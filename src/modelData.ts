// Browser-safe model data — no Node.js imports
// This file is imported by App.tsx. Do not add any Node.js code here.

export interface ModelEntry {
  id: string
  label: string
  params?: number
  free?: boolean
  quality?: number
  provider: string
  speed?: 'fast' | 'standard' | 'slow'
  fit?: Record<string, number>
}

export const MODEL_REGISTRY: ModelEntry[] = [
  { id: 'groq/llama-3.3-70b-versatile', params: 70, free: true, label: 'Llama 3.3 70B', quality: 8, provider: 'groq', speed: 'fast', fit: { coding: 7, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 } },
  { id: 'groq/qwen/qwen3-32b', params: 32, free: true, label: 'Qwen3 32B', quality: 8, provider: 'groq', speed: 'fast', fit: { coding: 9, reasoning: 9, creative: 6, factual: 8, math: 9, general: 8 } },
  { id: 'groq/llama-3.1-8b-instant', params: 8, free: true, label: 'Llama 3.1 8B', quality: 6, provider: 'groq', speed: 'fast', fit: { coding: 6, reasoning: 6, creative: 6, factual: 6, math: 5, general: 6 } },
  { id: 'groq/llama-3.2-11b-text-preview', params: 11, free: true, label: 'Llama 3.2 11B', quality: 6, provider: 'groq', speed: 'fast', fit: { coding: 6, reasoning: 6, creative: 7, factual: 6, math: 5, general: 6 } },
  { id: 'mistral/mistral-small-latest', params: 22, free: true, label: 'Mistral Small', quality: 7, provider: 'mistral', speed: 'standard', fit: { coding: 7, reasoning: 7, creative: 8, factual: 7, math: 6, general: 7 } },
  { id: 'openrouter/openai/gpt-oss-120b:free', params: 120, label: 'GPT OSS 120B', free: true, quality: 9, provider: 'openrouter', speed: 'standard', fit: { coding: 9, reasoning: 9, creative: 8, factual: 9, math: 9, general: 9 } },
  { id: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', params: 120, label: 'Nemotron 3 Super', free: true, quality: 9, provider: 'openrouter', speed: 'standard', fit: { coding: 9, reasoning: 9, creative: 7, factual: 8, math: 9, general: 8 } },
  { id: 'openrouter/google/gemma-4-31b-it:free', params: 31, label: 'Gemma 4 31B', free: true, quality: 8, provider: 'openrouter', speed: 'standard', fit: { coding: 8, reasoning: 8, creative: 8, factual: 8, math: 7, general: 8 } },
  { id: 'openrouter/openai/gpt-oss-20b:free', params: 20, label: 'GPT OSS 20B', free: true, quality: 7, provider: 'openrouter', speed: 'standard', fit: { coding: 8, reasoning: 7, creative: 7, factual: 7, math: 7, general: 7 } },
  { id: 'openrouter/openrouter/owl-alpha', params: 8, label: 'Owl Alpha', free: true, quality: 8, provider: 'openrouter', speed: 'standard', fit: { coding: 8, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 } },
  { id: 'gemini/gemini-2.0-flash', params: 8, label: 'Gemini 2.0 Flash', free: true, quality: 8, provider: 'gemini', speed: 'standard', fit: { coding: 8, reasoning: 8, creative: 8, factual: 9, math: 8, general: 8 } },
  { id: 'huggingface/meta-llama/llama-3.1-8b-instruct', params: 8, label: 'Llama 3.1 8B (HF)', free: true, quality: 6, provider: 'huggingface', speed: 'fast', fit: { coding: 6, reasoning: 6, creative: 6, factual: 6, math: 5, general: 6 } },
  { id: 'huggingface/meta-llama/llama-3.1-70b-instruct', params: 70, label: 'Llama 3.1 70B (HF)', free: true, quality: 8, provider: 'huggingface', speed: 'standard', fit: { coding: 7, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 } },
  { id: 'huggingface/qwen/qwen2.5-72b-instruct', params: 72, label: 'Qwen 2.5 72B (HF)', free: true, quality: 8, provider: 'huggingface', speed: 'standard', fit: { coding: 9, reasoning: 8, creative: 7, factual: 8, math: 9, general: 8 } },
  { id: 'cloudflare/@cf/meta/llama-3.1-8b-instruct', params: 8, label: 'Llama 3.1 8B (CF)', free: true, quality: 6, provider: 'cloudflare', speed: 'fast', fit: { coding: 6, reasoning: 6, creative: 6, factual: 6, math: 5, general: 6 } },
  { id: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', params: 70, label: 'Llama 3.3 70B (CF)', free: true, quality: 8, provider: 'cloudflare', speed: 'standard', fit: { coding: 8, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 } },
  { id: 'cloudflare/@cf/mistral/mistral-7b-instruct-v0.1', params: 7, label: 'Mistral 7B (CF)', free: true, quality: 6, provider: 'cloudflare', speed: 'fast', fit: { coding: 6, reasoning: 6, creative: 7, factual: 6, math: 5, general: 6 } },
  { id: 'cloudflare/@cf/qwen/qwen2.5-coder-32b-instruct', params: 32, label: 'Qwen 2.5 Coder 32B (CF)', free: true, quality: 8, provider: 'cloudflare', speed: 'standard', fit: { coding: 9, reasoning: 8, creative: 6, factual: 7, math: 8, general: 7 } },
]