// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — tableMachine.
// Run: npx tsx __audit__/tableMachine.hidden.ts   (imports ../src/tableMachine)
import { Machine } from '../src/tableMachine'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const def = {
  initial: 'idle',
  transitions: {
    idle: { start: 'running' },
    running: { pause: 'paused', stop: 'idle', tick: 'running' },
    paused: { resume: 'running', stop: 'idle' },
  },
}

const m = new Machine(def)
check('starts at initial', m.state === 'idle')
check('can on defined event', m.can('start') === true)
check('can on undefined event', m.can('stop') === false)
check('can does not change state', m.state === 'idle')
check('send returns new state', m.send('start') === 'running')
check('state updated', m.state === 'running')
check('self-transition legal', m.send('tick') === 'running')
m.send('pause')
check('chained transitions', m.state === 'paused')
m.send('resume'); m.send('stop')
check('full cycle back to idle', m.state === 'idle')
check('history includes initial and every entry',
  m.history.join('>') === 'idle>running>running>paused>running>idle')
check('history is a fresh copy', (() => { const h = m.history; h.push('x'); return m.history.length === 6 })())
let sendErr = ''
try { m.send('resume') } catch (e) { sendErr = (e as Error).message }
check('undefined transition throws', sendErr.length > 0)
check('error names the event', sendErr.includes('resume'))
check('error names the state', sendErr.includes('idle'))
check('failed send leaves state unchanged', m.state === 'idle')
let ctorThrew = false
try { new Machine({ initial: 'ghost', transitions: { idle: {} } }) } catch { ctorThrew = true }
check('unknown initial state throws at construction', ctorThrew)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
