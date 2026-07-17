import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
async function main(){
  const q='write a zod schema that validates an email address'
  const d=await fetchLibraryApiForQuery(q)
  console.log('FULL .d.ts has "z.email" or "email(":', /email\s*\(/.test(d!.text))
  // Where does the TOP-LEVEL email function appear vs the deprecated method note?
  const topLevel = d!.text.match(/.{40}(export )?(declare )?(function |const )?email[^\n]{0,60}/g) || []
  console.log('\n--- lines mentioning email in full dts ---')
  topLevel.slice(0,8).forEach(l=>console.log('  '+l.replace(/\n/g,' ')))
  console.log('\n--- SELECTED PASSAGE (what the model sees) ---')
  console.log(selectRelevantPassages(d!.text, q, 1200))
}
main()
