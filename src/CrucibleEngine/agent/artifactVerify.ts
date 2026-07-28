// Artifact verification — does the thing that came back match the thing that was asked for?
//
// MEASURED: asked for "a set of flash cards", the agent returned a well-written ESSAY about
// photosynthesis, and it was stamped `✓ verified`. Every check in the system looked at whether
// the run crashed, not at whether the deliverable was the deliverable. That is the same
// false-green as cont.104 ("inbox is empty", zero tool calls, verifier clean) — a gate that
// passes because nothing it inspects is broken, while the thing the user asked for is absent.
//
// DOCTRINE.md asks one question before a feature ships: "where is the deterministic verifier, and
// what is the ground truth?" Here the ground truth already exists and was simply never consulted
// — `goalSpec` resolved `quantity: 20` and `format: two-sided question/answer deck` before the
// agent ever started. This file checks the artifact against that spec.
//
// THE UNIVERSAL FORM. A per-deliverable checker would be the template pile the doctrine bans, so
// the verification is STRUCTURAL. Every content deliverable is a countable set of items with a
// required internal shape, and there are only a few shapes:
//
//     pair    two labelled halves per item      flash cards, quiz, glossary, Q&A
//     block   a heading plus a body per item    slides, sections, chapters
//     bullet  one line per item                 outlines, checklists, lists
//     prose   one continuous document           summaries, essays, briefs
//
// Four predicates cover essentially every content artifact, so a NEW deliverable inherits
// verification by naming a shape, not by adding code. That is the same universal-slots /
// derived-defaults split `goalSpec` already uses.
//
// ZERO MODEL. Parsing and counting are deterministic, so this is fast, reproducible, and cannot
// itself hallucinate a pass. Failures are HIGH-INFORMATION on purpose (`DOCTRINE.md` §4 —
// maximise information per model call): "found 6 items, expected 20" converges a retry in one
// round where "wrong" would not converge at all.

export type ItemShape = 'pair' | 'block' | 'bullet' | 'prose'

export interface ArtifactProblem {
  code: 'empty' | 'wrong-shape' | 'count-short' | 'count-long' | 'degenerate'
  detail: string
}

export interface ArtifactVerdict {
  ok: boolean
  /** Items actually found in the artifact. */
  found: number
  expected: number
  shape: ItemShape
  problems: ArtifactProblem[]
  /** A single instruction the model can act on. Empty when ok. */
  feedback: string
}

// ── Item parsing ──────────────────────────────────────────────────────────────

/** Split a document into candidate items: numbered entries, or blank-line-separated blocks. */
function splitItems(text: string): string[] {
  const t = text.replace(/\r\n/g, '\n').trim()
  if (!t) return []

  // Prefer an explicit enumeration when one is present — "1." / "1)" / "Card 1:" at line start.
  // Two or more markers means the author genuinely enumerated; one is a false positive.
  const enumSplit = t.split(/\n(?=\s*(?:\d{1,3}[.)]\s|(?:card|question|item|slide|term)\s*\d{1,3}\s*[:.\-])\s*)/i)
  if (enumSplit.length >= 2) return enumSplit.map(s => s.trim()).filter(Boolean)

  // Markdown headings as item boundaries.
  const headingSplit = t.split(/\n(?=#{1,6}\s+\S)/)
  if (headingSplit.length >= 2) return headingSplit.map(s => s.trim()).filter(Boolean)

  // Otherwise blank-line blocks.
  const blocks = t.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
  return blocks
}

/** Bullet lines, for the `bullet` shape — counted individually rather than as blocks. */
function bulletLines(text: string): string[] {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => /^(?:[-*•]|\d{1,3}[.)])\s+\S/.test(l))
}

// Two labelled halves. Deliberately broad on the LABELS (Q/A, Front/Back, Term/Definition) but
// strict on the STRUCTURE — both halves must be present and non-empty. A card with a question and
// no answer is not a card, and that is exactly the degenerate output worth catching.
const PAIR_LABELS = '(?:q|question|front|term|prompt|word|a|answer|back|definition|meaning|response)'
// An optional list marker may precede the label — "1. Question: …" is the single most common
// notation a model produces, and omitting it made the verifier FALSE-REJECT a correct deck.
// A false reject is worse than a false accept here: it burns the retry budget arguing with
// output that was already right (`crucible-verifier-two-failure-directions`).
const PAIR_RE = new RegExp(
  `(?:^|\\n)\\s*(?:\\d{1,3}[.)]\\s*)?\\**\\s*(${PAIR_LABELS})\\s*\\**\\s*[:\\-–]\\s*\\S`,
  'gi',
)

function isPair(item: string): boolean {
  const labels = [...item.matchAll(PAIR_RE)].map(m => m[1].toLowerCase())
  if (labels.length < 2) return false
  const front = new Set(['q', 'question', 'front', 'term', 'prompt', 'word'])
  const back = new Set(['a', 'answer', 'back', 'definition', 'meaning', 'response'])
  // One of each side — two "Question:" lines in a row is not a pair.
  return labels.some(l => front.has(l)) && labels.some(l => back.has(l))
}

