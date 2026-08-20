import { contained } from './poison'

/**
 * THE SECOND HALF OF THE PROTOCOL BOUNDARY, ON HIS DEVICE.
 *
 * `server/reply.ts` is where a provider's bytes become words, and it is the
 * right place for that. This is not a duplicate of it — it is the answer to a
 * different question: what happens when the thing on the other end of the wire
 * is not the server this bundle was built against.
 *
 * That is the normal case here, not an edge one. The brain and the app deploy
 * separately, the phone caches a bundle older than either, and the app is
 * installed to the Home Screen where it can go weeks without fetching a new
 * one. So "the server already guarantees this" is a guarantee about a server,
 * and the string being rendered arrived from whichever server actually
 * answered.
 *
 * The rule is the same and it is absolute: nothing containing machine syntax is
 * ever drawn as an assistant message. Cheap, total, and it applies to every
 * string that reaches a chat bubble regardless of which endpoint produced it.
 */

/** Mirrors `looksLikeProtocol` in server/reply.ts. Kept deliberately generous. */
export function looksLikeProtocol(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (/^[[{]/.test(t)) return true
  if (/```\s*(json|jsonc|yaml|xml)?\s*[[{]/i.test(t)) return true
  if (/"(reply|action|ui|op|surface|args|intent|kind)"\s*:/.test(t)) return true
  if (/<\/?(tool|function|antml:invoke|invoke|parameter)\b/i.test(t)) return true
  if (/"type"\s*:\s*"(tool_use|function_call|tool_result)"/.test(t)) return true
  return false
}

/**
 * Salvage the human sentence out of an envelope, or refuse.
 *
 * Deliberately does NOT try as hard as the server does. The server has the
 * whole response and the context to repair it; by the time a string is here it
 * has already been through that, so anything still carrying protocol is a
 * version mismatch rather than a truncation, and guessing at it would be
 * inventing an answer. One readable field, or a sentence saying it failed.
 */
export function safeText(text: string, fallback = 'That came back malformed — say it again and I’ll retry.'): string {
  return contained('parser', () => {
    const t = String(text ?? '')
    if (!looksLikeProtocol(t)) return t

    const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t)
    if (m) {
      const inner = m[1]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim()
      if (inner && !looksLikeProtocol(inner)) return inner
    }
    return fallback
  }, fallback)
}
