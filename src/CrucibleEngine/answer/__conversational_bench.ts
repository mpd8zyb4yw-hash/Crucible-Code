// Pure, offline bench for the deterministic conversational meta-handler. No model calls.
// Run: npx tsx src/CrucibleEngine/answer/__conversational_bench.ts  (npm run conversational:bench)
import { matchMeta, clarifyBuild } from './conversational'
import { resolveBuildTurn } from './buildNegotiation'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('== bare greetings/probes are caught (this is the "test" bug) ==')
for (const g of ['test', 'testing', 'hi', 'hello', 'hey', 'yo', 'hey there', 'good morning', 'ping', 'are you there?', 'you there', 'is this working', 'test test']) {
  const r = matchMeta(g)
  check(`"${g}" → greeting`, r?.kind === 'greeting', r ? r.kind : 'null')
}

console.log('\n== identity questions are caught ==')
for (const q of ['who are you', 'who are you?', 'what are you', "what's your name", 'introduce yourself', 'tell me about yourself', 'are you an AI', 'are you chatgpt']) {
  const r = matchMeta(q)
  check(`"${q}" → identity`, r?.kind === 'identity', r ? r.kind : 'null')
}

console.log('\n== capability questions are caught ==')
for (const q of ['what can you do', 'what can you do?', 'what do you do', 'how can you help', 'what are you capable of', 'help']) {
  const r = matchMeta(q)
  check(`"${q}" → capability`, r?.kind === 'capability', r ? r.kind : 'null')
}

console.log('\n== real questions/requests are NOT swallowed (must return null) ==')
for (const q of [
  'who won the 2018 World Cup?',            // contains "who" — must NOT be identity
  'who are you voting for',                 // contains "who are you" but is a real question
  'what are you going to do about the bug', // contains "what are you"
  'test my regex against these strings',    // contains "test" but is a task
  'build me a game',                        // build request → agent path
  'hello world program in python',          // contains "hello" but is a code ask
  'what can you tell me about the French Revolution', // "what can you" but a real topic
  'how can you help me if I give you a file to parse', // borderline — real task
  'what is the capital of Japan',
]) {
  const r = matchMeta(q)
  check(`"${q}" → null`, r === null, r ? `${r.kind}` : 'null')
}

console.log('\n== answers are grounded + non-empty ==')
{
  const g = matchMeta('hi')!, i = matchMeta('who are you')!, c = matchMeta('what can you do')!
  check('greeting names Crucible + on-device', /Crucible/.test(g.text) && /device/i.test(g.text))
  check('identity is honest about local-only', /Crucible/.test(i.text) && /(local|device|nothing leaves)/i.test(i.text))
  check('identity does NOT claim to be a study assistant', !/stud(y|ies|ying)/i.test(i.text))
  check('capability lists reason + code', /reason/i.test(c.text) && /code/i.test(c.text))
}

console.log('\n== underspecified build requests get a clarifying reply (the "build me a game" bug) ==')
for (const b of ['build me a game', 'make an app', 'create a website', 'build a program', 'make me something', 'whip up a tool', 'build me a game.', 'can you build me a game']) {
  const r = clarifyBuild(b)
  check(`"${b}" → clarify`, !!r && /\?/.test(r!), r ? 'ok' : 'null')
}
check('game clarify names concrete options', /snake/i.test(clarifyBuild('build me a game') || ''))
check('game clarify does NOT recycle a greeting', !/help you with your test/i.test(clarifyBuild('build me a game') || ''))

console.log('\n== SPECIFIC build requests are NOT intercepted (must build, return null) ==')
for (const b of ['build me a snake game', 'make a todo app in react', 'create a portfolio website for a photographer', 'build a calculator that does percentages', 'write a python script to rename files', 'build me a game where you dodge asteroids']) {
  const r = clarifyBuild(b)
  check(`"${b}" → null (builds)`, r === null, r ? 'intercepted' : 'null')
}

// ── Build negotiation: greenlight after a discussion must BUILD, not re-clarify ──
// This is the 2026-07-11 "utter failure" bug: game→different→fps→battle royale→"i trust you,
// do your thing"→"build the game" looped forever in FM role-play and never built anything.
console.log('\n== greenlight after a build discussion assembles a spec and BUILDS ==')
{
  const negotiation = [
    { user: 'make me a game', assistant: 'Happy to build you a game — what kind? Snake / Memory / Number guessing' },
    { user: 'can it be something different than the ones you described?', assistant: 'Sure — a text adventure?' },
    { user: 'a simple fps game?', assistant: 'Sure, an FPS. Which kind?' },
    { user: 'battle royale', assistant: "Great choice! Here's an outline…" },
  ]
  const trust = resolveBuildTurn('i trust you, do your thing', negotiation)
  check('"i trust you, do your thing" → build (not another outline)', trust.action === 'build', trust.action)
  check('assembled spec is concrete + runnable', !!trust.spec && /browser|canvas|html/i.test(trust.spec!))
  check('battle-royale/fps ask is honestly downscoped', !!trust.note && /on-device|beyond/i.test(trust.note!))

  const buildIt = resolveBuildTurn('build the game', negotiation)
  check('"build the game" → build', buildIt.action === 'build', buildIt.action)

  const snakeChat = [{ user: 'make me a game', assistant: 'what kind?' }, { user: 'snake', assistant: 'ok, snake?' }]
  const goSnake = resolveBuildTurn('go ahead', snakeChat)
  check('"go ahead" after picking snake → build a snake game', goSnake.action === 'build' && /snake/i.test(goSnake.spec || ''), goSnake.topic)
  check('normal-scope game gets NO downscope note', !goSnake.note)

  const appChat = [{ user: 'build me an app', assistant: 'what should it do?' }, { user: 'a todo list', assistant: 'ok' }]
  const goApp = resolveBuildTurn('do your thing', appChat)
  check('"do your thing" after an app discussion → build', goApp.action === 'build' && /app/i.test(goApp.spec || ''))
}

