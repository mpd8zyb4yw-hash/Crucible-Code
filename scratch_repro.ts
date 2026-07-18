import { fmComplete } from './src/CrucibleEngine/agent/fmReact'
import { critiqueAnswer } from './src/CrucibleEngine/answer/verify'

const q = 'implement a token bucket rate limiter class in typescript'
const sys = 'You are Crucible.\n\nThink through this step by step. Show each calculation or logical step explicitly. Re-check any arithmetic. State the final answer clearly on its own line at the end, prefixed with "Answer:".'
const draft = (await fmComplete([{ role: 'system', content: sys }, { role: 'user', content: q }])).trim()
const { issues } = critiqueAnswer(draft, q)
console.log('DRAFT len:', draft.length)
console.log('ISSUES:', JSON.stringify(issues.map(i => ({ kind: i.kind, fixed: !!i.fixedText, detail: i.detail?.slice(0,80) }))))
