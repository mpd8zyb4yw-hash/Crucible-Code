// Small pure helpers extracted from server.ts so they're unit-testable in isolation.

/** Race `promise` against a timeout; resolve `fallback` if `ms` elapses first. Clears the timer
 *  once the race settles so a fast success doesn't leave a misleading "timed out" log pending. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(() => {
      console.log(`[withTimeout] Timed out after ${ms}ms — using fallback`)
      resolve(fallback)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Cheap token estimate (~4 chars/token) over a chat message array. */
export function estimateMessageTokens(messages: { role: string; content: string }[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4)
}

/** Derive a conversation title from its rounds: the first user message's opening 8 words
 *  (with an ellipsis if truncated), or 'New chat' when there's no user message yet. */
export function conversationTitle(rounds: Array<{ userMessage?: string } | null | undefined>): string {
  const first = Array.isArray(rounds) ? rounds.find(r => r && r.userMessage) : null
  const q = (first?.userMessage ?? '').trim().replace(/\s+/g, ' ')
  if (!q) return 'New chat'
  const words = q.split(' ')
  return words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '')
}
