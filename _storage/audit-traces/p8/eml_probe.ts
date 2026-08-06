import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
async function main(){
  const d = await fetchLibraryApiForQuery('write a zod schema that validates an email address')
  const p = selectRelevantPassages(d!.text, 'write a zod schema that validates an email address', 1200)
  console.log('passage has email():', /\bemail\s*\(/.test(p), '| has z.email or .email:', /\.\s*email/.test(p))
  console.log(p.slice(0,400))
}
main()
