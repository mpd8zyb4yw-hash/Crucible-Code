// Deterministic output polish — strips the cruft free-tier models pad responses with,
// applied before outputs are synthesized, polished, or shown as final. No model call;
// pure text in / pure text out. This is the first half of "garbage in, gold out":
// clean the inputs deterministically so the model polish pass has less to fight.

export interface NormalizeOpts {
  /** Strip a single leading conversational lead-in line ("Sure, here's …:"). Default true. */
  stripPreamble?: boolean
}

// Does this text read as natural-language prose rather than source code? Used to decide
// whether a code-shaped wrapper around the text was a model mistake (a story stuffed into
// `const story = \`…\`;` or a ```block```) that should be unwrapped. Conservative on purpose:
// real code has high symbol density and short token runs, so it never trips this.
function looksLikeProse(s: string): boolean {
  const t = s.trim()
  if (t.length < 12 || !/\s/.test(t)) return false
  const letters = (t.match(/[a-zA-Z]/g) ?? []).length
  if (letters / t.length < 0.6) return false                 // mostly words, not symbols
  const codeSymbols = (t.match(/[{}();=<>]/g) ?? []).length
  if (codeSymbols / t.length > 0.03) return false            // low code-punctuation density
  const hasSentence = /[.!?]["')]?(\s|$)/.test(t)
  return hasSentence || t.length > 60
}

// Unwrap prose that a model wrapped in trivial code scaffolding. Returns the inner prose,
// or the original string unchanged if it isn't a recognised prose-in-code wrapper.
function unwrapProseWrapper(input: string): string {
  const t = input.trim()

  // 1) Whole answer is a single fenced block: ```lang\n…\n``` — unwrap if the inside is prose.
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/)
  if (fence && looksLikeProse(fence[1])) return fence[1].trim()

  // 2) Single variable holding a string/template literal:  const story = `…`;  /  let x = "…"
  const varAssign = t.match(/^(?:const|let|var)\s+\w+\s*=\s*(['"`])([\s\S]*)\1\s*;?\s*$/)
  if (varAssign && looksLikeProse(varAssign[2])) return varAssign[2].trim()

  // 3) A lone print/log call wrapping the whole answer:  console.log(`…`)  /  print("…")
  const call = t.match(/^(?:console\.log|print|echo|puts|System\.out\.println)\s*\(\s*(['"`])([\s\S]*)\1\s*\)\s*;?\s*$/)
  if (call && looksLikeProse(call[2])) return call[2].trim()

  return input
}

// Emoji / decorative pictographs (the prompts also forbid these — this is the backstop).
// Deliberately excludes ASCII and common math/arrow glyphs used inside real answers.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2934}\u{2935}]/gu

// A conversational lead-in is only stripped when the whole first line is one AND it ends
// with a colon — so real content like "Of course X holds because…" is never eaten.
const PREAMBLE_RE =
  /^(?:sure|certainly|absolutely|of course|great|got it|okay|ok|alright|no problem|happy to help|here(?:'s| is| are)|let me|i(?:'ll| will| can)|below is|the following)\b.*:$/i

// Trailing assistant filler that adds nothing to the answer.
const TRAILING_RE =
  /\n+(?:let me know if[^\n]*|hope (?:this|that) helps[^\n]*|feel free to[^\n]*|i hope this[^\n]*|is there anything else[^\n]*)\s*$/i

// Explicit length/format directives a user might give. If matched, the synthesis/polish
// pass is told to obey it exactly. Order matters — more specific patterns first.
const LENGTH_DIRECTIVES: RegExp[] = [
  /\bin (?:a|one|1|two|2|three|3|four|4|five|5) (?:sentences?|words?|paragraphs?|lines?)\b/i,
  /\b(?:one|single|1)[- ]?(?:sentence|word|line|paragraph)\b/i,
  /\bin (?:no more than|under|less than|at most) \d+ (?:words?|sentences?|characters?|lines?)\b/i,
  /\bin \d+ (?:words?|sentences?|characters?|lines?)\b/i,
  /\b(?:as |in )?(?:a )?(?:bullet(?:ed)? (?:points?|list)|numbered list)\b/i,
  /\b(?:briefly|concisely|be brief|be concise|in short|in brief|short answer|keep it short|tl;?dr)\b/i,
  /\bone[- ]?liner\b/i,
]

/** Extract an explicit length/format directive from a user message, or null if none. */
export function extractLengthDirective(message: string): string | null {
  if (!message) return null
  for (const re of LENGTH_DIRECTIVES) {
    const m = message.match(re)
    if (m) return m[0].trim().toLowerCase()
  }
  return null
}

export function normalizeOutput(input: string, opts: NormalizeOpts = {}): string {
  if (!input) return input
  let t = input.replace(/\r\n/g, '\n')

  // Backstop: unwrap prose a model mistakenly stuffed into code scaffolding
  // (`const story = \`…\`;`, a lone ```block```, a print/log call). No-op on real code.
  t = unwrapProseWrapper(t)

  // Backstop: remove any emoji/pictographs that slipped past the prompt rules.
  t = t.replace(EMOJI_RE, '')

  // Strip a single conversational preamble line, if present.
  if (opts.stripPreamble !== false) {
    const firstNl = t.indexOf('\n')
    if (firstNl !== -1) {
      const firstLine = t.slice(0, firstNl).trim()
      if (firstLine.length <= 120 && PREAMBLE_RE.test(firstLine)) {
        t = t.slice(firstNl + 1)
      }
    }
  }

  // Strip trailing assistant filler.
  t = t.replace(TRAILING_RE, '')

  // Tidy whitespace: drop trailing spaces, collapse 3+ blank lines to one.
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')

  return t.trim()
}
