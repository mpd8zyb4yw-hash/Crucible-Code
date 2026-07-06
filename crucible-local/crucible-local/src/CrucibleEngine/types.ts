/**
 * Shared streaming contract for both the local (on-device) engine and the
 * opt-in ensemble engine. The MoltenPour animation and chat UI drive off
 * these real lifecycle callbacks — never off a fixed timer.
 */
export interface StreamHandlers {
  /** Fires once, when the first token arrives. `totalChars` is the known length
   *  of the full reply the engine has already composed — used by the pour
   *  animation as a real (not timer-based) fill-progress denominator. */
  onFirstToken?: (totalChars: number) => void
  onChunk?: (chunkText: string, fullTextSoFar: string) => void
  onDone?: (fullText: string) => void
  onError?: (err: Error) => void
}

export interface StreamHandle {
  cancel: () => void
}

export interface ApiKey {
  id: string
  name: string
  /** Raw value as entered — may be a bare token or a full endpoint URL. See ensemble.ts. */
  value: string
  masked: string
  createdAt: number
}

export interface ModelChip {
  label: string
  color: string
  chipBg: string
  chipBorder: string
  role: string
}
