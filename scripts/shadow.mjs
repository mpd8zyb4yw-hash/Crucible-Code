/**
 * THE DEVELOPER VIEW ONTO THE MEMORY CORE — §57's ACTIONS, AS A PROMPT.
 *
 * A command rather than a screen, for the reason `inspect.ts` already gives about
 * itself and for one more that is specific to this milestone. §14 and §68 are firm
 * that routines, hypotheses, confidence and predictions are implementation
 * concepts and must not become panels in his app; the surest way to honour that is
 * for the tooling that shows them to have no way to reach a screen at all.
 *
 * IT OPENS THE REAL DATABASE. `~/.crucible/memory.db`, the one the running server
 * writes, not a fixture — because the whole question of this phase is whether the
 * cognition holds up on his actual life, and a tool that could only be pointed at
 * synthetic data would answer a question nobody is asking. `--db` overrides it.
 *
 * ONLY `reflect` AND `rebuild` WRITE. Everything else is a read, so the common
 * case — looking at what it thought — cannot change what it thought. Both writers
 * say what they are about to do and `rebuild` names what it will destroy, because
 * a rebuild against months of real evidence is cheap to run and expensive to run
 * by accident.
 *
 *     npm run shadow                    what it knows, and the last few passes
 *     npm run shadow -- runs 20         one line per pass
 *     npm run shadow -- run last        one pass in full, §29's layout
 *     npm run shadow -- interesting     only passes that would have said something
 *     npm run shadow -- explain <id>    a conclusion, back to raw source events
 *     npm run shadow -- reflect daily   run a pass now and print it
 *     npm run shadow -- rebuild         clear derived memory and think it again
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import { betterSqliteMemoryStore } from '../server/memory/store.ts'
import { recordedCycle, renderShadow } from '../server/memory/shadow.ts'
import { rebuild } from '../server/memory/reflect.ts'
import { cadenceFor } from '../server/memory/host.ts'
import { describePosture, SHADOW_ONLY } from '../server/memory/authority.ts'
import { partsIn } from '../server/clock.ts'
import * as inspect from '../server/memory/inspect.ts'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : argv[i + 1]
}
const args = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== `--db`)

const DB = flag('db') ?? join(homedir(), '.crucible', 'memory.db')
if (!existsSync(DB)) {
  console.error(`no memory database at ${DB}\n(the server creates it on the first sync; --db points elsewhere)`)
  process.exit(1)
}

const store = betterSqliteMemoryStore(new Database(DB))
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const opts = { timeZone: zone }

const [command = 'overview', target] = args

/**
 * One pass in one line: when, what kind, what moved, and — the column that is
 * the point — how many candidates it would have surfaced.
 */
const oneLine = (s) => {
  const moved = [
    s.entities.added.length && `+${s.entities.added.length}e`,
    s.episodes.opened.length && `+${s.episodes.opened.length}ep`,
    s.routines.emerging.length && `+${s.routines.emerging.length}rt`,
    s.hypotheses.length && `~${s.hypotheses.length}hy`,
    s.predictions.created.length && `+${s.predictions.created.length}pr`,
    s.predictions.resolved.length && `✓${s.predictions.resolved.length}pr`,
    s.anomalies.length && `!${s.anomalies.length}`,
  ]
    .filter(Boolean)
    .join(' ')
  const would = s.candidates.filter((c) => c.surfaced).length
  return `${s.startedAt}  ${s.kind.padEnd(7)} ${s.status.padEnd(6)} ${String(would || '·').padStart(2)} would surface   ${moved || 'nothing moved'}`
}

switch (command) {
  case 'overview': {
    console.log(inspect.overview(store))
    console.log(`\nposture: ${describePosture(SHADOW_ONLY)}`)
    const runs = store.shadow.recent(8)
    if (runs.length) {
      console.log('\nlast shadow runs:')
      for (const s of runs) console.log(`  ${oneLine(s)}`)
    } else {
      console.log('\nno shadow runs yet — `npm run shadow -- reflect daily` produces one')
    }
    break
  }

  case 'runs': {
    const runs = store.shadow.recent(Number(target) || 30)
    if (!runs.length) console.log('no shadow runs recorded')
    for (const s of runs) console.log(oneLine(s))
    break
  }

  case 'interesting': {
    const runs = store.shadow.withCandidates(Number(target) || 10)
    if (!runs.length) {
      console.log('no pass has produced a candidate that cleared the gate.')
      console.log('that is a valid result — see §66. `runs` shows what the passes did instead.')
    }
    for (const s of runs) console.log(`${renderShadow(s)}\n${'─'.repeat(78)}`)
    break
  }

  case 'run': {
    const s = !target || target === 'last' ? store.shadow.recent(1)[0] : store.shadow.byId(target)
    if (!s) {
      console.error(target && target !== 'last' ? `no shadow run ${target}` : 'no shadow runs recorded yet')
      process.exit(1)
    }
    console.log(renderShadow(s))
    break
  }

  /**
   * §37's other half, read from the outside: a conclusion walked back to the raw
   * source events under it. If this cannot print a chain, the conclusion should
   * not be on a screen.
   */
  case 'explain': {
    if (!target) {
      console.error('explain needs an id — take one from `run last`')
      process.exit(1)
    }
    console.log(inspect.explain(store, target))
    const events = inspect.evidenceEvents(store, target)
    console.log(`\nreaches ${events.length} raw source event(s)`)
    break
  }

  case 'entities':
    console.log(inspect.entities(store))
    break
  case 'routines':
    console.log(inspect.routines(store))
    break
  case 'hypotheses':
    console.log(inspect.hypotheses(store))
    break
  case 'predictions':
    console.log(inspect.predictions(store))
    break
  case 'recommendations':
    console.log(inspect.recommendations(store))
    break
  case 'dump':
    console.log(inspect.dump(store))
    break

  /**
   * RUN A PASS NOW. The cadence is derived from the clock exactly as the
   * scheduler's would be, unless one is named — so `reflect` with no argument
   * reproduces what the timer would have done at this moment rather than a
   * heavier pass that only ever happens by hand.
   */
  case 'reflect': {
    const now = new Date()
    const kind = target ?? cadenceFor(partsIn(now, zone))
    console.log(`running a ${kind} pass against ${DB}\n`)
    const { shadow } = recordedCycle(store, kind, now, opts)
    console.log(shadow ? renderShadow(shadow) : 'the pass ran but produced no shadow record')
    break
  }

  /**
   * §34's operation. Destroys every derived row and thinks the whole ledger
   * again, one day at a time.
   *
   * Says what survives, because the interesting property of a rebuild is not what
   * it deletes — it is that the ledger and everything he stated are untouched, and
   * somebody about to run this against months of real evidence should be able to
   * see that claim before they do rather than after.
   */
  case 'rebuild': {
    const events = store.events.count()
    console.log(`rebuilding derived memory from ${events} untouched source events.`)
    console.log('the ledger, his stated facts and the recommendation history survive.\n')
    const out = rebuild(store, opts)
    console.log(`${out.passes} passes replayed.`)
    console.log(inspect.overview(store))
    break
  }

  default:
    console.error(`unknown command "${command}"\nsee the comment at the top of scripts/shadow.mjs`)
    process.exit(1)
}

store.close?.()
