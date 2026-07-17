import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
const TASKS = [
  ['zod schema for a uuid string', 'uuid'],
  ['write a zod schema that validates an email address', 'email'],
  ['format a date as yyyy-mm-dd with date-fns', 'format'],
]
async function main(){
  for (const [q, want] of TASKS) {
    const d = await fetchLibraryApiForQuery(q)
    if (!d) { console.log(`${want.padEnd(7)} NO DOCS`); continue }
    const passage = selectRelevantPassages(d.text, q, 1200)
    const inFull = new RegExp(`\\b${want}\\b`,'i').test(d.text)
    const inPassage = new RegExp(`\\b${want}\\b`,'i').test(passage)
    console.log(`${want.padEnd(7)} pkg=${d.pkg.padEnd(9)} full_dts_has_${want}=${String(inFull).padEnd(5)} SELECTED_PASSAGE_has_${want}=${inPassage}`)
    if (!inPassage) console.log(`         ^ the answer's evidence does NOT contain the API it needs. passage starts: ${passage.slice(0,90).replace(/\n/g,' ')}`)
  }
}
main()