function isBlock(item: string): boolean {
  const lines = item.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return false
  // A heading-ish first line (markdown heading, bold, numbered title, or short + no terminal
  // punctuation) followed by content.
  const head = lines[0]
  const headingish = /^#{1,6}\s+\S/.test(head) || /^\*\*.+\*\*:?$/.test(head)
    || /^\d{1,3}[.)]\s+\S/.test(head) || (head.length <= 90 && !/[.!?]$/.test(head))
  return headingish && lines.slice(1).join(' ').length > 10
}

/** Placeholder output — "Question 1 / Answer 1", "Front: TBD", lorem filler. */
const DEGENERATE = /\b(?:question|answer|front|back|term|card|item)\s*\d+\s*$|^\s*(?:tbd|todo|placeholder|lorem ipsum|\.{3})\s*$/im

// ── Verification ──────────────────────────────────────────────────────────────

export interface ArtifactExpectation {
  shape: ItemShape
  /** Expected item count. 1 for prose deliverables. */
  count: number
  /** What the user called it, for the feedback line. */
  deliverable: string
}

/**
 * Check an artifact against what was asked for.
 *
 * TOTAL: any input returns a verdict; malformed or empty text fails loudly rather than throwing.
 * Never returns ok for an empty artifact, which is the failure mode that shipped stamped clean.
 */
export function verifyArtifact(text: string, exp: ArtifactExpectation): ArtifactVerdict {
  const body = (text ?? '').trim()
  const problems: ArtifactProblem[] = []
  const base = { expected: exp.count, shape: exp.shape }

  if (!body) {
    return {
      ok: false, found: 0, ...base,
      problems: [{ code: 'empty', detail: 'The artifact is empty.' }],
      feedback: `You produced nothing. Write the ${exp.deliverable} out in full.`,
    }
  }

  // ── prose: one document, judged on substance rather than count ──
  if (exp.shape === 'prose') {
    const words = body.split(/\s+/).length
    if (words < 40) {
      problems.push({ code: 'count-short', detail: `Only ${words} words.` })
    }
    const ok = problems.length === 0
    return {
      ok, found: 1, ...base, problems,
      feedback: ok ? '' : `The ${exp.deliverable} is too thin (${words} words). Write it properly.`,
    }
  }

  // ── bullet: count lines ──
  if (exp.shape === 'bullet') {
    const bullets = bulletLines(body)
    const found = bullets.length
    if (found < exp.count) problems.push({ code: 'count-short', detail: `${found} of ${exp.count}` })
    const ok = problems.length === 0
    return {
      ok, found, ...base, problems,
      feedback: ok ? '' : `You produced ${found} items but ${exp.count} were asked for. Output exactly ${exp.count}, one per line.`,
    }
  }

  // ── pair / block: parse items and check each one's shape ──
  const items = splitItems(body)
  const predicate = exp.shape === 'pair' ? isPair : isBlock
  const valid = items.filter(predicate)
  const found = valid.length

  if (found === 0) {
    // The headline failure: an essay where a deck was requested.
    problems.push({
      code: 'wrong-shape',
      detail: exp.shape === 'pair'
        ? 'No question/answer pairs found — this reads as continuous prose.'
        : 'No titled sections found.',
    })
  } else if (found < exp.count) {
    problems.push({ code: 'count-short', detail: `${found} of ${exp.count}` })
  } else if (found > exp.count * 1.5) {
    problems.push({ code: 'count-long', detail: `${found}, well over the ${exp.count} asked for` })
  }

  if (DEGENERATE.test(body)) {
    problems.push({ code: 'degenerate', detail: 'Contains placeholder text like "Question 1 / Answer 1".' })
  }

  const ok = problems.length === 0
  return {
    ok, found, ...base, problems,
    feedback: ok ? '' : buildFeedback(exp, found, problems),
  }
}

/**
 * One actionable instruction, not a list of complaints.
 *
 * The retry that follows gets exactly this string, so it states the shape CONCRETELY — a model
 * told "wrong format" produces the same wrong format again, while one shown the literal layout
 * complies. `crucible-repair-is-a-search`: never hand back the rejected artifact, hand back the
 * constraint.
 */
function buildFeedback(exp: ArtifactExpectation, found: number, problems: ArtifactProblem[]): string {
  // A LITERAL EXAMPLE, not a description of one. Measured: told "each item must be two labelled
  // lines", the weak head produced prose again; the shape has to be shown, not specified.
  const shapeSpec = exp.shape === 'pair'
    ? 'Output NOTHING but items in exactly this form, separated by blank lines:\n\n' +
      'Q: What pigment absorbs light in the thylakoid membrane?\nA: Chlorophyll.\n\n' +
      'Q: What two molecules do the light reactions produce?\nA: ATP and NADPH.\n\n' +
      'No introduction, no headings, no prose paragraphs — only Q:/A: lines.'
    : exp.shape === 'block'
      ? 'Output NOTHING but items in exactly this form:\n\n## First title\nIts content here.\n\n## Second title\nIts content here.'
      : 'Output NOTHING but one item per line, each starting with "- ".'
  const wrongShape = problems.some(p => p.code === 'wrong-shape')
  const lead = wrongShape
    ? `That is prose, not a ${exp.deliverable}.`
    : `You produced ${found} items; ${exp.count} were asked for.`
  const degenerate = problems.some(p => p.code === 'degenerate')
    ? ' Do not use placeholders like "Question 1" — write real content.'
    : ''
  return `${lead} Produce exactly ${exp.count} items.\n\n${shapeSpec}${degenerate}`
}
