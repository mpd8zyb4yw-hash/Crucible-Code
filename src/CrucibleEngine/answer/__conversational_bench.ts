// Pure, offline bench for the deterministic conversational meta-handler. No model calls.
// Run: npx tsx src/CrucibleEngine/answer/__conversational_bench.ts  (npm run conversational:bench)
import { matchMeta, clarifyBuild } from './conversational'

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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
