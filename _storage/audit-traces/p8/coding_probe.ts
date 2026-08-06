import { isCodingQuery, extractPackageCandidatesRanked } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
for (const q of [
  'parse a csv file with papaparse','make an http request with axios','lodash debounce example',
  'zod schema to validate an ipv4 address','express middleware for error handling',
]) console.log(`isCoding=${String(isCodingQuery(q)).padEnd(5)} cands=${JSON.stringify(extractPackageCandidatesRanked(q).map(c=>c.name+':'+c.confidence[0])).padEnd(46)} ${q}`)
