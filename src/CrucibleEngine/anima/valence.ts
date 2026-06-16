// ANIMA processes signal to extract universal observations. No user data is stored at any layer.
//
// Emotional valence detector. Reads conversation history, scores the current
// emotional state, identifies patterns across the session. Pure-local heuristic
// (no model call) so it adds zero latency to the critical path.
//
// PRIVACY INVARIANT: this module READS conversation history to compute a
// transient score. It NEVER writes any part of the conversation anywhere — the
// returned EmotionalValence carries only derived signal labels, never raw text.

import type { EmotionalValence, ConversationTurn } from './types.js'

// Emotionally-weighted content lexicons. Matched against message text to read the
// affective load of what is being discussed (not just how it is phrased).
const EMOTION_LEXICON: Record<string, RegExp> = {
  grief:       /\b(loss|lost|grief|griev|mourn|died|death|passed away|funeral|miss (?:her|him|them|you)|gone forever)\b/i,
  longing:     /\b(long(?:ing)?|yearn|wish (?:i|we|things)|used to|miss the|nostalg|if only|come back)\b/i,
  betrayal:    /\b(betray|cheated|lied to me|backstab|two.?faced|went behind|broke (?:my )?trust)\b/i,
  forgiveness: /\b(forgive|forgiveness|make amends|apolog|let go of|reconcil|move past)\b/i,
  anger:       /\b(furious|angry|pissed|rage|hate|sick of|fed up|can't stand|infuriat)\b/i,
  frustrated:  /\b(frustrat|stuck|nothing works|keep failing|why won't|annoy|driving me)\b/i,
  stressed:    /\b(stress|overwhelm|too much|can't cope|burn(?:ed|t)? out|exhaust|drowning|deadline|panic)\b/i,
  anxious:     /\b(anxious|anxiety|worried|scared|afraid|nervous|dread|what if|on edge)\b/i,
  sad:         /\b(sad|depress|down|low|empty|numb|hopeless|worthless|cry|tears)\b/i,
  lonely:      /\b(lonely|alone|no one|isolated|nobody (?:gets|understands)|by myself)\b/i,
  curious:     /\b(curious|wonder|fascinat|interesting|how does|what if we|explore|learn about)\b/i,
  calm:        /\b(thanks|appreciate|makes sense|got it|perfect|great|that helps|relaxed)\b/i,
}

// Positive vs negative affect for each dominant emotion → signed valence base.
const EMOTION_VALENCE: Record<string, number> = {
  grief: -0.8, longing: -0.5, betrayal: -0.7, forgiveness: -0.2, anger: -0.7,
  frustrated: -0.5, stressed: -0.6, anxious: -0.6, sad: -0.7, lonely: -0.6,
  curious: 0.5, calm: 0.6,
}

// Behavioural signals: what the user reaches for AFTER an emotional moment.
const BEHAVIORAL_SIGNALS: Record<string, RegExp> = {
  'sensory-regulation (music)': /\b(open|play|put on|start)\s+(spotify|music|a (?:song|playlist)|something to listen)/i,
  'seeking-rest':               /\b(sleep|nap|go to bed|rest|tired|lie down|can't sleep|insomnia)\b/i,
  'seeking-distraction':        /\b(distract|take my mind off|something fun|watch (?:something|a)|game|scroll)\b/i,
  'seeking-grounding':          /\b(breathe|breathing|meditat|calm down|ground myself|walk outside)\b/i,
}

const URGENCY = /\b(now|asap|immediately|urgent|hurry|quick|right now|need this)\b|!{2,}/i

// U10 — Time-of-day emotional context signal.
// Late night and early morning sessions carry higher baseline loneliness/stress
// signal that can amplify borderline readings. Applied only when confidence from
// content signals is already above zero (avoids adding signal to neutral sessions).
function timeOfDayModifier(): { signal: string | null; scoreNudge: number } {
  const h = new Date().getHours()
  if (h >= 23 || h <= 3)  return { signal: 'time:late-night',    scoreNudge: -0.08 }
  if (h >= 4  && h <= 6)  return { signal: 'time:early-morning', scoreNudge: -0.06 }
  if (h >= 7  && h <= 9)  return { signal: 'time:morning',       scoreNudge: 0 }
  if (h >= 20 && h <= 22) return { signal: 'time:evening',       scoreNudge: -0.03 }
  return { signal: null, scoreNudge: 0 }
}

export function detectValence(
  history: ConversationTurn[],
  currentPrompt: string,
): EmotionalValence {
  const signals: string[] = []
  const recentUser = [...history.slice(-3).map(h => h.user), currentPrompt].filter(Boolean)
  const corpus = recentUser.join('\n')
  const lower = corpus.toLowerCase()

  // 1. Content emotional weight — strongest single signal.
  const emotionScores: Record<string, number> = {}
  for (const [emotion, re] of Object.entries(EMOTION_LEXICON)) {
    const matches = (corpus.match(new RegExp(re.source, 'gi')) ?? []).length
    if (matches > 0) {
      emotionScores[emotion] = matches
      signals.push(`content:${emotion}×${matches}`)
    }
  }

  // 2. Linguistic stress markers — short fragmented messages, repetition, urgency.
  const lastMsg = currentPrompt.trim()
  const wordCount = lastMsg.split(/\s+/).filter(Boolean).length
  if (wordCount > 0 && wordCount <= 4 && history.length >= 2) {
    signals.push('linguistic:terse-message')
    emotionScores['frustrated'] = (emotionScores['frustrated'] ?? 0) + 0.5
  }
  if (URGENCY.test(lastMsg)) {
    signals.push('linguistic:urgency')
    emotionScores['stressed'] = (emotionScores['stressed'] ?? 0) + 0.5
  }
  // Repetition across recent turns (same ask reworded) reads as mounting frustration.
  if (history.length >= 2) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, '').trim()
    const prev = norm(history[history.length - 1].user)
    if (prev && norm(currentPrompt) && jaccard(prev, norm(currentPrompt)) > 0.5) {
      signals.push('linguistic:repetition')
      emotionScores['frustrated'] = (emotionScores['frustrated'] ?? 0) + 0.6
    }
  }

  // 3. Topic shift — analytical/technical history → personal/emotional now (or vice versa).
  const techRe = /\b(code|function|api|deploy|bug|server|algorithm|database|config|build)\b/i
  const personalRe = /\b(i feel|i'm|my (?:wife|husband|partner|mom|dad|friend|life|head)|me|myself|lately)\b/i
  const histTech = history.slice(-3).some(h => techRe.test(h.user))
  const nowPersonal = personalRe.test(lastMsg)
  if (histTech && nowPersonal) signals.push('topic-shift:technical→personal')

  // 4. Behavioural signals — and the GAP between request and emotional context.
  let behavioralGap = false
  for (const [label, re] of Object.entries(BEHAVIORAL_SIGNALS)) {
    if (re.test(lastMsg)) {
      signals.push(`behavioral:${label}`)
      // A regulation/rest request RIGHT AFTER distress is the telltale gap:
      // the literal ask is small, the emotional context behind it is large.
      const priorDistress = history.slice(-3).some(h =>
        Object.entries(EMOTION_LEXICON).some(([e, r]) => EMOTION_VALENCE[e] < -0.3 && r.test(h.user)))
      if (priorDistress) {
        behavioralGap = true
        signals.push('gap:small-ask-large-context')
      }
    }
  }

  // ── Resolve dominant emotion + signed score ──────────────────────────────
  const ranked = Object.entries(emotionScores).sort((a, b) => b[1] - a[1])
  const dominant = ranked.length ? ranked[0][0] : 'neutral'
  let score = ranked.length ? (EMOTION_VALENCE[dominant] ?? 0) : 0
  // Multiple distinct negative signals deepen the reading.
  const negativeCount = ranked.filter(([e]) => (EMOTION_VALENCE[e] ?? 0) < 0).length
  if (negativeCount >= 2) score = Math.max(-1, score - 0.15)
  if (behavioralGap) score = Math.max(-1, score - 0.1)

  // ── Confidence — how much signal supports the reading ─────────────────────
  // Low confidence ⇒ caller must not act on it.
  let confidence = 0
  if (ranked.length) confidence += Math.min(0.55, ranked[0][1] * 0.22)
  if (signals.some(s => s.startsWith('topic-shift'))) confidence += 0.12
  if (behavioralGap) confidence += 0.2
  if (signals.some(s => s.startsWith('linguistic'))) confidence += 0.1
  if (negativeCount >= 2) confidence += 0.1
  confidence = Math.min(0.95, Math.round(confidence * 100) / 100)

  // U10 — time-of-day modifier: only applies when there is already emotional signal.
  // Late-night/early-morning sessions amplify existing negative readings slightly.
  if (confidence > 0) {
    const tod = timeOfDayModifier()
    if (tod.signal) {
      signals.push(tod.signal)
      score = Math.max(-1, Math.min(1, score + tod.scoreNudge))
      // Small bump to confidence: time is a weak signal but it's real.
      confidence = Math.min(0.95, confidence + 0.04)
    }
  }

  return {
    score: Math.round(score * 100) / 100,
    dominant: ranked.length ? dominant : 'neutral',
    signals,
    confidence,
  }
}

function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(/\s+/)), sb = new Set(b.split(/\s+/))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}