// ── Mid-negotiation refinement turns: deterministic clarify, never FM role-play ──
// The "lower-severity" half of the 2026-07-11 failure: turns 2–4 (game→different?→fps?→
// battle royale) fell to the weak FM before the user greenlit. Each must resolve to a concrete
// system-owned reply that confirms + honestly downscopes + invites a go-ahead.
console.log('\n== mid-negotiation refinements → deterministic clarify (not FM role-play) ==')
{
  const base = [{ user: 'make me a game', assistant: 'Happy to build you a game — what kind? Snake / Memory / Number guessing' }]

  const diff = resolveBuildTurn('can it be something different than the ones you described?', base)
  check('"…something different…" → clarify', diff.action === 'clarify', diff.action)
  check('contentless refinement offers concrete options', !!diff.text && /snake/i.test(diff.text!))

  const fps = resolveBuildTurn('a simple fps game?', base)
  check('"a simple fps game?" → clarify', fps.action === 'clarify', fps.action)
  check('fps is honestly downscoped (on-device limit stated)', !!fps.text && /on-device|entirely on-device/i.test(fps.text!))
  check('fps clarify invites a one-word greenlight', !!fps.text && /\b(go|do your thing)\b/i.test(fps.text!))

  const br = resolveBuildTurn('battle royale', [...base, { user: 'a simple fps game?', assistant: 'Sure, an FPS.' }])
  check('"battle royale" → clarify + downscoped', br.action === 'clarify' && /on-device/i.test(br.text || ''), br.action)

  const snake = resolveBuildTurn('snake', base)
  check('"snake" (in-scope) → clarify offering to build, no downscope', snake.action === 'clarify' && /snake/i.test(snake.text || '') && !/on-device/i.test(snake.text || ''))

  const about = resolveBuildTurn('what about a chess game?', base)
  check('"what about a chess game?" → clarify naming chess', about.action === 'clarify' && /chess/i.test(about.text || ''), about.topic)

  // Bare acknowledgements mid-negotiation must NOT fall to FM role-play (the live "thanks, that
  // helps" → "create a Board Game… use Unity or Unreal Engine" hole).
  for (const ack of ['thanks, that helps', 'cool', 'got it, thanks', 'nice', 'awesome thanks', 'makes sense']) {
    const r = resolveBuildTurn(ack, base)
    check(`"${ack}" mid-build → clarify nudge (not role-play)`, r.action === 'clarify' && /\bgo\b/i.test(r.text || ''), r.action)
  }
}

console.log('\n== refinement handler does NOT hijack unrelated / fresh turns ==')
{
  // No build established yet in history → the refinement path must stay out of it.
  check('genre word with empty history → passthrough (clarifyBuild owns turn 1)',
    resolveBuildTurn('snake', []).action === 'passthrough')
  // A build IS under discussion, but this turn is an unrelated aside → passthrough.
  const base = [{ user: 'make me a game', assistant: 'what kind?' }]
  check('"what time is it?" mid-build → passthrough',
    resolveBuildTurn('what time is it?', base).action === 'passthrough')
  // The first bare build itself must NOT be captured as a refinement (no prior build in history).
  check('first "make me a game" → passthrough (not a refinement)',
    resolveBuildTurn('make me a game', []).action === 'passthrough')
  // A refinement after a NON-build discussion must not fire.
  check('genre word after a factual chat → passthrough',
    resolveBuildTurn('snake', [{ user: 'tell me about snakes', assistant: 'Snakes are reptiles…' }]).action === 'passthrough')
  // A bare ack with no build under discussion is just a normal "thanks" — passthrough.
  check('"thanks" with empty history → passthrough',
    resolveBuildTurn('thanks', []).action === 'passthrough')
  // A real content request that merely OPENS with an ack word is not swallowed as an ack.
  check('"cool, can you add a leaderboard?" → passthrough (real request, not a bare ack)',
    resolveBuildTurn('cool, can you add a leaderboard?', base).action === 'passthrough')
}

console.log('\n== greenlights WITHOUT a build topic must NOT build (no false positives) ==')
{
  check('"yes" to a factual chat → passthrough',
    resolveBuildTurn('yes', [{ user: 'is the sky blue?', assistant: 'Yes.' }]).action === 'passthrough')
  check('"go ahead" with empty history → passthrough',
    resolveBuildTurn('go ahead', []).action === 'passthrough')
  check('"do it" after a non-build discussion → passthrough',
    resolveBuildTurn('do it', [{ user: 'explain recursion', assistant: '…' }]).action === 'passthrough')
  // A real spec-bearing build request is NOT a bare greenlight — it flows through the normal
  // builder path, not this resolver (which only fires on go-aheads).
  check('"build me a snake game" (has its own spec) → passthrough here',
    resolveBuildTurn('build me a snake game', []).action === 'passthrough')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
